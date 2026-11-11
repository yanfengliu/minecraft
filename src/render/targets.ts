// The off-screen targets one frame is drawn through. They are all sized from
// the render resolution and rebuilt together when it changes.

import { type GL, type Target, createTarget, createTexture, deleteTarget } from './gl';

const BLOOM_LEVELS = 6;

export class FrameTargets {
  width = 0;
  height = 0;
  /** Albedo and emission, normal and roughness, baked light; with the scene depth. */
  gbuffer!: Target;
  /** The lit scene in linear light. */
  hdr!: Target;
  /** The lit opaque scene, copied so water can refract and reflect it. */
  hdrCopy!: Target;
  /** The HDR colour with its own copy of the depth, so forward passes can test depth while sampling the original. */
  forward!: Target;
  /** Half-resolution ambient occlusion and its blur partner. */
  ao!: [Target, Target];
  /** The bloom pyramid, largest first. */
  bloom: Target[] = [];
  /** The tone-mapped frame, before antialiasing. */
  ldr!: Target;
  /** Half-resolution light shafts; alpha carries view depth, which the upsample uses to keep them from bleeding across edges. */
  volume!: Target;
  /** Quarter-resolution cloud buffers: this frame's and last frame's, swapped each frame. */
  clouds!: [Target, Target];

  private readonly gl: GL;

  constructor(gl: GL) {
    this.gl = gl;
  }

  /** Size every target for a `w` by `h` frame. Returns true if they were rebuilt (their contents are then gone). */
  resize(w: number, h: number): boolean {
    if (w === this.width && h === this.height) return false;
    const gl = this.gl;
    if (this.width > 0) {
      deleteTarget(gl, this.gbuffer);
      deleteTarget(gl, this.hdr);
      deleteTarget(gl, this.hdrCopy);
      // Its colour belongs to `hdr`; only the depth copy is its own.
      gl.deleteTexture(this.forward.depth);
      deleteTarget(gl, this.forward, false);
      for (const t of [...this.ao, ...this.bloom, this.ldr, this.volume, ...this.clouds]) deleteTarget(gl, t);
    }
    this.width = w;
    this.height = h;

    const tex = (tw: number, th: number, internalFormat: number, format: number, type: number, filter: number): WebGLTexture =>
      createTexture(gl, { width: tw, height: th, internalFormat, format, type, min: filter, mag: filter });
    const single = (tw: number, th: number, internalFormat: number, format: number, type: number): Target =>
      createTarget(gl, tw, th, [tex(tw, th, internalFormat, format, type, gl.LINEAR)]);
    const depth = (): WebGLTexture => tex(w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    this.gbuffer = createTarget(gl, w, h, [
      tex(w, h, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST),
      tex(w, h, gl.RGB10_A2, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, gl.NEAREST),
      tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST),
    ], depth());
    this.hdr = single(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    this.hdrCopy = single(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    this.forward = createTarget(gl, w, h, [this.hdr.colors[0] as WebGLTexture], depth());
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.ao = [single(hw, hh, gl.RG16F, gl.RG, gl.HALF_FLOAT), single(hw, hh, gl.RG16F, gl.RG, gl.HALF_FLOAT)];
    this.bloom = [];
    for (let i = 0, bw = hw, bh = hh; i < BLOOM_LEVELS && bw > 2 && bh > 2; i++, bw >>= 1, bh >>= 1) {
      this.bloom.push(single(bw, bh, gl.R11F_G11F_B10F, gl.RGB, gl.HALF_FLOAT));
    }
    this.ldr = single(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.volume = single(hw, hh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    const qw = Math.max(1, w >> 2);
    const qh = Math.max(1, h >> 2);
    this.clouds = [single(qw, qh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT), single(qw, qh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)];
    return true;
  }
}
