// The per-frame uniform block every shader shares. Field order and sizes mirror
// the `Frame` block in shaders/common.ts (std140: five mat4 then vec4s); change
// both together.

import type { GL } from './gl';

const MATS = ['view', 'proj', 'viewProj', 'invViewProj', 'invProj'] as const;
const VECS = [
  'cameraPos', 'lightDir', 'lightColor', 'sunDir', 'moonDir', 'ambientSky', 'ambientGround', 'fog', 'wind', 'weather',
  'screen', 'clip', 'grassTint', 'foliageTint', 'birchTint', 'world', 'misc',
] as const;

export type FrameMat = (typeof MATS)[number];
export type FrameVec = (typeof VECS)[number];

export class FrameUniforms {
  readonly data = new Float32Array(MATS.length * 16 + VECS.length * 4);
  private readonly gl: GL;
  private readonly buffer: WebGLBuffer;

  constructor(gl: GL) {
    this.gl = gl;
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('could not create the frame uniform buffer');
    this.buffer = buffer;
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.bufferData(gl.UNIFORM_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, buffer);
  }

  mat(name: FrameMat, m: Float32Array): void {
    this.data.set(m, MATS.indexOf(name) * 16);
  }

  vec(name: FrameVec, x: number, y: number, z: number, w = 0): void {
    const o = MATS.length * 16 + VECS.indexOf(name) * 4;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = w;
  }

  get(name: FrameVec): [number, number, number, number] {
    const o = MATS.length * 16 + VECS.indexOf(name) * 4;
    return [this.data[o] as number, this.data[o + 1] as number, this.data[o + 2] as number, this.data[o + 3] as number];
  }

  upload(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.data);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.buffer);
  }
}
