/** One desk: pixel-art station (desk → display → agent on top), or the generated pack as fallback. */
import { AnimatedSprite, Container, Sprite, type Texture } from 'pixi.js';
import { toScreen } from '../layout/iso';
import type { DeskModel, Pose } from '../model';
import { DESK_ART_SIZE, STATION_ANCHOR, deskArtKeys } from '../pack/art';
import type { Anim, PackManifest } from '../pack/manifest';

export type Textures = Record<string, Texture[]>;
export type ArtTextures = Record<string, Texture>;

const SHIRT: Record<string, number> = {
  working: 0x3fb950,
  waiting_input: 0xd29922,
  waiting_permission: 0xf0883e,
  idle: 0x7d8799,
  error: 0xf85149,
  none: 0x475569,
};
const SEAT = { u: 0.5, v: 0.78 };

function packSprite(textures: Textures, manifest: PackManifest, key: string): AnimatedSprite {
  const def = manifest.sprites[key];
  const s = new AnimatedSprite(textures[key]);
  s.anchor.set(def.anchor.x / def.frames[0].w, def.anchor.y / def.frames[0].h);
  s.animationSpeed = def.fps / 60;
  if (def.fps > 0) s.play();
  return s;
}

/** Same transform for every station layer — one canvas, one place. */
function stationSprite(art: ArtTextures, key: string): Sprite {
  const s = new Sprite(art[key]);
  s.anchor.set(STATION_ANCHOR.x, STATION_ANCHOR.y);
  const scale = DESK_ART_SIZE / Math.max(s.texture.width, 1);
  s.scale.set(scale, scale);
  return s;
}

/** Agent sprite only when a person is at the desk (not phone, not empty). */
export function deskShowsAgent(model: DeskModel): boolean {
  return model.kind === 'person' && model.pose !== 'empty';
}

export class DeskView {
  readonly root = new Container();
  /** world-space point of the person's head, relative to `root` */
  readonly head: { x: number; y: number };
  model: DeskModel;
  private monitor: { on: Sprite; off: Sprite } | null = null;
  private phone: { on: Sprite; off: Sprite } | null = null;
  private readonly person = new Container();
  private chairArt: Sprite | null = null;
  private agentArt: Sprite | null = null;
  private deskArt: Sprite | null = null;
  /** Empty-seat desk (side-h); swapped with `deskArt` when no agent. */
  private emptyDeskArt: Sprite | null = null;
  private displayArt: Sprite | null = null;
  private readonly useArt: boolean;
  private pose: Pose | null = null;
  private fade = 1;

  constructor(
    model: DeskModel,
    private readonly textures: Textures,
    private readonly manifest: PackManifest,
    private readonly reducedMotion: boolean,
    art: ArtTextures = {},
  ) {
    this.model = model;
    this.useArt = !!art['desk/side-v-2'] && !!art['desk/side-h'];
    if (this.useArt) {
      this.head = this.buildArtStation(art);
    } else {
      this.buildPackFurniture(model);
      const seat = toScreen(SEAT.u, SEAT.v);
      this.person.position.set(seat.x, seat.y);
      this.root.addChild(this.person);
      this.head = { x: seat.x + manifest.head.x, y: seat.y + manifest.head.y };
    }
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.apply(model);
  }

  /**
   * Occupied: desk-v-2 → display → agent on top.
   * Empty: desk-h → chair-h on top. All layers share one transform.
   */
  private buildArtStation(art: ArtTextures): { x: number; y: number } {
    this.root.sortableChildren = true;
    const occupied = deskArtKeys(true);
    const empty = deskArtKeys(false);

    if (art[empty.desk]) {
      this.emptyDeskArt = stationSprite(art, empty.desk);
      this.emptyDeskArt.zIndex = 0;
      this.root.addChild(this.emptyDeskArt);
    }
    this.deskArt = stationSprite(art, occupied.desk);
    this.deskArt.zIndex = 1;
    this.root.addChild(this.deskArt);
    if (occupied.display && art[occupied.display]) {
      this.displayArt = stationSprite(art, occupied.display);
      this.displayArt.zIndex = 2;
      this.root.addChild(this.displayArt);
    }
    if (empty.chair && art[empty.chair]) {
      this.chairArt = stationSprite(art, empty.chair);
      this.chairArt.zIndex = 3;
      this.root.addChild(this.chairArt);
    }
    if (occupied.agent && art[occupied.agent]) {
      this.agentArt = stationSprite(art, occupied.agent);
      this.agentArt.zIndex = 4;
      this.agentArt.visible = false;
      this.root.addChild(this.agentArt);
    }
    return { x: 0, y: -DESK_ART_SIZE * 0.4 };
  }

  private buildPackFurniture(model: DeskModel): void {
    this.root.addChild(packSprite(this.textures, this.manifest, 'desk'));
    if (model.kind === 'phone') {
      this.phone = { on: packSprite(this.textures, this.manifest, 'phone/on'), off: packSprite(this.textures, this.manifest, 'phone/off') };
      this.root.addChild(this.phone.off, this.phone.on);
      return;
    }
    this.monitor = {
      on: packSprite(this.textures, this.manifest, 'monitor/on'),
      off: packSprite(this.textures, this.manifest, 'monitor/off'),
    };
    this.root.addChild(this.monitor.off, this.monitor.on, packSprite(this.textures, this.manifest, 'chair'));
  }

  apply(model: DeskModel): void {
    this.model = model;
    if (this.useArt) {
      this.applyArt(model);
      return;
    }
    if (this.monitor) this.monitor.on.visible = model.screenOn;
    if (this.phone) this.phone.on.visible = model.screenOn;
    if (model.pose === this.pose && this.person.children.length) {
      this.tintShirt();
      return;
    }
    this.pose = model.pose;
    this.person.removeChildren().forEach((c) => c.destroy());
    if (model.kind === 'phone' || model.pose === 'empty') return;
    this.spawnPackPerson(model);
  }

  private applyArt(model: DeskModel): void {
    const show = deskShowsAgent(model);
    if (this.agentArt) {
      this.agentArt.visible = show;
      this.agentArt.alpha = model.dimmed ? 0.55 : 1;
    }
    // the desk sheet has its monitors off; the display sheet lights them, so it follows the screen
    if (this.displayArt) {
      this.displayArt.visible = show && model.screenOn;
      this.displayArt.alpha = model.dimmed ? 0.55 : 1;
    }
    if (this.deskArt) {
      this.deskArt.visible = show;
      this.deskArt.alpha = model.dimmed ? 0.55 : 1;
    }
    if (this.emptyDeskArt) {
      this.emptyDeskArt.visible = !show;
      this.emptyDeskArt.alpha = model.dimmed ? 0.7 : 1;
    }
    if (this.chairArt) {
      this.chairArt.visible = !show;
      this.chairArt.alpha = model.dimmed ? 0.7 : 1;
    }
    this.pose = model.pose;
  }

  private spawnPackPerson(model: DeskModel): void {
    const anim = model.pose as Anim;
    const body = packSprite(this.textures, this.manifest, `person/${anim}/body`);
    const shirt = packSprite(this.textures, this.manifest, `person/${anim}/shirt`);
    const hair = packSprite(this.textures, this.manifest, 'person/hair');
    body.tint = this.manifest.skin[model.look];
    hair.tint = this.manifest.hair[model.look];
    if (this.reducedMotion) [body, shirt].forEach((s) => s.gotoAndStop(0));
    this.person.addChild(body, shirt, hair);
    this.fade = 0;
    this.tintShirt();
  }

  private tintShirt(): void {
    const shirt = this.person.children[1] as Sprite | undefined;
    if (shirt) shirt.tint = SHIRT[this.model.state ?? 'none'];
    this.person.alpha = (this.model.dimmed ? 0.55 : 1) * this.fade;
  }

  update(): void {
    if (this.useArt || this.fade >= 1) return;
    this.fade = Math.min(1, this.fade + 1 / 9);
    this.person.alpha = (this.model.dimmed ? 0.55 : 1) * this.fade;
  }
}
