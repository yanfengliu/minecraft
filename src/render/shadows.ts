// Cascaded shadow maps for the key light. Four slices of the view frustum each
// get an orthographic depth map fitted to a bounding sphere of the slice (so
// the map's scale never changes as the camera turns) and snapped to its own
// texel grid (so shadows do not shimmer as the camera moves). Far cascades are
// refreshed less often than near ones.

import { type GL, type Target, createTarget, createTexture } from './gl';
import { type Mat4, frustumPlanes, lookDir, mat4, multiply, ortho } from './mat4';

export const CASCADES = 4;

export interface CameraFrame {
  x: number;
  y: number;
  z: number;
  /** Unit forward, right and up vectors of the camera. */
  fx: number; fy: number; fz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  tanHalfFovY: number;
  aspect: number;
}

export class ShadowCascades {
  readonly res: number;
  readonly texture: WebGLTexture;
  readonly targets: Target[] = [];
  /** World to clip matrix of each cascade, as last rendered. */
  readonly matrices = new Float32Array(CASCADES * 16);
  readonly planes: Float32Array[] = [];
  /** Far view distance of each cascade. */
  readonly splits = new Float32Array(CASCADES);
  readonly texel = new Float32Array(CASCADES);
  private readonly view: Mat4 = mat4();
  private readonly proj: Mat4 = mat4();
  private readonly vp: Mat4 = mat4();
  private frame = 0;

  constructor(gl: GL, res: number, far: number) {
    this.res = res;
    this.texture = createTexture(gl, {
      target: gl.TEXTURE_2D_ARRAY, width: res, height: res, depth: CASCADES,
      internalFormat: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT,
      min: gl.LINEAR, mag: gl.LINEAR, compare: true,
    });
    for (let i = 0; i < CASCADES; i++) {
      this.targets.push(createTarget(gl, res, res, [], this.texture, i));
      this.planes.push(new Float32Array(24));
    }
    this.setFar(far);
  }

  /** Split the shadowed range: mostly logarithmic, so the near cascades stay sharp. */
  setFar(far: number): void {
    const near = 0.5;
    for (let i = 0; i < CASCADES; i++) {
      const t = (i + 1) / CASCADES;
      const log = near * Math.pow(far / near, t);
      const lin = near + (far - near) * t;
      this.splits[i] = lin * 0.18 + log * 0.82;
    }
  }

  /**
   * Refit the cascades due this frame to the camera and light. Returns a bit
   * mask of the cascades whose depth must be re-rendered.
   */
  update(cam: CameraFrame, lx: number, ly: number, lz: number, force = false): number {
    let mask = 0;
    this.frame++;
    for (let i = 0; i < CASCADES; i++) {
      const every = i < 2 ? 1 : i === 2 ? 2 : 4;
      if (!force && this.frame % every !== (i === 3 ? 1 : 0) % every) continue;
      mask |= 1 << i;
      const n = i === 0 ? 0.05 : (this.splits[i - 1] as number) * 0.9;
      const f = this.splits[i] as number;

      // Bounding sphere of the slice: centred on the view axis.
      const tanY = cam.tanHalfFovY;
      const tanX = tanY * cam.aspect;
      const k = 1 + tanX * tanX + tanY * tanY;
      // Centre distance that equalises the distance to the near and far corners, clamped inside the slice.
      const cd = Math.min(f, ((n + f) * k) / 2);
      const rFar = Math.hypot(f * tanX, f * tanY, f - cd);
      const rNear = Math.hypot(n * tanX, n * tanY, cd - n);
      const radius = Math.ceil(Math.max(rFar, rNear) * 8) / 8;
      let cx = cam.x + cam.fx * cd;
      let cy = cam.y + cam.fy * cd;
      let cz = cam.z + cam.fz * cd;

      // Light basis.
      const upY = Math.abs(ly) > 0.99 ? 0 : 1;
      const upZ = Math.abs(ly) > 0.99 ? 1 : 0;
      let rx = -ly * upZ + lz * upY;   // right = (-L) x up, written out
      let ry = -lz * 0 + lx * upZ;
      let rz = -lx * upY + ly * 0;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;
      // up' = right x (-L)
      const ux = ry * -lz - rz * -ly;
      const uy = rz * -lx - rx * -lz;
      const uz = rx * -ly - ry * -lx;

      // Snap the centre to the cascade's texel grid in the light's plane.
      const texel = (radius * 2) / this.res;
      const sx = rx * cx + ry * cy + rz * cz;
      const sy = ux * cx + uy * cy + uz * cz;
      const dx = Math.round(sx / texel) * texel - sx;
      const dy = Math.round(sy / texel) * texel - sy;
      cx += rx * dx + ux * dy;
      cy += ry * dx + uy * dy;
      cz += rz * dx + uz * dy;

      // Pull the light's eye well back so tall casters outside the slice still land in the map.
      const back = 260;
      lookDir(this.view, cx + lx * back, cy + ly * back, cz + lz * back, -lx, -ly, -lz, 0, upY, upZ);
      ortho(this.proj, -radius, radius, -radius, radius, 1, back + radius + 60);
      multiply(this.vp, this.proj, this.view);
      this.matrices.set(this.vp, i * 16);
      frustumPlanes(this.vp, this.planes[i]);
      this.texel[i] = texel;
    }
    return mask;
  }
}
