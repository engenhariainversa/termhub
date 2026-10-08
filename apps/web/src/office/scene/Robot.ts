/**
 * The little robot that sits at an automatic run's desk instead of a person (TER-1048), drawn in the
 * desk sheet's pixels so it shares the station's one transform, and placed behind the empty chair's
 * sheet so the chair back covers it the way it covers the person. Thick dark outlines and flat
 * shades, like the pixel art around it. Redrawn on each 10 fps frame of its motion.
 */
import { Graphics } from 'pixi.js';
import { SCREEN_COLOR, type AvatarMotion } from './deskLook';

const OUTLINE = 0x1a1d24;
const LINE = 5;
const BODY = 0xb8c2d0;
const BODY_SHADE = 0x96a1b2;
const HEAD = 0xd5dde8;
const HEAD_SHADE = 0xa9b4c3;
const JOINT = 0x6b7486;
const LIMB = 0xa3aebd;
const LIMB_FAR = 0x8d98a8;
const HAND = 0x5b6476;
const FOOT = 0x4a5263;
const SHIN = 0x7f8a9b;
const VISOR = 0x58d5ff;
const ANTENNA_OFF = 0x3a404c;

type Pt = [number, number];

/** Where the head sits over the chair, in sheet pixels: the "z z z" of a dozing robot rise from here. */
export const ROBOT_HEAD = { x: 300, y: 120 };

export interface RobotPose {
  /** whole body, sideways (the error shake) */
  dx: number;
  /** head offset: down when it powers off, up when it watches the game, sideways when it looks around */
  head: Pt;
  /** near and far hand lift (typing, mashing buttons); positive is down, resting */
  hands: [number, number];
  antenna: number | null;
}

/** One frame of a motion. `attention`: the tab needs the person, so the antenna blinks in that colour. */
export function robotPose(motion: AvatarMotion, f: number, attention: boolean, reducedMotion: boolean): RobotPose {
  const still = (head: Pt, hands: [number, number], antenna: number | null): RobotPose => ({ dx: 0, head, hands, antenna });
  if (reducedMotion) {
    const color: Record<AvatarMotion, number | null> = { type: SCREEN_COLOR.accent, play: attention ? SCREEN_COLOR.attention : SCREEN_COLOR.accent, shake: SCREEN_COLOR.danger, doze: null, relax: SCREEN_COLOR.ok, watch: SCREEN_COLOR.accent, still: null };
    return still([0, motion === 'doze' || motion === 'relax' ? 8 : 0], motion === 'doze' || motion === 'relax' ? [10, 10] : [0, 0], color[motion]);
  }
  switch (motion) {
    case 'type':
      // hands take turns on the keys, the head nods along, the antenna blinks the working blue
      return still([0, Math.floor(f / 3) % 2 ? 2 : 0], f % 2 ? [-6, 0] : [0, -6], f % 6 < 3 ? SCREEN_COLOR.accent : ANTENNA_OFF);
    case 'play':
      // leaning into the game: head up, thumbs mashing fast, the antenna slow-blinking for attention
      return still([-2, -4], [f % 2 ? -3 : 0, f % 2 ? 0 : -3], attention ? (Math.floor(f / 8) % 2 ? ANTENNA_OFF : SCREEN_COLOR.attention) : SCREEN_COLOR.accent);
    case 'shake':
      return { dx: f % 20 < 6 ? (f % 2 ? 4 : -4) : 0, head: [0, 0], hands: [8, 8], antenna: f % 4 < 2 ? SCREEN_COLOR.danger : ANTENNA_OFF };
    case 'doze':
      // switched off: head dropped, hands in the lap, antenna dark
      return still([0, 8 + (Math.floor(f / 10) % 2)], [12, 12], null);
    case 'relax':
      // done: settles back, a steady green light
      return still([0, 6], [12, 12], SCREEN_COLOR.ok);
    case 'watch':
      // waiting on its background work: looks from one monitor to the other, antenna pulsing slowly
      return still([Math.floor(f / 15) % 2 ? 3 : -3, 0], [6, 6], Math.floor(f / 10) % 2 ? SCREEN_COLOR.accent : 0x2c4a80);
    case 'still':
      return still([0, 0], [0, 0], null);
  }
}

function box(g: Graphics, x0: number, y0: number, x1: number, y1: number, radius: number, color: number): void {
  g.roundRect(x0, y0, x1 - x0, y1 - y0, radius).fill(color).stroke({ color: OUTLINE, width: LINE });
}

function limb(g: Graphics, pts: Pt[], width: number, color: number): void {
  const path = () => {
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  };
  path();
  g.stroke({ color: OUTLINE, width: width + LINE * 2, cap: 'round', join: 'round' });
  path();
  g.stroke({ color, width, cap: 'round', join: 'round' });
}

/** Paints the robot in one pose, far parts first: far arm, legs, body, head, antenna, near arm. */
export function paintRobot(g: Graphics, pose: RobotPose): void {
  g.clear();
  const [hx, hy] = pose.head;
  const [near, far] = pose.hands;
  g.position.x = pose.dx;
  limb(g, [[272, 236], [250, 262 + far / 2], [226, 250 + far]], 15, LIMB_FAR);
  box(g, 214, 242 + far, 236, 256 + far, 4, HAND);
  limb(g, [[240, 330], [228, 366]], 16, SHIN);
  box(g, 214, 360, 244, 376, 5, FOOT);
  limb(g, [[266, 336], [258, 372]], 16, SHIN);
  box(g, 244, 366, 274, 382, 5, FOOT);
  box(g, 228, 218, 320, 322, 16, BODY);
  g.rect(292, 224, 22, 92).fill(BODY_SHADE);
  box(g, 250, 244, 286, 288, 4, SHIN);
  g.rect(258, 254, 8, 8).fill(VISOR);
  g.rect(272, 254, 8, 8).fill(pose.antenna ?? ANTENNA_OFF);
  box(g, 260, 202, 286, 224, 3, JOINT);
  box(g, 230 + hx, 138 + hy, 312 + hx, 210 + hy, 16, HEAD);
  g.rect(290 + hx, 146 + hy, 16, 58).fill(HEAD_SHADE);
  // the edge of the visor, all that shows of the face from behind
  box(g, 222 + hx, 158 + hy, 242 + hx, 182 + hy, 5, pose.antenna === null ? 0x2c4a5a : VISOR);
  g.circle(304 + hx, 176 + hy, 8).fill(JOINT).stroke({ color: OUTLINE, width: 4 });
  limb(g, [[270 + hx, 140 + hy], [278 + hx, 106 + hy]], 5, JOINT);
  g.circle(279 + hx, 101 + hy, 11).fill(pose.antenna ?? ANTENNA_OFF).stroke({ color: OUTLINE, width: 4 });
  limb(g, [[240, 240], [208, 282 + near / 2], [186, 266 + near]], 17, LIMB);
  box(g, 170, 256 + near, 196, 272 + near, 5, HAND);
}
