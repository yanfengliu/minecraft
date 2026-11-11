// Procedural animation: for a creature's kind, what it is doing and how long it
// has been doing it, the angle of each joint and how the whole body sits.

import type { AnimState, EntityKind } from '../../sim/api';
import type { Channel } from './models';

export const CHANNELS: readonly Channel[] = [
  'none', 'body', 'head', 'tail', 'armL', 'armR', 'legL', 'legR', 'legFL', 'legFR', 'legBL', 'legBR', 'wingL', 'wingR',
];
export const CHANNEL_INDEX = new Map<Channel, number>(CHANNELS.map((c, i) => [c, i]));

export interface Pose {
  /** Euler angles (x, y, z) per channel, in CHANNELS order. */
  rot: Float32Array;
  /** Whole-body adjustments: raise, slide forward, tip back, roll over, turn (all in metres or radians). */
  lift: number;
  shift: number;
  pitch: number;
  roll: number;
  turn: number;
}

export function makePose(): Pose {
  return { rot: new Float32Array(CHANNELS.length * 3), lift: 0, shift: 0, pitch: 0, roll: 0, turn: 0 };
}

const BIRDS = new Set<EntityKind>(['songbird', 'crow', 'gull', 'duck', 'chicken']);
const I = (c: Channel): number => (CHANNEL_INDEX.get(c) as number) * 3;
const HEAD = I('head');
const TAIL = I('tail');
const BODY = I('body');
const ARM_L = I('armL');
const ARM_R = I('armR');
const LEG_L = I('legL');
const LEG_R = I('legR');
const LEG_FL = I('legFL');
const LEG_FR = I('legFR');
const LEG_BL = I('legBL');
const LEG_BR = I('legBR');
const WING_L = I('wingL');
const WING_R = I('wingR');

/**
 * Fill `out` for one creature. `t` is its animation clock in seconds, `seed`
 * staggers idle motion between individuals, `legs` is the model's leg length in metres.
 */
export function computePose(kind: EntityKind, anim: AnimState, t: number, seed: number, legs: number, out: Pose): void {
  const r = out.rot;
  r.fill(0);
  out.lift = out.shift = out.pitch = out.roll = out.turn = 0;
  const s = Math.sin;
  const phase = seed * 0.37;

  if (kind === 'villager' || kind === 'child') {
    switch (anim) {
      case 'walk':
      case 'run': {
        const k = anim === 'run' ? 12.5 : 8.5;
        const a = anim === 'run' ? 0.95 : 0.62;
        r[LEG_L] = s(t * k) * a;
        r[LEG_R] = -s(t * k) * a;
        r[ARM_L] = -s(t * k) * a * 0.8;
        r[ARM_R] = s(t * k) * a * 0.8;
        out.lift = Math.abs(s(t * k)) * 0.03;
        r[BODY] = anim === 'run' ? 0.12 : 0.03;
        break;
      }
      case 'work':
        // A swing of the tool arm: up, then down hard.
        r[ARM_R] = -1.5 + Math.pow(Math.abs(s(t * 4.2)), 0.6) * 1.3;
        r[ARM_L] = -0.5 + s(t * 4.2) * 0.12;
        r[BODY] = 0.12 + s(t * 4.2) * 0.05;
        r[HEAD] = 0.15;
        break;
      case 'eat':
        r[ARM_R] = -1.9 + s(t * 5) * 0.22;
        r[HEAD] = 0.12 + s(t * 5) * 0.05;
        break;
      case 'talk':
        r[HEAD + 1] = s(t * 1.9 + phase) * 0.22;
        r[HEAD] = s(t * 3.1) * 0.07;
        r[ARM_R] = -0.7 + s(t * 3.7 + phase) * 0.35;
        r[ARM_L] = -0.15 + s(t * 2.3) * 0.1;
        break;
      case 'sit':
        r[LEG_L] = -1.5;
        r[LEG_R] = -1.5;
        r[ARM_L] = -0.35;
        r[ARM_R] = -0.35 + s(t * 0.9 + phase) * 0.05;
        r[HEAD + 1] = s(t * 0.5 + phase) * 0.3;
        out.lift = -0.5;
        break;
      case 'sleep':
        // Flat on the back.
        out.pitch = -Math.PI / 2;
        out.lift = 0.17;
        out.shift = 0.85;
        r[ARM_L + 2] = 0.08;
        r[ARM_R + 2] = -0.08;
        break;
      case 'dead':
        out.roll = Math.PI / 2;
        out.lift = 0.2;
        break;
      default:
        r[ARM_L] = s(t * 1.3 + phase) * 0.04;
        r[ARM_R] = -s(t * 1.3 + phase) * 0.04;
        r[HEAD + 1] = s(t * 0.45 + phase) * 0.28;
        out.lift = s(t * 1.6 + phase) * 0.004;
    }
    return;
  }

  if (kind === 'fish') {
    const k = anim === 'idle' ? 5 : 11;
    r[TAIL + 1] = s(t * k + phase) * 0.7;
    out.turn = s(t * k + phase + 1.2) * 0.14;
    if (anim === 'dead') out.roll = Math.PI / 2;
    return;
  }

  if (BIRDS.has(kind)) {
    switch (anim) {
      case 'fly':
      case 'glide': {
        const flap = anim === 'fly' ? s(t * (kind === 'gull' || kind === 'crow' ? 9 : 22) + phase) * 0.75 : s(t * 1.7 + phase) * 0.08;
        r[WING_L + 2] = -(Math.PI / 2 + flap);
        r[WING_R + 2] = Math.PI / 2 + flap;
        r[LEG_L] = 1.2;
        r[LEG_R] = 1.2;
        r[TAIL] = -0.2;
        out.pitch = anim === 'fly' ? -0.12 : 0;
        break;
      }
      case 'walk':
      case 'run':
        r[LEG_L] = s(t * 14) * 0.7;
        r[LEG_R] = -s(t * 14) * 0.7;
        r[HEAD] = s(t * 14) * 0.15;
        if (anim === 'run') { r[WING_L + 2] = -0.5 - Math.abs(s(t * 18)) * 0.5; r[WING_R + 2] = 0.5 + Math.abs(s(t * 18)) * 0.5; }
        break;
      case 'eat':
        r[HEAD] = 0.5 + Math.abs(s(t * 6 + phase)) * 0.8;
        break;
      case 'swim':
        r[LEG_L] = 1.3;
        r[LEG_R] = 1.3;
        out.lift = -0.1 + s(t * 2 + phase) * 0.012;
        r[TAIL + 1] = s(t * 3) * 0.15;
        break;
      case 'sleep':
        r[HEAD + 1] = 2.5;
        r[LEG_L] = 1.2;
        r[LEG_R] = 1.2;
        out.lift = -legs * 0.8;
        break;
      case 'dead':
        out.roll = Math.PI / 2;
        break;
      default:
        // Birds look about in quick jerks.
        r[HEAD + 1] = (Math.floor(t * 1.3 + phase) % 3 - 1) * 0.5;
        r[TAIL] = s(t * 2.1 + phase) * 0.08;
    }
    return;
  }

  // Four legs.
  switch (anim) {
    case 'walk':
    case 'run': {
      const k = anim === 'run' ? 13 : 7.5;
      const a = anim === 'run' ? 0.95 : 0.55;
      r[LEG_FL] = s(t * k) * a;
      r[LEG_BR] = s(t * k) * a;
      r[LEG_FR] = -s(t * k) * a;
      r[LEG_BL] = -s(t * k) * a;
      r[HEAD] = s(t * k * 2) * 0.03;
      r[TAIL + 1] = s(t * k * 0.5) * 0.25;
      if (anim === 'run') {
        out.pitch = s(t * k) * 0.06;
        out.lift = Math.abs(s(t * k)) * 0.07;
      }
      break;
    }
    case 'eat':
      r[HEAD] = 0.95 + s(t * 5 + phase) * 0.08;
      r[TAIL + 1] = s(t * 1.7 + phase) * 0.3;
      break;
    case 'sleep':
      // Folded down on the belly, head low.
      r[LEG_FL] = r[LEG_FR] = -1.45;
      r[LEG_BL] = r[LEG_BR] = 1.45;
      r[HEAD] = 0.55;
      out.lift = -legs * 0.82;
      break;
    case 'dead':
      out.roll = Math.PI / 2;
      out.lift = 0.12;
      break;
    case 'swim':
      r[LEG_FL] = s(t * 6) * 0.6;
      r[LEG_FR] = -s(t * 6) * 0.6;
      r[LEG_BL] = -s(t * 6) * 0.6;
      r[LEG_BR] = s(t * 6) * 0.6;
      out.lift = -legs * 0.9;
      break;
    default:
      r[HEAD + 1] = s(t * 0.4 + phase) * 0.35;
      r[HEAD] = s(t * 0.23 + phase) * 0.06;
      r[TAIL + 1] = s(t * 2.2 + phase) * 0.3;
  }
}
