// GPU copies of the section meshes. Each section is one vertex buffer holding
// its opaque, cutout and translucent quads in that order; all sections share a
// single index buffer, because every quad uses the same six-index pattern.

import type { MeshOutput } from '../mesh/mesher';
import type { World } from '../world/world';
import type { GL } from './gl';
import { boxInFrustum } from './mat4';

export interface SectionMesh {
  section: number;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  opaque: number;
  cutout: number;
  translucent: number;
  ox: number;
  oy: number;
  oz: number;
  /** Tight vertical bounds of the geometry, in world coordinates. */
  y0: number;
  y1: number;
  bytes: number;
  /** Scratch: squared distance to the camera for sorting. */
  dist: number;
}

export class SectionStore {
  readonly meshes: (SectionMesh | null)[];
  private readonly gl: GL;
  private readonly world: World;
  private indexBuffer: WebGLBuffer;
  private indexQuads = 0;
  /** Totals for the debug readout. */
  quads = 0;
  bytes = 0;
  count = 0;

  constructor(gl: GL, world: World) {
    this.gl = gl;
    this.world = world;
    this.meshes = new Array<SectionMesh | null>(world.sectionCount).fill(null);
    this.indexBuffer = this.makeIndexBuffer(65536);
  }

  private makeIndexBuffer(quads: number): WebGLBuffer {
    const gl = this.gl;
    const indices = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      indices.set([v, v + 1, v + 2, v + 2, v + 3, v], q * 6);
    }
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('could not create the index buffer');
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexQuads = quads;
    return buffer;
  }

  /** Install, replace or (with null) remove a section's mesh. */
  set(section: number, mesh: MeshOutput | null): void {
    const gl = this.gl;
    let m = this.meshes[section] ?? null;
    if (m) {
      this.quads -= m.opaque + m.cutout + m.translucent;
      this.bytes -= m.bytes;
    }
    if (!mesh || mesh.data.length === 0) {
      if (m) {
        gl.deleteVertexArray(m.vao);
        gl.deleteBuffer(m.vbo);
        this.meshes[section] = null;
        this.count--;
      }
      return;
    }
    const total = mesh.opaque + mesh.cutout + mesh.translucent;
    if (total > this.indexQuads) {
      // Rare: a section denser than any before. Grow the shared indices and re-point every vertex array at them.
      gl.deleteBuffer(this.indexBuffer);
      this.indexBuffer = this.makeIndexBuffer(Math.max(total, this.indexQuads * 2));
      for (const other of this.meshes) {
        if (!other) continue;
        gl.bindVertexArray(other.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      }
      gl.bindVertexArray(null);
    }
    const { nsx, nsz } = this.world;
    if (!m) {
      const vao = gl.createVertexArray();
      const vbo = gl.createBuffer();
      if (!vao || !vbo) throw new Error('could not create section buffers');
      const sx = section % nsx;
      const sz = Math.floor(section / nsx) % nsz;
      const sy = Math.floor(section / (nsx * nsz));
      m = { section, vao, vbo, opaque: 0, cutout: 0, translucent: 0, ox: sx * 32, oy: sy * 32, oz: sz * 32, y0: 0, y1: 0, bytes: 0, dist: 0 };
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, 8, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      this.meshes[section] = m;
      this.count++;
    } else {
      gl.bindVertexArray(m.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    }
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    m.opaque = mesh.opaque;
    m.cutout = mesh.cutout;
    m.translucent = mesh.translucent;
    m.y0 = m.oy + mesh.minY;
    // Foliage and crops sway a little past their cell; leave room for it.
    m.y1 = m.oy + mesh.maxY + 0.3;
    m.bytes = mesh.data.byteLength;
    this.quads += total;
    this.bytes += m.bytes;
  }

  /** Sections whose bounds touch the frustum and lie within `maxDist`, nearest first. */
  collect(planes: Float32Array, cx: number, cy: number, cz: number, maxDist: number, out: SectionMesh[]): SectionMesh[] {
    out.length = 0;
    const max2 = maxDist * maxDist;
    for (const m of this.meshes) {
      if (!m) continue;
      const dx = Math.max(m.ox - cx, 0, cx - (m.ox + 32));
      const dz = Math.max(m.oz - cz, 0, cz - (m.oz + 32));
      const dy = Math.max(m.y0 - cy, 0, cy - m.y1);
      const d = dx * dx + dy * dy + dz * dz;
      if (d > max2) continue;
      if (!boxInFrustum(planes, m.ox - 0.4, m.y0, m.oz - 0.4, m.ox + 32.4, m.y1, m.oz + 32.4)) continue;
      m.dist = d;
      out.push(m);
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /** Draw one of the three runs of each mesh. `layer` is 0 opaque, 1 cutout, 2 translucent. Returns quads drawn. */
  draw(list: readonly SectionMesh[], layer: number, originLoc: WebGLUniformLocation | null, reverse = false): number {
    const gl = this.gl;
    let quads = 0;
    const n = list.length;
    for (let k = 0; k < n; k++) {
      const m = list[reverse ? n - 1 - k : k] as SectionMesh;
      const count = layer === 0 ? m.opaque : layer === 1 ? m.cutout : m.translucent;
      if (count === 0) continue;
      const first = layer === 0 ? 0 : layer === 1 ? m.opaque : m.opaque + m.cutout;
      gl.uniform3f(originLoc, m.ox, m.oy, m.oz);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_INT, first * 24);
      quads += count;
    }
    return quads;
  }
}
