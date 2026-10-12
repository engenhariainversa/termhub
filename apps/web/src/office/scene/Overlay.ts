/**
 * Everything that must stay readable: desk labels, markers, progress bars and building signs. These
 * live outside `world`, so furniture never covers them and they keep a fixed screen size;
 * `place()` puts each one back over its world point every frame.
 */
import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import { deskMachineLine, truncateLabel, workingLabel, type BuildingModel, type DeskModel, type Marker } from '../model';
import type { View } from './camera';
import { deskStatusText } from './deskLook';
import { buildingSignText, SIGN_SCALE } from './detail';

/** Hover is where a name cut to 18 characters and a task title become readable: room for both. */
const HOVER_MAX = 48;
/** A shade dimmer than the name colour: the activity label, the machine line and every sign's detail line. */
const MUTED = 0x9aa1b1;
const ATTENTION = 0xf0883e;

const MARKER: Record<Exclude<Marker, null>, { color: number; glyph: string }> = {
  input: { color: 0xd29922, glyph: '!' },
  permission: { color: 0xf0883e, glyph: '!' },
  error: { color: 0xf85149, glyph: '×' },
};

/**
 * Overlay text is read over furniture and people. It carries its own outline instead of a plate,
 * because anything opaque up here would hide the floor behind it. `outline` is the colour it is
 * read against: the background for a label, the disc itself for a marker's glyph.
 */
const text = (size: number, fill: number, weight: '400' | '700' = '400', outline = 0x0f1115): TextStyleOptions => ({
  fontSize: size,
  fill,
  fontWeight: weight,
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  stroke: { color: outline, width: 3, join: 'round' },
});

/** Screen-space pieces of one desk. `world` is the desk's head point in world coordinates. */
export class DeskOverlay {
  readonly root = new Container();
  private readonly label: Text;
  /** the machine the desk runs on (office only, city-by-project §3.2): muted, under the name */
  private readonly machine: Text;
  /** the bound task's title, hover only: a task without subtasks has no bar, so this is all it gets */
  private readonly title: Text;
  /** hover only: the state, and for an automatic run its card — "Automático — trabalhando — TER-123" (TER-1048) */
  private readonly status: Text;
  private readonly marker = new Container();
  private readonly bar = new Graphics();
  private readonly barText: Text;
  private markerKind: Marker = null;
  private short = '';
  private full = '';
  /** the desk shows an activity label instead of its name right now: dims it, unless hovered */
  private showingActivity = false;
  private pulse = 0;
  hovered = false;

  constructor(
    readonly world: { x: number; y: number },
    model: DeskModel,
  ) {
    this.label = new Text({ text: model.label, style: text(11, 0xe6e8ee) });
    this.label.anchor.set(0.5, 0);
    this.machine = new Text({ text: '', style: text(10, MUTED) });
    this.machine.anchor.set(0.5, 0);
    this.title = new Text({ text: '', style: text(10, MUTED) });
    this.title.anchor.set(0.5, 0);
    this.status = new Text({ text: '', style: text(10, MUTED) });
    this.status.anchor.set(0.5, 0);
    this.barText = new Text({ text: '', style: text(10, 0xe6e8ee) });
    this.barText.anchor.set(0, 0.5);
    this.root.addChild(this.bar, this.barText, this.label, this.machine, this.status, this.title, this.marker);
    this.apply(model);
  }

  apply(model: DeskModel): void {
    const activity = model.pose === 'type' && workingLabel(model.activity, model.verb);
    this.short = activity || model.label;
    this.showingActivity = !!activity;
    this.full = truncateLabel(model.name, HOVER_MAX);
    this.machine.text = deskMachineLine(model.machine);
    this.title.text = model.progress ? truncateLabel(model.progress.title, HOVER_MAX) : '';
    this.status.text = deskStatusText(model);
    this.label.text = this.hovered ? this.full : this.short;
    if (model.marker !== this.markerKind) {
      const entering = model.marker && model.marker !== 'error' && !this.markerKind;
      this.markerKind = model.marker;
      this.marker.removeChildren().forEach((c) => c.destroy());
      if (model.marker) {
        const m = MARKER[model.marker];
        const glyph = new Text({ text: m.glyph, style: text(14, 0x0f1115, '700', m.color) });
        glyph.anchor.set(0.5);
        this.marker.addChild(new Graphics().circle(0, 0, 10).fill(m.color).stroke({ color: 0x0f1115, width: 2 }), glyph);
      }
      if (entering) this.pulse = 1;
    }
    this.bar.clear();
    const p = model.progress;
    this.barText.text = p && p.total > 0 ? `${p.done}/${p.total}` : '';
    if (p && p.total > 0) {
      const done = p.done >= p.total;
      // the track needs its own outline: filled with a background colour it vanishes into the floor
      this.bar.roundRect(-20, -5, 40, 5, 2).fill(0x1e222b).stroke({ color: 0x4b5468, width: 1 });
      this.bar.roundRect(-20, -5, Math.max(2, 40 * (p.done / p.total)), 5, 2).fill(done ? 0x3fb950 : 0x4f8cff);
    }
  }

  /** `labelsOn`: names, machine lines and bars are for a building seen up close; farther out only the marker shows. */
  place(view: View, labelsOn: boolean, t: number, reducedMotion: boolean): void {
    const x = view.x + this.world.x * view.scale;
    const y = view.y + this.world.y * view.scale;
    this.root.position.set(Math.round(x), Math.round(y));
    const bounce = this.markerKind && this.markerKind !== 'error' && !reducedMotion ? Math.abs(Math.sin(t * 4)) * 6 : 0;
    this.pulse = Math.max(0, this.pulse - 0.03);
    this.marker.position.set(0, -16 - bounce);
    this.marker.scale.set(1 + this.pulse * 0.8);
    // the label clears the chair, which scales with the world; everything else stacks right under it
    const below = 39 * view.scale;
    const shown = labelsOn || this.hovered;
    this.label.visible = shown;
    this.label.text = this.hovered ? this.full : this.short;
    this.label.style.fill = !this.hovered && this.showingActivity ? MUTED : 0xe6e8ee;
    this.label.position.set(0, below);
    this.label.alpha = this.hovered ? 1 : 0.75;
    // one line per piece under the name: the machine, then (hovered) the state and the task's title, then the bar
    let line = below;
    const machineShown = shown && this.machine.text !== '';
    this.machine.visible = machineShown;
    if (machineShown) {
      line += 13;
      this.machine.position.set(0, line);
    }
    const statusShown = this.hovered && this.status.text !== '';
    this.status.visible = statusShown;
    if (statusShown) {
      line += 14;
      this.status.position.set(0, line);
    }
    const titled = this.hovered && this.title.text !== '';
    this.title.visible = titled;
    if (titled) {
      line += 14;
      this.title.position.set(0, line);
    }
    const barY = line + 21;
    this.bar.visible = this.barText.visible = labelsOn;
    this.bar.position.set(-13, barY);
    this.barText.position.set(11, barY - 2.5);
    // over every other overlay item (its neighbours' labels, the signs), or it reads as clipped
    const z = this.hovered ? 2 : 1;
    if (this.root.zIndex !== z) this.root.zIndex = z;
  }
}

/** Overlay stacking: desk overlays take 1 (2 hovered), so a marker always wins over a sign. */
const SIGN_Z = 0.5;

/**
 * A sign hanging over a world point: a bold name, a muted detail line under it, no plate. `lift` is
 * extra height in SCREEN pixels. The world anchor shrinks with the zoom while markers, labels and
 * the signs themselves keep their screen size, so a sign that clears what is under it at close range
 * lands right on top of it once the camera pulls back.
 */
class Sign {
  readonly root = new Container();
  private readonly name: Text;
  private readonly detail: Text;

  constructor(
    readonly world: { x: number; y: number },
    size: number,
    private readonly lift = 0,
  ) {
    this.name = new Text({ text: '', style: text(size, 0xe6e8ee, '700') });
    this.detail = new Text({ text: '', style: text(11, MUTED) });
    this.name.anchor.set(0.5, 1);
    this.detail.anchor.set(0.5, 0);
    this.root.addChild(this.name, this.detail);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
  }

  /** `lit` dims the sign's OWN words and nothing a subclass added beside them. */
  protected write(label: string, detail: string, lit: boolean): void {
    this.name.text = label;
    this.detail.text = detail;
    this.name.alpha = this.detail.alpha = lit ? 1 : 0.6;
  }

  /** Width of the detail line, 0 when empty, so a subclass can lay its own piece out beside it. */
  protected get detailWidth(): number {
    return this.detail.text ? this.detail.width : 0;
  }

  protected set detailX(x: number) {
    this.detail.x = x;
  }

  /** Hidden once its anchor leaves the viewport, or half a sign stays glued to the screen edge. */
  place(view: View, screen: { width: number; height: number }): void {
    const x = view.x + this.world.x * view.scale;
    const y = view.y + this.world.y * view.scale - this.lift;
    this.root.visible = x >= 0 && x <= screen.width && y >= 0 && y <= screen.height;
    this.root.position.set(Math.round(x), Math.round(y));
  }
}

/**
 * The sign hangs over the block's FRONT corner, the one piece of a block that is reliably clear:
 * every marker points upwards out of a desk, so nothing of the building's own reaches down there,
 * and the text stays over its own ground instead of drifting across the street onto the block
 * behind it. The lift takes it far enough up that the diamond is wide enough to hold the text.
 */
const SIGN_LIFT = 32;
/** Zoomed out, the block shrinks around a sign that does not; it gives way a little, never past legibility. */
const MIN_SIGN_SCALE = 0.72;
/** Room between the detail line and the counter when the sign carries both. */
const DETAIL_GAP = 4;

/**
 * A building's one sign (city-by-project §3.2), merging the old machine and room signs: the
 * project's name, the notice, the board ("d/t tarefas") or "sem agentes agora", and how many need
 * you — in its own colour, because that is the one thing an unlit building must NOT say quietly.
 */
export class BuildingSign extends Sign {
  private readonly count = new Text({ text: '', style: text(11, ATTENTION) });

  constructor(world: { x: number; y: number }, model: BuildingModel) {
    super(world, 16, SIGN_LIFT);
    this.count.anchor.set(0.5, 0);
    this.root.addChild(this.count);
    this.root.zIndex = SIGN_Z;
    this.apply(model);
  }

  apply(model: BuildingModel): void {
    const { name, detail, count } = buildingSignText(model);
    this.count.text = count;
    this.write(name, detail, model.lit);
    // detail and counter are two texts on one line: centre the pair, not each half
    const detailW = this.detailWidth;
    const countW = count ? this.count.width : 0;
    const total = detailW + (detailW && countW ? DETAIL_GAP : 0) + countW;
    this.detailX = detailW / 2 - total / 2;
    this.count.x = total / 2 - countW / 2;
  }

  place(view: View, screen: { width: number; height: number }): void {
    this.root.scale.set(Math.min(1, Math.max(MIN_SIGN_SCALE, view.scale / SIGN_SCALE)));
    super.place(view, screen);
  }
}
