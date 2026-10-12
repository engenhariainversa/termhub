/** One desk: pixel-art station (desk → display → agent on top), or the generated pack as fallback. */
import { AnimatedSprite, Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { toScreen } from '../layout/iso';
import type { DeskModel, Pose } from '../model';
import { DESK_ART_SIZE, STATION_ANCHOR, deskArtKeys } from '../pack/art';
import type { Anim, PackManifest } from '../pack/manifest';
import { deskLook, type AvatarMotion, type DeskLook } from './deskLook';
import { DeskScreens, paintScreens, paintZs, SCREEN_FPS } from './DeskScreens';
import { paintRobot, ROBOT_HEAD, robotPose } from './Robot';

export type Textures = Record<string, Texture[]>;
export type ArtTextures = Record<string, Texture>;

const SHIRT: Record<string, number> = {
  working: 0x3fb950,
  waiting_input: 0xd29922,
  waiting_permission: 0xf0883e,
  idle: 0x7d8799,
  error: 0xf85149,
  waiting_background: 0x58a6ff,
  finished: 0x3fb950,
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

/** Where the "z z z" of a dozing person rise from, in desk-sheet pixels: over the head. */
const HUMAN_HEAD = { x: 312, y: 128 };
/** Frames the human/robot swap takes: a crossfade of about a third of a second. */
const SWAP_STEPS = 20;

/** The person's sprite transform for one moment of a motion: offsets in station pixels, a lean in radians. */
export interface HumanPose {
  x: number;
  y: number;
  rotation: number;
}

/**
 * How the person (one still sprite, chair included) moves: the sprite is pivoted at the chair's foot,
 * so a positive rotation leans them back. `f`: the 10 fps frame; `entered`: seconds in this motion.
 */
export function humanPose(motion: AvatarMotion, f: number, entered: number): HumanPose {
  switch (motion) {
    case 'type':
      // a small bob with each burst of keys
      return { x: 0, y: Math.floor(f / 2) % 2 ? -0.6 : 0, rotation: 0 };
    case 'play':
      // leaning back with the game, thumbs mashing
      return { x: f % 2 ? 0.3 : 0, y: 0, rotation: 0.04 };
    case 'shake':
      return { x: f % 20 < 6 ? (f % 2 ? 0.8 : -0.8) : 0, y: 0, rotation: 0 };
    case 'doze':
      // slumped back, breathing slowly
      return { x: 0, y: Math.sin((f / SCREEN_FPS) * 1.6) * 0.4, rotation: 0.03 };
    case 'relax':
      // a little hop on finishing, then a stretch back in the chair
      return { x: 0, y: entered < 1.2 ? -Math.abs(Math.sin(entered * Math.PI * 2.5)) * 1.5 * (1 - entered / 1.2) : 0, rotation: 0.05 };
    case 'watch':
      // swaying slowly, eyes on the clock
      return { x: 0, y: 0, rotation: Math.sin((f / SCREEN_FPS) * 1.2) * 0.02 };
    case 'still':
      return { x: 0, y: 0, rotation: 0 };
  }
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
  /** the monitors' animation, in desk-sheet pixels like `robotLayer` (TER-1048) */
  private screens: DeskScreens | null = null;
  /** the robot of an automatic run and the empty chair it sits in, faded against `agentArt` */
  private robotLayer: Container | null = null;
  private readonly robot = new Graphics();
  private readonly zs = new Graphics();
  private look: DeskLook | null = null;
  /** 0 = the person, 1 = the robot; eased towards the desk's avatar */
  private robotMix = 0;
  private frame = -1;
  private dirty = true;
  /** when (scene seconds) the current motion and "terminou" began; null = not yet seen by `update` */
  private motionAt: number | null = null;
  private doneAt: number | null = null;
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
    // drawn in the sheet's own pixels, under the same transform as every sheet of the station
    const sheet = (zIndex: number) => {
      const layer = new Container();
      const width = Math.max(art[occupied.desk].width, 1);
      const scale = DESK_ART_SIZE / width;
      layer.scale.set(scale, scale);
      layer.position.set(-STATION_ANCHOR.x * width * scale, -STATION_ANCHOR.y * art[occupied.desk].height * scale);
      layer.zIndex = zIndex;
      this.root.addChild(layer);
      return layer;
    };
    this.screens = new DeskScreens();
    sheet(2).addChild(this.screens.root);
    if (occupied.robotChair && art[occupied.robotChair]) {
      this.robotLayer = sheet(4);
      this.robotLayer.addChild(this.robot, new Sprite(art[occupied.robotChair]));
      this.robotLayer.visible = false;
    }
    sheet(5).addChild(this.zs);
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
    if (this.screens) this.screens.root.alpha = model.dimmed ? 0.55 : 1;
    const look = deskLook(model);
    if (!this.look || look.screen !== this.look.screen || look.motion !== this.look.motion || look.attention !== this.look.attention || look.bolt !== this.look.bolt || look.avatar !== this.look.avatar) {
      if (look.motion !== this.look?.motion) this.motionAt = null;
      if (look.screen !== 'done') this.doneAt = null;
      this.dirty = true;
    }
    // the first look is not a swap: an automatic run already at work is a robot from the start
    if (!this.look && look.avatar === 'robot') this.robotMix = 1;
    this.look = look;
    this.mixAvatar();
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

  /** The person and the robot crossfade (`robotMix`); with no robot art the person stays. */
  private mixAvatar(): void {
    const show = deskShowsAgent(this.model);
    const base = this.model.dimmed ? 0.55 : 1;
    const mix = this.robotLayer ? this.robotMix : 0;
    if (this.agentArt) {
      this.agentArt.visible = show && mix < 1;
      this.agentArt.alpha = base * (1 - mix);
    }
    if (this.robotLayer) {
      this.robotLayer.visible = show && mix > 0;
      this.robotLayer.alpha = base * mix;
    }
  }

  /**
   * One tick. `t`: scene seconds; `animate`: the desk is big enough on screen for its animation to
   * be seen — otherwise its screens and avatar hold their last frame and nothing is redrawn.
   */
  update(t: number, animate: boolean): void {
    if (!this.useArt) {
      if (this.fade >= 1) return;
      this.fade = Math.min(1, this.fade + 1 / 9);
      this.person.alpha = (this.model.dimmed ? 0.55 : 1) * this.fade;
      return;
    }
    const look = this.look;
    if (!look) return;
    const target = look.avatar === 'robot' ? 1 : 0;
    if (this.robotMix !== target) {
      this.robotMix = this.reducedMotion ? target : target > this.robotMix ? Math.min(1, this.robotMix + 1 / SWAP_STEPS) : Math.max(0, this.robotMix - 1 / SWAP_STEPS);
      this.mixAvatar();
    }
    this.motionAt ??= t;
    if (look.screen === 'done') this.doneAt ??= t;
    const frame = this.reducedMotion ? 0 : Math.floor(t * SCREEN_FPS);
    if (!this.dirty && (!animate || frame === this.frame)) return;
    this.dirty = false;
    this.frame = frame;
    const sinceDone = this.doneAt === null ? 0 : t - this.doneAt;
    if (this.screens) paintScreens(this.screens.left, this.screens.right, look, frame, this.reducedMotion ? 0 : sinceDone, this.reducedMotion);
    const pose = this.reducedMotion ? { x: 0, y: 0, rotation: 0 } : humanPose(look.motion, frame, t - this.motionAt);
    if (this.agentArt) {
      this.agentArt.position.set(pose.x, pose.y);
      this.agentArt.rotation = pose.rotation;
    }
    if (this.robotLayer) paintRobot(this.robot, robotPose(look.motion, frame, look.attention, this.reducedMotion));
    const dozing = look.motion === 'doze' && look.avatar !== null && !this.reducedMotion;
    this.zs.visible = dozing;
    if (dozing) paintZs(this.zs, frame, look.avatar === 'robot' ? ROBOT_HEAD : HUMAN_HEAD);
  }
}
