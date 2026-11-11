// Draws every creature and every loose body as instanced boxes: one unit cube,
// one instance per box, each carrying its own transform, colour and the voxel
// light where it stands. Models and poses come from models.ts and pose.ts.

import { angleDelta, damp } from '../../core/math';
import type { EntityView } from '../../sim/api';
import type { World } from '../../world/world';
import type { GL } from '../gl';
import { type Model, animalModel, personModel } from './models';
import { CHANNEL_INDEX, type Pose, computePose, makePose } from './pose';

/** Floats per instance: three rows of a 3x4 transform, colour rgb and glow, sky and block light, then a tile layer for each of the six faces (-1 for a plain box). */
const STRIDE = 24;
const PX = 1 / 16;

interface Smoothed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  seen: number;
}

export class EntityRenderer {
  private readonly gl: GL;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private data = new Float32Array(STRIDE * 4096);
  private capacity = 4096;
  count = 0;
  private readonly models = new Map<string, Model>();
  private readonly smooth = new Map<number, Smoothed>();
  private readonly pose: Pose = makePose();
  private frame = 0;
  /** Resolves a villager's `role` to a trade name for its dress. */
  tradeOf: (role: number) => string = () => '';

  constructor(gl: GL) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    const cube = gl.createBuffer();
    const inst = gl.createBuffer();
    if (!vao || !cube || !inst) throw new Error('could not create entity buffers');
    this.vao = vao;
    this.instanceBuffer = inst;

    // A unit cube with face normals: 36 vertices of position then normal.
    const faces: [number[], number[], number[]][] = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    const verts: number[] = [];
    for (const [n, u, v] of faces) {
      const corner = (a: number, b: number): number[] => [0, 1, 2].map((i) => (n[i] as number) * 0.5 + (u[i] as number) * a + (v[i] as number) * b);
      for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) verts.push(...corner(a, b), ...n);
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cube);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const bytes = STRIDE * 4;
    const attr = (loc: number, size: number, offset: number): void => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(2, 4, 0);
    attr(3, 4, 4);
    attr(4, 4, 8);
    attr(5, 4, 12);
    attr(6, 2, 16);
    attr(7, 3, 18);
    attr(8, 3, 21);
    gl.bindVertexArray(null);
  }

  /** Start a frame's list of boxes. */
  begin(): void {
    this.count = 0;
    this.frame++;
  }

  private reserve(): number {
    if (this.count === this.capacity) {
      this.capacity *= 2;
      const bigger = new Float32Array(STRIDE * this.capacity);
      bigger.set(this.data);
      this.data = bigger;
    }
    return this.count++ * STRIDE;
  }

  /**
   * One box from a root transform (rows of a 3x4, model units) and a box within it:
   * centre and size in the root's units, turned by `rot` (3x3, row-major) about `pivot`.
   */
  private box(root: Float32Array, px: number, py: number, pz: number, rot: Float32Array | null, ox: number, oy: number, oz: number,
    w: number, h: number, d: number, r: number, g: number, b: number, glow: number, sky: number, block: number,
    tiles: readonly number[] | null = null): void {
    const o = this.reserve();
    const out = this.data;
    for (let row = 0; row < 3; row++) {
      const a0 = root[row * 4] as number;
      const a1 = root[row * 4 + 1] as number;
      const a2 = root[row * 4 + 2] as number;
      // Rotation part: root * rot.
      let c0 = a0, c1 = a1, c2 = a2;
      if (rot) {
        c0 = a0 * (rot[0] as number) + a1 * (rot[3] as number) + a2 * (rot[6] as number);
        c1 = a0 * (rot[1] as number) + a1 * (rot[4] as number) + a2 * (rot[7] as number);
        c2 = a0 * (rot[2] as number) + a1 * (rot[5] as number) + a2 * (rot[8] as number);
      }
      out[o + row * 4] = c0 * w;
      out[o + row * 4 + 1] = c1 * h;
      out[o + row * 4 + 2] = c2 * d;
      out[o + row * 4 + 3] = (root[row * 4 + 3] as number) + a0 * px + a1 * py + a2 * pz + c0 * ox + c1 * oy + c2 * oz;
    }
    out[o + 12] = r;
    out[o + 13] = g;
    out[o + 14] = b;
    out[o + 15] = glow;
    out[o + 16] = sky;
    out[o + 17] = block;
    for (let f = 0; f < 6; f++) out[o + 18 + f] = tiles ? (tiles[f] as number) : -1;
  }

  private readonly root = new Float32Array(12);
  private readonly rot = new Float32Array(9);

  /** Add a creature. `dt` is the frame time, used to ease its position between simulation steps. */
  addEntity(v: EntityView, world: World, dt: number): void {
    let s = this.smooth.get(v.id);
    if (!s) {
      s = { x: v.x, y: v.y, z: v.z, yaw: v.yaw, seen: this.frame };
      this.smooth.set(v.id, s);
    }
    // Snap across large jumps (teleports); otherwise ease, so ten simulation steps a second read as motion.
    if (Math.abs(v.x - s.x) + Math.abs(v.y - s.y) + Math.abs(v.z - s.z) > 6) {
      s.x = v.x; s.y = v.y; s.z = v.z; s.yaw = v.yaw;
    } else {
      s.x = damp(s.x, v.x, 16, dt);
      s.y = damp(s.y, v.y, 16, dt);
      s.z = damp(s.z, v.z, 16, dt);
      s.yaw += angleDelta(s.yaw, v.yaw) * (1 - Math.exp(-12 * dt));
    }
    s.seen = this.frame;

    const person = v.kind === 'villager' || v.kind === 'child';
    const key = person ? `p:${v.look}:${v.role}:${v.kind}` : `${v.kind}:${v.look % 16}`;
    let model = this.models.get(key);
    if (!model) {
      model = person ? personModel(v.look, this.tradeOf(v.role), v.kind === 'child') : animalModel(v.kind, v.look % 16);
      this.models.set(key, model);
    }
    const pose = this.pose;
    let legs = 0;
    for (const p of model.parts) if (p.channel.startsWith('leg')) legs = Math.max(legs, p.h * PX);
    computePose(v.kind, v.anim, v.animTime, v.id, legs * v.scale, pose);

    // Root: place, turn to heading, then the pose's whole-body tip and roll, in model pixels.
    const yaw = s.yaw + pose.turn;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
    const k = v.scale * PX;
    // R = Ry * Rx * Rz
    const m00 = cy * cr + sy * sp * sr, m01 = -cy * sr + sy * sp * cr, m02 = sy * cp;
    const m10 = cp * sr, m11 = cp * cr, m12 = -sp;
    const m20 = -sy * cr + cy * sp * sr, m21 = sy * sr + cy * sp * cr, m22 = cy * cp;
    const root = this.root;
    root[0] = m00 * k; root[1] = m01 * k; root[2] = m02 * k; root[3] = s.x + sy * pose.shift;
    root[4] = m10 * k; root[5] = m11 * k; root[6] = m12 * k; root[7] = s.y + pose.lift;
    root[8] = m20 * k; root[9] = m21 * k; root[10] = m22 * k; root[11] = s.z + cy * pose.shift;

    const light = world.getLight(Math.floor(s.x), Math.floor(s.y + 0.8), Math.floor(s.z));
    const sky = (light >> 4) / 15;
    const block = (light & 15) / 15;
    const rot = this.rot;
    for (const p of model.parts) {
      const ci = (CHANNEL_INDEX.get(p.channel) as number) * 3;
      const rx = pose.rot[ci] as number;
      const ry = pose.rot[ci + 1] as number;
      const rz = pose.rot[ci + 2] as number;
      let use: Float32Array | null = null;
      if (rx !== 0 || ry !== 0 || rz !== 0) {
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cyy = Math.cos(ry), syy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);
        // Rz * Ry * Rx
        rot[0] = cz * cyy; rot[1] = cz * syy * sx - sz * cx; rot[2] = cz * syy * cx + sz * sx;
        rot[3] = sz * cyy; rot[4] = sz * syy * sx + cz * cx; rot[5] = sz * syy * cx - cz * sx;
        rot[6] = -syy; rot[7] = cyy * sx; rot[8] = cyy * cx;
        use = rot;
      }
      const c = model.palette[p.color] as number[];
      this.box(root, p.px, p.py, p.pz, use, p.ox, p.oy, p.oz, p.w, p.h, p.d, c[0] as number, c[1] as number, c[2] as number, 0, sky, block);
    }
  }

  /**
   * Add a free box in world space: centre, half extents along its own axes,
   * orientation as a quaternion, linear colour. Used for loose blocks, items and
   * particles. With `tiles` (a block's six tile layers, in face order) the box
   * is textured like that block and the colour becomes its seasonal tint.
   */
  addBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number,
    r: number, g: number, b: number, sky: number, block: number, glow = 0, tiles: readonly number[] | null = null): void {
    const root = this.root;
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    root[0] = 1 - 2 * (yy + zz); root[1] = 2 * (xy - wz); root[2] = 2 * (xz + wy); root[3] = x;
    root[4] = 2 * (xy + wz); root[5] = 1 - 2 * (xx + zz); root[6] = 2 * (yz - wx); root[7] = y;
    root[8] = 2 * (xz - wy); root[9] = 2 * (yz + wx); root[10] = 1 - 2 * (xx + yy); root[11] = z;
    this.box(root, 0, 0, 0, null, 0, 0, 0, hx * 2, hy * 2, hz * 2, r, g, b, glow, sky, block, tiles);
  }

  /** Forget the eased state of creatures that have gone, and send this frame's boxes to the GPU. */
  finish(): void {
    if (this.frame % 240 === 0) {
      for (const [id, s] of this.smooth) if (s.seen < this.frame - 2) this.smooth.delete(id);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (this.data.byteLength > gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE)) gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * STRIDE);
  }

  /** Where a creature is drawn this frame (eased), for name tags and picking; null if not drawn. */
  drawn(id: number): { x: number; y: number; z: number } | null {
    const s = this.smooth.get(id);
    return s && s.seen === this.frame ? s : null;
  }

  draw(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.count);
  }
}
