/** The city in PixiJS: one block per project (a building), its desks on one floor. Knows nothing about tabs, the API or React. */
import { Application, CanvasSource, Container, ImageSource, Rectangle, Texture, UPDATE_PRIORITY, type Graphics } from 'pixi.js';
import { BLOCK_MARGIN, blockBounds, cityBounds, floorOnCity, layoutCity, type CityLayout, type PlacedBlock } from '../layout/city';
import { depthOf, toScreen } from '../layout/iso';
import { sameFocus, type CityModel, type FocusTarget } from '../model';
import { ART_URLS } from '../pack/art';
import { generatedPack } from '../pack/generated';
import type { PackManifest } from '../pack/manifest';
import { Camera, sameBox, type Box } from './camera';
import { deskLabelsVisible } from './detail';
import { FrameListeners } from './frames';
import { BuildingSign, DeskOverlay } from './Overlay';
import { DeskView, type Textures } from './PersonView';
import { RoomLamp } from './RoomLamp';
import { RoomRacks } from './RoomRacks';
import { drawBlock, drawFloor, WALL_H } from './RoomView';
import { shapeOf } from './shape';
import { RoomWallPlaque } from './wallPlaque';

/** Room above a block's walls, so framing a block does not cut its top off. */
const SIGN_H = 24;

/** Headroom a block (or the whole city) needs above its ground, for its walls. */
const BLOCK_TOP = WALL_H + SIGN_H;

/** And under it, for the building sign that hangs over the block's front corner. */
const BLOCK_BOTTOM = SIGN_H + 32;

/** What is left of an unlit building's furniture and people. Its markers keep their full strength. */
const UNLIT_ALPHA = 0.45;

/** One building as drawn, so a light going out can repaint it where it stands. */
interface DrawnBuilding {
  block: PlacedBlock;
  ground: Graphics;
  floor: Graphics;
  lit: boolean;
  sign: BuildingSign;
  /** the project's name, framed on the back wall */
  plaque: RoomWallPlaque;
  /** the name the plaque shows, so a tick that changed nothing does not repaint it */
  label: string;
  /** wall lamp: on = warm wash, off = the same fixture, dark */
  lamp: RoomLamp;
  /** shelves, cabinets and the server rack against the back walls */
  racks: RoomRacks;
  /** every desk of this building, so its light going out dims them all without a rebuild */
  views: DeskView[];
}

export interface SceneHandlers {
  onPickDesk(deskId: string, projectId: string): void;
  /** the block's ground or floor: frame that building */
  onPickBuilding(projectId: string): void;
  onPickSign(projectId: string): void;
  /** the person zoomed out far enough that the current rest no longer describes the view */
  onGoUp(): void;
}

export class OfficeScene {
  private app: Application | null = null;
  private mounting = false;
  private camera: Camera | null = null;
  private readonly world = new Container();
  private readonly floor = new Container();
  private readonly things = new Container();
  private readonly overlay = new Container();
  private textures: Textures = {};
  /** pixel-art sheets from `pack/art`, loaded beside the generated atlas */
  private art: Record<string, Texture> = {};
  /** the pack's atlas: ours to free, since nothing else knows about it */
  private source: CanvasSource | null = null;
  private manifest: PackManifest | null = null;
  private city: CityLayout = layoutCity([]);
  private shape = '';
  private model: CityModel | null = null;
  /** keyed `buildingId:deskId`: two buildings could carry desks with the same id without colliding */
  private desks = new Map<string, { id: string; view: DeskView; overlay: DeskOverlay; buildingId: string }>();
  private buildings = new Map<string, DrawnBuilding>();
  private target: FocusTarget = { kind: 'city' };
  /** the scale the camera framed the current target at: zooming well below it means "go up" */
  private framedScale = 1;
  /** the person has panned or zoomed since the camera last framed something by itself */
  private userMoved = false;
  /** onGoUp already fired for this framing — one wheel gesture is many events */
  private wentUp = false;
  private destroyed = false;
  private readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  frameMs = 0;
  /** called right after every render to the screen with the canvas just drawn (see frames.ts) */
  private readonly frameListeners = new FrameListeners();
  /** while a video is recorded: no wheel, no drag, no re-framing */
  private cameraLocked = false;
  /** a framing asked for while the camera was locked, applied once it unlocks */
  private framingDeferred = false;

  constructor(private readonly handlers: SceneHandlers) {
    this.things.sortableChildren = true;
    // desk overlays over signs: a sign must never hide a marker of the building in front of it
    this.overlay.sortableChildren = true;
    this.world.addChild(this.floor, this.things);
  }

  /** Async because Pixi v8 picks its renderer asynchronously; safe against an unmount in between. */
  async mount(host: HTMLElement): Promise<void> {
    if (this.app || this.mounting || this.destroyed) return;
    this.mounting = true;
    const app = new Application();
    // the art sheets download and decode while Pixi picks its renderer, not after it
    const art = this.loadArt();
    try {
      await app.init({ resizeTo: host, background: 0x0f1115, antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    } catch (err) {
      // neither WebGL nor canvas started: free the half-built app and let the page show its message,
      // leaving the scene mountable again (a stuck `mounting` would refuse every later attempt)
      this.mounting = false;
      app.destroy(true, { children: true });
      throw err;
    }
    await art;
    this.mounting = false;
    // unmounted meanwhile: destroy() found no app to free (it is only published below) and
    // loadArt() added no sheet behind it, so this app is all that is left
    if (this.destroyed) return app.destroy(true, { children: true });
    this.app = app;
    host.appendChild(app.canvas);
    const pack = generatedPack();
    this.manifest = pack.manifest;
    // built by hand rather than with Texture.from, which would leave the atlas in the global cache
    this.source = new CanvasSource({ resource: pack.canvas, scaleMode: 'nearest' });
    for (const [key, def] of Object.entries(pack.manifest.sprites)) {
      this.textures[key] = def.frames.map((f) => new Texture({ source: this.source!, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }
    app.stage.addChild(this.world, this.overlay);
    this.camera = new Camera(app.canvas);
    this.camera.locked = this.cameraLocked;
    this.camera.onUserMove = () => {
      this.userMoved = true;
      if (this.wentUp || this.target.kind === 'city' || !this.camera) return;
      if (this.camera.target.scale < this.framedScale * 0.6) {
        this.wentUp = true;
        this.handlers.onGoUp();
      }
    };
    // brackets our update and Pixi's render (priority LOW) to get the CPU cost of one frame
    let t0 = 0;
    app.ticker.add(() => (t0 = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(() => this.tick());
    app.ticker.add(() => (this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1), undefined, UPDATE_PRIORITY.UTILITY);
    // Pixi's post-render runner fires inside render(), right after the draw calls — the frame is
    // still in the WebGL drawing buffer, so a 2D canvas can copy it (share images, the video)
    // only a render to the screen: a future render into a texture would hand out a stale canvas
    const postrender = {
      postrender: (options?: { target?: unknown }) => this.frameListeners.emit(app.canvas, options?.target === app.renderer.view.renderTarget),
    };
    app.renderer.runners.postrender.add(postrender);
    const onVisibility = () => (document.hidden ? app.ticker.stop() : app.ticker.start());
    // a resized canvas leaves the framing stale; re-frame unless the person put the camera there
    const onResize = () => {
      if (this.target.kind !== 'city' || !this.userMoved) this.frameTarget(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    app.renderer.on('resize', onResize);
    // Pixi's `resizeTo` only listens to the WINDOW's resize; the host also changes size with no
    // window resize at all — focus mode hides the sidebar, the sidebar collapses — so watch the element.
    const observer = new ResizeObserver(() => app.resize());
    observer.observe(host);
    this.cleanup = () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      app.renderer.off('resize', onResize);
      app.renderer.runners.postrender.remove(postrender);
    };
    if (this.model) this.rebuild(this.model, true);
  }

  private cleanup: () => void = () => {};

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    this.camera?.destroy();
    this.camera = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
    for (const frames of Object.values(this.textures)) for (const texture of frames) texture.destroy();
    this.textures = {};
    for (const texture of Object.values(this.art)) texture.destroy(true);
    this.art = {};
    this.source?.destroy();
    this.source = null;
  }

  /**
   * Loads the PNGs of `pack/art` as nearest-neighbour textures. A sheet that fails to decode is left
   * out, and whatever needs it falls back (a desk to the generated pack, a piece of furniture to nothing).
   * A sheet already loaded (a mount retried after a failed init) is kept rather than replaced.
   */
  private async loadArt(): Promise<void> {
    await Promise.all(
      Object.entries(ART_URLS).map(async ([key, url]) => {
        if (this.art[key]) return;
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch {
          return;
        }
        // unmounted while it decoded: destroy() has freed the sheets it found, so add none behind it
        if (this.destroyed) return;
        this.art[key] = new Texture({ source: new ImageSource({ resource: img, scaleMode: 'nearest' }) });
      }),
    );
  }

  get fps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  get rendererName(): string {
    return this.app?.renderer.name ?? '—';
  }

  /** Subscribes to every rendered frame (see `frameListeners`); returns the unsubscribe. */
  onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void {
    return this.frameListeners.add(cb);
  }

  /**
   * Freezes the framing for a recording: wheel and drag are ignored, and a re-framing (a resize, a
   * new target from a tap or Back) waits until the lock is released, which applies it once.
   */
  lockCamera(locked: boolean): void {
    this.cameraLocked = locked;
    if (this.camera) this.camera.locked = locked;
    if (!locked && this.framingDeferred) {
      this.framingDeferred = false;
      this.frameTarget(false);
    }
  }

  /** Same buildings and desks (ids, kinds, order) → only properties change; otherwise the city is rebuilt. */
  setModel(model: CityModel): void {
    const shape = shapeOf(model);
    this.model = model;
    if (!this.app) return;
    if (shape !== this.shape) return this.rebuild(model, this.shape === '');
    for (const building of model.buildings) {
      const drawn = this.buildings.get(building.id);
      if (!drawn) continue;
      // a building going dark is not a new city: repaint it and dim its desks where they stand
      const relit = drawn.lit !== building.lit;
      if (relit) {
        drawn.lit = building.lit;
        drawBlock(drawn.block, building.lit, drawn.ground);
        drawFloor(floorOnCity(drawn.block), building.lit, drawn.floor);
        for (const view of drawn.views) view.root.alpha = building.lit ? 1 : UNLIT_ALPHA;
        drawn.lamp.apply(building.lit);
        drawn.racks.apply(building.lit);
      }
      drawn.sign.apply(building);
      // repainting the plaque rebuilds its frame and re-measures its text: only when it would look different
      if (relit || drawn.label !== building.label) {
        drawn.label = building.label;
        drawn.plaque.apply(floorOnCity(drawn.block), { label: building.label, lit: building.lit });
      }
      for (const d of building.desks) {
        const desk = this.desks.get(deskKey(building.id, d.id));
        desk?.view.apply(d);
        desk?.overlay.apply(d);
      }
    }
  }

  /** Dev/test aid: forces one desk's hovered state (`null` clears it), so a screenshot can show it. */
  debugHover(deskId: string | null): void {
    for (const desk of this.desks.values()) desk.overlay.hovered = desk.id === deskId;
  }

  /**
   * Frames the city or one building's block. The page replays the URL's target on every
   * navigation, so an equal target is a no-op: re-framing would undo a camera the person moved.
   */
  focus(target: FocusTarget, snap = false): void {
    if (this.destroyed || sameFocus(target, this.target)) return;
    this.target = target;
    this.frameTarget(snap);
  }

  /** No camera yet (focused before `mount()` resolved): the target is stored and the rebuild frames it. */
  private frameTarget(snap: boolean): void {
    if (!this.camera) return;
    if (this.cameraLocked) {
      this.framingDeferred = true;
      return;
    }
    this.camera.frameBox(this.boxOf(this.target), snap);
    this.framedScale = this.camera.target.scale;
    this.userMoved = false;
    this.wentUp = false;
  }

  private boxOf(target: FocusTarget): Box {
    // the building signs hang under their blocks, so a framed box reaches past the last block's ground
    const withSign = (b: Box): Box => ({ ...b, h: b.h + BLOCK_BOTTOM });
    const block = target.kind === 'building' ? this.city.blocks.find((b) => b.id === target.projectId) : undefined;
    return withSign(block ? blockBounds(block, BLOCK_TOP) : cityBounds(this.city, BLOCK_TOP));
  }

  /** Whether the current model still has what the target names. */
  private exists(target: FocusTarget): boolean {
    return target.kind === 'city' || !!this.model?.buildings.some((b) => b.id === target.projectId);
  }

  /**
   * `first`: the very first city, which is framed and snapped to. A later rebuild (a tab opened
   * anywhere in the account) re-frames the building the person is in only when its box actually
   * moved — the shelf packing moves later blocks, but a tab opened in ANOTHER building leaves this
   * one exactly where it was, and re-framing there would yank a camera zoomed onto one desk. On the
   * city as a whole it only re-centres while nobody has moved the camera by hand.
   */
  private rebuild(model: CityModel, first: boolean): void {
    if (!this.manifest) return;
    // read against the layout that is about to be replaced, so the two can be compared below
    const before = first ? null : this.boxOf(this.target);
    this.shape = shapeOf(model);
    this.city = layoutCity(model.buildings.map((b) => ({ id: b.id, desks: b.desks.length })));
    for (const layer of [this.floor, this.things, this.overlay]) layer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.desks.clear();
    this.buildings.clear();
    model.buildings.forEach((building, bi) => {
      const block = this.city.blocks[bi];
      const pick = () => this.clicked(() => this.handlers.onPickBuilding(building.id));
      // the block's ground goes down before its floor, which paints over it: both pick the building
      const ground = drawBlock(block, building.lit);
      ground.on('pointertap', pick);
      this.floor.addChild(ground);
      const placed = floorOnCity(block);
      const floor = drawFloor(placed, building.lit);
      floor.on('pointertap', pick);
      this.floor.addChild(floor);
      // over the block's FRONT corner, not its back one: markers all point up out of their desks,
      // so the ground down there is the one part of a block nothing of its own reaches into
      const front = toScreen(block.origin.gx + block.width + BLOCK_MARGIN, block.origin.gy + block.height + BLOCK_MARGIN);
      const sign = new BuildingSign(front, building);
      sign.root.on('pointertap', () => this.clicked(() => this.handlers.onPickSign(building.id)));
      this.overlay.addChild(sign.root);
      // the lamp goes down with the walls, under everything in `things`: its wash lands on the wall
      // and floor behind the furniture and the desks, never over them
      const lamp = new RoomLamp(placed, building.lit);
      this.floor.addChild(lamp.root);
      const plaque = new RoomWallPlaque(placed, { label: building.label, lit: building.lit });
      const racks = new RoomRacks(building.id, placed, building.desks.length, this.art, building.lit);
      this.things.addChild(plaque.root, ...racks.sprites);
      const drawn: DrawnBuilding = { block, ground, floor, lit: building.lit, sign, plaque, label: building.label, lamp, racks, views: [] };
      this.buildings.set(building.id, drawn);
      building.desks.forEach((d, j) => {
        const cell = { gx: placed.origin.gx + placed.layout.desks[j].gx, gy: placed.origin.gy + placed.layout.desks[j].gy };
        const at = toScreen(cell.gx, cell.gy);
        const view = new DeskView(d, this.textures, this.manifest!, this.reducedMotion, this.art);
        view.root.position.set(at.x, at.y);
        view.root.zIndex = depthOf(cell);
        // an unlit building's furniture and people fade; their markers, in the overlay, do not
        view.root.alpha = building.lit ? 1 : UNLIT_ALPHA;
        drawn.views.push(view);
        const overlay = new DeskOverlay({ x: at.x + view.head.x, y: at.y + view.head.y }, d);
        overlay.root.zIndex = 1;
        view.root.on('pointertap', () => this.clicked(() => this.handlers.onPickDesk(view.model.id, view.model.projectId)));
        view.root.on('pointerover', () => (overlay.hovered = true));
        view.root.on('pointerout', () => (overlay.hovered = false));
        this.things.addChild(view.root);
        this.overlay.addChild(overlay.root);
        this.desks.set(deskKey(building.id, d.id), { id: d.id, view, overlay, buildingId: building.id });
      });
    });
    // a target whose building is gone falls back to the city, but the camera stays put
    if (!this.exists(this.target)) {
      this.target = { kind: 'city' };
      if (!first) return;
    }
    if (first) return this.frameTarget(true);
    // when the box is unchanged nothing is framed at all, so `userMoved` and `wentUp` keep whatever
    // the person's own wheel and drag put there
    const reframe = this.target.kind === 'city' ? !this.userMoved : before !== null && !sameBox(before, this.boxOf(this.target));
    if (reframe) this.frameTarget(false);
  }

  /** A press that dragged the camera is not a click. */
  private clicked(fn: () => void): void {
    if ((this.camera?.dragged ?? 0) < 5) fn();
  }

  private tick(): void {
    if (!this.camera || !this.app) return;
    const screen = this.app.screen;
    const view = this.camera.tick();
    this.world.scale.set(view.scale);
    this.world.position.set(view.x, view.y);
    const t = performance.now() / 1000;
    for (const { view: desk, overlay, buildingId } of this.desks.values()) {
      desk.update();
      overlay.place(view, deskLabelsVisible(this.target, view.scale, buildingId), t, this.reducedMotion);
    }
    // `place` turns a sign off again when its anchor has left the viewport
    for (const drawn of this.buildings.values()) drawn.sign.place(view, screen);
  }
}

const deskKey = (buildingId: string, deskId: string) => `${buildingId}:${deskId}`;
