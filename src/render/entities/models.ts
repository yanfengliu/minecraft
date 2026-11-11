// Box models for every creature: villagers, livestock and wildlife. Each model
// is a list of coloured boxes hung from joints; `pose.ts` swings the joints.
// The figures are this game's own: stocky folk in tunics and trade dress, and
// animals reduced to a handful of blocks.
//
// Units are sixteenths of a metre. The model stands on y = 0 facing +z.

import { hash32 } from '../../core/rng';
import type { EntityKind } from '../../sim/api';

export type Channel =
  | 'none' | 'body' | 'head' | 'tail'
  | 'armL' | 'armR' | 'legL' | 'legR'
  | 'legFL' | 'legFR' | 'legBL' | 'legBR'
  | 'wingL' | 'wingR';

export interface Part {
  /** Box size. */
  w: number; h: number; d: number;
  /** Joint the box turns about, relative to the feet. */
  px: number; py: number; pz: number;
  /** Centre of the box relative to the joint. */
  ox: number; oy: number; oz: number;
  /** Index into the model's palette. */
  color: number;
  channel: Channel;
  /** Parts on the head follow the head joint; this is that joint. */
  parent?: Part;
}

export interface Model {
  parts: Part[];
  /** Linear-light RGB triples. */
  palette: number[][];
  /** Height of the eyes, for name tags and speech. */
  height: number;
}

type Rgb = [number, number, number];
const srgb = (hex: string): Rgb => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as Rgb;
};
const pick = <T>(list: readonly T[], seed: number, salt: number): T => list[hash32((seed * 31 + salt) >>> 0) % list.length] as T;

function part(w: number, h: number, d: number, px: number, py: number, pz: number, ox: number, oy: number, oz: number, color: number, channel: Channel = 'none', parent?: Part): Part {
  return parent ? { w, h, d, px, py, pz, ox, oy, oz, color, channel, parent } : { w, h, d, px, py, pz, ox, oy, oz, color, channel };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const SKIN = ['#e8b98f', '#d9a074', '#c68a5e', '#f0c9a4', '#a9714b'];
const HAIR = ['#3a2a1c', '#6b4a2b', '#a6753a', '#d9b96a', '#8a8a86', '#1f1a17', '#93411f'];
const CLOTH = ['#7a5a3a', '#5d7a4a', '#4a6a8c', '#8c4a3a', '#8a7a4a', '#6a5a7a', '#9a8a6a', '#4a7a78'];

/** What each trade wears. The index is the trade's position in the village simulation's list; unknown trades get plain dress. */
export interface Dress {
  tunic?: string;
  hat?: 'straw' | 'cap' | 'hood' | 'helm' | 'toque' | 'wide' | 'scarf' | 'feather';
  hatColor?: string;
  apron?: string;
  robe?: boolean;
}

export const TRADE_DRESS: Record<string, Dress> = {
  farmer: { hat: 'straw', hatColor: '#d4b958' },
  miller: { tunic: '#d8d2c0', hat: 'cap', hatColor: '#c9c2ae', apron: '#efe9da' },
  baker: { tunic: '#e9e2d0', hat: 'toque', hatColor: '#f4f0e6', apron: '#f4f0e6' },
  brewer: { tunic: '#7a4a2c', apron: '#5a3a22' },
  innkeeper: { tunic: '#8c3a2e', apron: '#e2d9c2' },
  smith: { tunic: '#4a4a4e', apron: '#3a2a1c' },
  carpenter: { tunic: '#8a6a3a', apron: '#6a4a2a', hat: 'cap', hatColor: '#5a4a32' },
  weaver: { tunic: '#6a5a8c', hat: 'scarf', hatColor: '#c9b05a' },
  storekeeper: { tunic: '#3e5fa8', hat: 'feather', hatColor: '#2a3f78' },
  merchant: { tunic: '#3e5fa8', hat: 'feather', hatColor: '#2a3f78' },
  priest: { tunic: '#2e2a34', robe: true },
  reeve: { tunic: '#7a2a3a', hat: 'feather', hatColor: '#4a1a26' },
  fisher: { tunic: '#4a7a8c', hat: 'wide', hatColor: '#8a7a4a' },
  hunter: { tunic: '#4a6a3a', hat: 'hood', hatColor: '#3a5a2e' },
  woodcutter: { tunic: '#5a7a3a', hat: 'hood', hatColor: '#6a4a2a' },
  miner: { tunic: '#6a6258', hat: 'cap', hatColor: '#3a3632' },
  shepherd: { tunic: '#9a8a6a', hat: 'wide', hatColor: '#6a5a3a' },
  guard: { tunic: '#8c2f2a', hat: 'helm', hatColor: '#9a9ea4' },
  watch: { tunic: '#8c2f2a', hat: 'helm', hatColor: '#9a9ea4' },
};

/** A villager's model: build, colouring and dress from their trade and appearance seed. */
export function personModel(look: number, trade: string, child: boolean): Model {
  const dress = TRADE_DRESS[trade] ?? {};
  const palette: number[][] = [
    srgb(pick(SKIN, look, 1)),                        // 0 skin
    srgb(pick(HAIR, look, 2)),                        // 1 hair
    srgb(dress.tunic ?? pick(CLOTH, look, 3)),        // 2 tunic
    srgb(pick(['#4a3a2a', '#3a3a44', '#5a4a36', '#2e3a2e'], look, 4)), // 3 hose
    srgb('#2a2018'),                                  // 4 belt, shoes, eyes
    srgb(dress.hatColor ?? '#6a5a3a'),                // 5 hat
    srgb(dress.apron ?? '#000000'),                   // 6 apron
  ];
  const parts: Part[] = [];
  const stout = 1 + ((hash32(look * 7 + 5) % 5) - 2) * 0.05;
  const hip = 10;
  // Legs and shoes.
  for (const [side, ch] of [[-1, 'legL'], [1, 'legR']] as const) {
    parts.push(part(3, 8, 3, side * 2, hip, 0, 0, -4, 0, dress.robe ? 2 : 3, ch));
    parts.push(part(3.2, 2, 4, side * 2, hip, 0, 0, -9, 0.4, 4, ch));
  }
  // Tunic, its skirt, and a belt.
  parts.push(part(8 * stout, 10, 5 * stout, 0, hip, 0, 0, 5, 0, 2, 'body'));
  parts.push(part(9 * stout, dress.robe ? 9 : 3, 6 * stout, 0, hip, 0, 0, dress.robe ? -4 : -0.5, 0, 2, 'body'));
  parts.push(part(8.3 * stout, 1.2, 5.3 * stout, 0, hip, 0, 0, 2.2, 0, 4, 'body'));
  if (dress.apron) parts.push(part(5.5, 8.5, 0.7, 0, hip, 0, 0, 3.5, 2.6 * stout, 6, 'body'));
  // Arms with hands.
  for (const [side, ch] of [[-1, 'armL'], [1, 'armR']] as const) {
    const sx = side * (4 * stout + 1.4);
    parts.push(part(2.6, 7.5, 2.8, sx, 19.2, 0, 0, -3.6, 0, 2, ch));
    parts.push(part(2.4, 2, 2.6, sx, 19.2, 0, 0, -8.3, 0, 0, ch));
  }
  // Head, with hair, eyes and whatever the trade wears on it.
  const head = part(7, 7, 7, 0, 20, 0, 0, 3.5, 0, 0, 'head');
  parts.push(head);
  const onHead = (w: number, h: number, d: number, ox: number, oy: number, oz: number, color: number): void => {
    parts.push(part(w, h, d, 0, 20, 0, ox, oy, oz, color, 'head'));
  };
  onHead(1, 1.2, 0.4, -1.6, 4, 3.5, 4);
  onHead(1, 1.2, 0.4, 1.6, 4, 3.5, 4);
  const bald = !dress.hat && hash32(look * 13 + 1) % 9 === 0;
  if (!bald) {
    onHead(7.5, 2.2, 7.5, 0, 6.3, 0, 1);
    onHead(7.5, 4, 1.4, 0, 3.6, -3.2, 1);
    if (hash32(look * 17 + 3) % 2 === 0) {
      // Longer hair down the sides.
      onHead(1.2, 4, 6, 3.3, 3.2, -0.8, 1);
      onHead(1.2, 4, 6, -3.3, 3.2, -0.8, 1);
    }
  }
  switch (dress.hat) {
    case 'straw': onHead(12, 0.9, 12, 0, 7.1, 0, 5); onHead(6.4, 2.6, 6.4, 0, 8.6, 0, 5); break;
    case 'wide': onHead(11, 0.9, 11, 0, 7.1, 0, 5); onHead(6, 3.4, 6, 0, 9, 0, 5); break;
    case 'cap': onHead(7.6, 2.4, 7.6, 0, 7.4, 0, 5); onHead(4, 0.8, 2.4, 0, 6.6, 4.4, 5); break;
    case 'toque': onHead(7.4, 1.4, 7.4, 0, 7.2, 0, 5); onHead(8.2, 3.4, 8.2, 0, 9.4, 0, 5); break;
    case 'hood': onHead(8, 5, 8, 0, 5.2, -0.6, 5); onHead(8.2, 2, 5, 0, 8, -1.4, 5); break;
    case 'helm': onHead(7.8, 3.6, 7.8, 0, 6.6, 0, 5); onHead(1, 4, 0.8, 0, 3.4, 3.8, 5); break;
    case 'scarf': onHead(7.8, 3, 7.8, 0, 6.4, 0, 5); onHead(7.8, 5, 1.6, 0, 2.8, -3.4, 5); break;
    case 'feather': onHead(8.4, 1.6, 8.4, 0, 7.4, 0, 5); onHead(1, 4, 1, 2.6, 9.6, -1, 6); break;
  }
  if (child) {
    // Children are small and big-headed.
    for (const p of parts) {
      if (p.channel === 'head') { p.w *= 1.18; p.h *= 1.18; p.d *= 1.18; p.ox *= 1.18; p.oy *= 1.18; p.oz *= 1.18; }
    }
  }
  return { parts, palette, height: child ? 18 : 28 };
}

// ---------------------------------------------------------------------------
// Animals
// ---------------------------------------------------------------------------

interface Quad {
  body: [number, number, number];
  legs: [number, number, number];
  head: [number, number, number];
  /** How far the head sits above the back and ahead of the chest. */
  neck: [number, number];
  tail: [number, number, number];
}

/** A four-legged animal from proportions; the caller adds what makes the species. */
function quadruped(q: Quad, body: number, legs: number, head: number, tail: number): { parts: Part[]; headPart: Part; top: number } {
  const [bw, bh, bd] = q.body;
  const [lw, lh, ld] = q.legs;
  const parts: Part[] = [];
  const hip = lh;
  parts.push(part(bw, bh, bd, 0, hip, 0, 0, bh / 2, 0, body, 'body'));
  const lx = bw / 2 - lw / 2 - 0.3;
  const lz = bd / 2 - ld / 2 - 0.6;
  for (const [sx, sz, ch] of [[-1, 1, 'legFL'], [1, 1, 'legFR'], [-1, -1, 'legBL'], [1, -1, 'legBR']] as const) {
    parts.push(part(lw, lh, ld, sx * lx, hip + 0.5, sz * lz, 0, -lh / 2 - 0.25, 0, legs, ch));
  }
  const [hw, hh, hd] = q.head;
  const headPart = part(hw, hh, hd, 0, hip + bh - 1 + q.neck[0], bd / 2 - 1 + q.neck[1], 0, hh / 2 - 1, hd / 2 - 1, head, 'head');
  parts.push(headPart);
  const [tw, th, td] = q.tail;
  parts.push(part(tw, th, td, 0, hip + bh - 1.5, -bd / 2, 0, -th / 2 + 1, -td / 2 + 0.5, tail, 'tail'));
  return { parts, headPart, top: hip + bh + q.neck[0] + hh };
}

function onPart(parts: Part[], anchor: Part, w: number, h: number, d: number, ox: number, oy: number, oz: number, color: number): void {
  parts.push(part(w, h, d, anchor.px, anchor.py, anchor.pz, anchor.ox + ox, anchor.oy + oy, anchor.oz + oz, color, anchor.channel));
}

function eyes(parts: Part[], head: Part, spread: number, up: number, color: number): void {
  // Eyes sit on the sides of the face toward the front.
  onPart(parts, head, 0.5, 1, 1, -head.w / 2 - 0.05, up, head.d / 2 - spread, color);
  onPart(parts, head, 0.5, 1, 1, head.w / 2 + 0.05, up, head.d / 2 - spread, color);
}

function bird(look: number, body: [number, number, number], wing: number, colors: string[], beak: string, legs: string): Model {
  const palette = [srgb(pick(colors, look, 1)), srgb(pick(colors, look, 2)), srgb(beak), srgb(legs), srgb('#15120f')];
  const [bw, bh, bd] = body;
  const leg = Math.max(1.5, bh * 0.6);
  const parts: Part[] = [];
  parts.push(part(bw, bh, bd, 0, leg, 0, 0, bh / 2, 0, 0, 'body'));
  const head = part(bw * 0.8, bh * 0.8, bw * 0.85, 0, leg + bh * 0.75, bd / 2 - 0.5, 0, bh * 0.3, bw * 0.3, 1, 'head');
  parts.push(head);
  onPart(parts, head, 0.8, 0.8, 1.6, 0, -0.2, head.d / 2 + 0.6, 2);
  eyes(parts, head, 1, 0.4, 4);
  parts.push(part(0.6, bh * 0.8, wing, -bw / 2 - 0.2, leg + bh * 0.85, 0, 0, -bh * 0.35, -0.3, 1, 'wingL'));
  parts.push(part(0.6, bh * 0.8, wing, bw / 2 + 0.2, leg + bh * 0.85, 0, 0, -bh * 0.35, -0.3, 1, 'wingR'));
  parts.push(part(bw * 0.7, 0.6, bd * 0.5, 0, leg + bh * 0.7, -bd / 2, 0, 0, -bd * 0.22, 1, 'tail'));
  parts.push(part(0.5, leg, 0.5, -bw * 0.22, leg, 0, 0, -leg / 2, 0, 3, 'legL'));
  parts.push(part(0.5, leg, 0.5, bw * 0.22, leg, 0, 0, -leg / 2, 0, 3, 'legR'));
  return { parts, palette, height: leg + bh * 1.6 };
}

/** The model for an animal of this kind; `look` varies coat and markings. */
export function animalModel(kind: EntityKind, look: number): Model {
  switch (kind) {
    case 'sheep': {
      const wool = pick(['#e9e4d6', '#ddd6c4', '#efe9da', '#5a4a3a'], look, 1);
      const palette = [srgb(wool), srgb('#3a322a'), srgb('#2a241e'), srgb('#15120f')];
      const q = quadruped({ body: [9, 8, 13], legs: [2, 5, 2], head: [5, 5, 6], neck: [-1, 0], tail: [2, 3, 2] }, 0, 1, 2, 0);
      eyes(q.parts, q.headPart, 2, 1.4, 3);
      onPart(q.parts, q.headPart, 1.4, 1.4, 2.4, -3.2, 2.2, -1.2, 2);
      onPart(q.parts, q.headPart, 1.4, 1.4, 2.4, 3.2, 2.2, -1.2, 2);
      return { parts: q.parts, palette, height: q.top };
    }
    case 'cow': {
      const palette = [srgb(pick(['#e8e2d4', '#7a4a2c', '#2e2924'], look, 1)), srgb(pick(['#2e2924', '#e8e2d4', '#5a3a22'], look, 2)), srgb('#d9a89a'), srgb('#e9e0c8'), srgb('#15120f')];
      const q = quadruped({ body: [10, 10, 18], legs: [3, 8, 3], head: [6, 6, 7], neck: [-2, 0], tail: [1, 8, 1] }, 0, 0, 0, 1);
      // Patches of the second colour, a pale muzzle, horns and an udder.
      const b = q.parts[0] as Part;
      onPart(q.parts, b, 10.4, 5, 6, 0, 2, 3, 1);
      onPart(q.parts, b, 10.3, 4, 5, 0, -1.5, -5, 1);
      onPart(q.parts, q.headPart, 4.6, 3, 2, 0, -1.4, 3.6, 2);
      onPart(q.parts, q.headPart, 1, 2.2, 1, -2.6, 3.8, -2.4, 3);
      onPart(q.parts, q.headPart, 1, 2.2, 1, 2.6, 3.8, -2.4, 3);
      onPart(q.parts, b, 4, 2, 4, 0, -5.6, -4.5, 2);
      eyes(q.parts, q.headPart, 2, 1.5, 4);
      return { parts: q.parts, palette, height: q.top };
    }
    case 'chicken': {
      const m = bird(look, [4, 4.5, 6], 4, ['#efe9da', '#b9783f', '#d9c9a8', '#3a322a'], '#e0a02e', '#e0a02e');
      const head = m.parts[1] as Part;
      m.palette.push(srgb('#c22b2b'));
      onPart(m.parts, head, 0.8, 1.6, 2, 0, head.h / 2 + 0.5, 0.2, 5);
      onPart(m.parts, head, 0.8, 1.2, 0.8, 0, -1.6, head.d / 2, 5);
      return m;
    }
    case 'deer': {
      const stag = hash32(look * 3 + 1) % 3 === 0;
      const palette = [srgb(pick(['#a6753f', '#96683a', '#b3824a'], look, 1)), srgb('#7a5530'), srgb('#efe6d2'), srgb('#d9c9a0'), srgb('#15120f')];
      const q = quadruped({ body: [7, 8, 16], legs: [2, 10, 2], head: [4, 4.5, 7], neck: [5, 1], tail: [2, 2.5, 2] }, 0, 1, 0, 2);
      const b = q.parts[0] as Part;
      // A long neck up to the head, a pale belly.
      q.parts.push(part(3.6, 8, 3.6, 0, b.py + 6, 6.5, 0, 3, 0.6, 0, 'head'));
      onPart(q.parts, b, 5.6, 1.2, 12, 0, -3.7, 0, 2);
      eyes(q.parts, q.headPart, 2.6, 1.2, 4);
      onPart(q.parts, q.headPart, 1.2, 2.6, 1.6, -2.4, 2.8, -2.4, 0);
      onPart(q.parts, q.headPart, 1.2, 2.6, 1.6, 2.4, 2.8, -2.4, 0);
      if (stag) {
        for (const s of [-1, 1]) {
          onPart(q.parts, q.headPart, 0.9, 5, 0.9, s * 1.6, 5.2, -1.8, 3);
          onPart(q.parts, q.headPart, 0.9, 0.9, 3, s * 2.2, 6.4, -0.4, 3);
          onPart(q.parts, q.headPart, 2.4, 0.9, 0.9, s * 2.8, 7.4, -1.8, 3);
        }
      }
      return { parts: q.parts, palette, height: q.top + (stag ? 4 : 0) };
    }
    case 'rabbit': {
      const palette = [srgb(pick(['#9a8468', '#8a7a6a', '#b39a78', '#6a5a4a'], look, 1)), srgb('#efe9da'), srgb('#15120f')];
      const q = quadruped({ body: [4, 4, 7], legs: [1.2, 2, 1.6], head: [3.6, 3.6, 4], neck: [0, 0], tail: [1.8, 1.8, 1.4] }, 0, 0, 0, 1);
      onPart(q.parts, q.headPart, 1, 4.4, 1, -1, 3.6, -1.2, 0);
      onPart(q.parts, q.headPart, 1, 4.4, 1, 1, 3.6, -1.2, 0);
      eyes(q.parts, q.headPart, 1.4, 0.8, 2);
      return { parts: q.parts, palette, height: q.top + 3 };
    }
    case 'fox': {
      const palette = [srgb('#c8651f'), srgb('#2a1e16'), srgb('#efe6d2'), srgb('#15120f')];
      const q = quadruped({ body: [5, 5, 12], legs: [1.6, 5, 1.6], head: [5, 4, 5], neck: [0, 0], tail: [3, 3, 8] }, 0, 1, 0, 0);
      onPart(q.parts, q.headPart, 2.2, 2, 3, 0, -1, 3.6, 2);
      onPart(q.parts, q.headPart, 1.6, 2.4, 1, -1.6, 2.8, -1.4, 1);
      onPart(q.parts, q.headPart, 1.6, 2.4, 1, 1.6, 2.8, -1.4, 1);
      const tail = q.parts[6] as Part;
      onPart(q.parts, tail, 3.2, 3.2, 2.6, 0, 0, -3.6, 2);
      onPart(q.parts, q.parts[0] as Part, 3.6, 1, 8, 0, -2.2, 0, 2);
      eyes(q.parts, q.headPart, 1.8, 0.9, 3);
      return { parts: q.parts, palette, height: q.top };
    }
    case 'wolf': {
      const palette = [srgb(pick(['#7c7a76', '#66625c', '#928e86', '#4a4640'], look, 1)), srgb('#3a3632'), srgb('#d6d2c6'), srgb('#15120f')];
      const q = quadruped({ body: [6, 7, 15], legs: [2, 8, 2], head: [6, 5, 6], neck: [1, 0], tail: [3, 3, 8] }, 0, 0, 0, 0);
      onPart(q.parts, q.headPart, 2.6, 2.4, 3.4, 0, -1.2, 4.4, 2);
      onPart(q.parts, q.headPart, 1.8, 2.6, 1, -1.9, 3.4, -1.6, 1);
      onPart(q.parts, q.headPart, 1.8, 2.6, 1, 1.9, 3.4, -1.6, 1);
      onPart(q.parts, q.parts[0] as Part, 6.3, 3, 9, 0, 2.3, -1, 1);
      eyes(q.parts, q.headPart, 2, 1.1, 3);
      return { parts: q.parts, palette, height: q.top };
    }
    case 'boar': {
      const palette = [srgb(pick(['#4a3a2e', '#3a2e26', '#5a4634'], look, 1)), srgb('#2a211b'), srgb('#e9e0c8'), srgb('#15120f')];
      const q = quadruped({ body: [8, 8, 14], legs: [2, 5, 2], head: [6, 6, 6], neck: [-2, 0], tail: [1, 3, 1] }, 0, 1, 0, 1);
      onPart(q.parts, q.headPart, 3, 3, 3, 0, -1.6, 4.4, 1);
      onPart(q.parts, q.headPart, 0.8, 2, 0.8, -1.8, -0.4, 4.6, 2);
      onPart(q.parts, q.headPart, 0.8, 2, 0.8, 1.8, -0.4, 4.6, 2);
      onPart(q.parts, q.parts[0] as Part, 2, 2, 12, 0, 4.6, 0, 1);
      eyes(q.parts, q.headPart, 2, 1.4, 3);
      return { parts: q.parts, palette, height: q.top };
    }
    case 'songbird':
      return bird(look, [2.4, 2.4, 3.6], 3, ['#b5562a', '#3e6fb0', '#d9b23a', '#6b5a48', '#8aa04a'], '#3a3028', '#5a4a3a');
    case 'crow':
      return bird(look, [3, 3.2, 5.4], 5, ['#1a1a1e', '#23232a'], '#2a2a2e', '#2a2a2e');
    case 'gull':
      return bird(look, [3, 3, 6], 7, ['#f2f2ee', '#c9ccd2'], '#e0a02e', '#d98a3a');
    case 'duck': {
      const drake = hash32(look * 5 + 2) % 2 === 0;
      const m = bird(look, [4.4, 3.6, 7], 5, drake ? ['#8a7a6a', '#8a7a6a'] : ['#8a6a48', '#8a6a48'], '#d9a02e', '#d98a3a');
      m.palette[1] = srgb(drake ? '#1f6a3f' : '#7a5a3a');
      return m;
    }
    case 'fish': {
      const palette = [srgb(pick(['#8fa6b0', '#6f8f9a', '#a8a070', '#7a9a8a'], look, 1)), srgb('#d8dde0'), srgb('#15120f')];
      const parts: Part[] = [];
      parts.push(part(1.6, 3.4, 6.5, 0, 2, 0, 0, 0, 0, 0, 'body'));
      parts.push(part(1.3, 1.2, 5.5, 0, 2, 0, 0, -1.4, 0, 1, 'body'));
      parts.push(part(0.5, 3.6, 2.6, 0, 2, -3.2, 0, 0, -1.4, 0, 'tail'));
      parts.push(part(0.5, 1.4, 2.4, 0, 2, 0, 0, 2.2, -0.4, 0, 'body'));
      parts.push(part(1.8, 0.9, 0.9, 0, 2, 0, 0, 0.5, 2.2, 2, 'body'));
      return { parts, palette, height: 4 };
    }
    default:
      return animalModel('sheep', look);
  }
}
