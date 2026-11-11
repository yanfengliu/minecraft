// The few pieces of geometry the renderer builds once and keeps: the sea
// beyond the island, the quad every precipitation particle is, the box drawn
// round the block being aimed at, and the cloud-noise volume.

import type { World } from '../world/world';
import { FULLSCREEN_VS, type GL, Program, bindTarget, createTarget, createTexture, deleteTarget, drawFullscreen } from './gl';
import { CLOUD_NOISE_FS, NOISE_SIZE } from './shaders/clouds';
import { overlayCube } from './shaders/overlay';

function vertexArray(gl: GL, data: Float32Array, layout: readonly [size: number, stride: number, offset: number][], what: string): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) throw new Error(`could not create ${what}`);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  layout.forEach(([size, stride, offset], location) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  });
  gl.bindVertexArray(null);
  return vao;
}

/** Vertices in the open-sea skirt. */
export const OCEAN_VERTICES = 24;

/** The open sea beyond the world: four slabs around its rectangle, level with the sea inside it. */
export function oceanSkirt(gl: GL, world: World): WebGLVertexArrayObject {
  const y = world.seaLevel - 1 + 15 / 16;
  const R = 2600;
  const { sx, sz } = world;
  const rects = [[-R, -R, 0, sz + R], [sx, -R, sx + R, sz + R], [0, -R, sx, 0], [0, sz, sx, sz + R]];
  const verts: number[] = [];
  for (const [x0, z0, x1, z1] of rects as [number, number, number, number][]) {
    verts.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
  }
  return vertexArray(gl, new Float32Array(verts), [[3, 0, 0]], 'the ocean buffers');
}

/** One quad as a strip, positioned entirely by the vertex shader: rain, snow and splashes are instances of it. */
export function particleQuad(gl: GL): WebGLVertexArrayObject {
  return vertexArray(gl, new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1]), [[2, 0, 0]], 'the particle quad');
}

/** The unit box drawn round the block under the crosshair: position and normal per vertex. */
export function outlineBox(gl: GL): WebGLVertexArrayObject {
  return vertexArray(gl, overlayCube(), [[3, 24, 0], [3, 24, 12]], 'the overlay buffers');
}

/** Cloud noise: a tiling volume, filled once on the GPU a slice at a time. */
export function bakeCloudNoise(gl: GL): WebGLTexture {
  const noise = createTexture(gl, {
    target: gl.TEXTURE_3D, width: NOISE_SIZE, height: NOISE_SIZE, depth: NOISE_SIZE,
    internalFormat: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.REPEAT,
  });
  const program = new Program(gl, 'cloud-noise', FULLSCREEN_VS, CLOUD_NOISE_FS);
  program.use();
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  for (let z = 0; z < NOISE_SIZE; z++) {
    const slice = createTarget(gl, NOISE_SIZE, NOISE_SIZE, [noise], null, z);
    bindTarget(gl, slice);
    program.f('uSlice', (z + 0.5) / NOISE_SIZE);
    drawFullscreen(gl);
    deleteTarget(gl, slice, false);
  }
  gl.deleteProgram(program.handle);
  return noise;
}
