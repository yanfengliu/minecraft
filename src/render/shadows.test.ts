import { describe, expect, it } from 'vitest';
import { fakeGl } from './fakeGl';
import { lookDir, mat4, transformPoint } from './mat4';
import { CASCADES, type CameraFrame, ShadowCascades } from './shadows';

const RES = 2048;
const rad = (deg: number): number => (deg * Math.PI) / 180;
/** Toward a mid-morning sun. */
const LIGHT = ((): [number, number, number] => {
  const l = [0.45, 0.62, 0.35];
  const n = Math.hypot(l[0]!, l[1]!, l[2]!);
  return [l[0]! / n, l[1]! / n, l[2]! / n];
})();

/** The camera as the renderer hands it to the cascades: where it is, its axes, and how wide it sees. */
function camera(fovDeg: number, x = 532.3, y = 49.6, z = 561.7, yaw = 0.8, pitch = -0.2): CameraFrame {
  const cp = Math.cos(pitch);
  const fx = Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = Math.cos(yaw) * cp;
  const view = lookDir(mat4(), x, y, z, fx, fy, fz);
  return {
    x, y, z, fx, fy, fz,
    rx: view[0]!, ry: view[4]!, rz: view[8]!,
    ux: view[1]!, uy: view[5]!, uz: view[9]!,
    tanHalfFovY: Math.tan(rad(fovDeg) / 2), aspect: 16 / 9,
  };
}

function cascades(widestDeg = 78): ShadowCascades {
  return new ShadowCascades(fakeGl().gl, RES, 220, rad(widestDeg));
}

/** Where a world point falls in cascade `i`, in texels of its map. */
function texelOf(s: ShadowCascades, i: number, p: readonly [number, number, number]): [number, number] {
  const q = transformPoint(s.matrices.subarray(i * 16, i * 16 + 16), p[0], p[1], p[2]);
  return [(q[0]! * 0.5 + 0.5) * RES, (q[1]! * 0.5 + 0.5) * RES];
}

describe('the shadow cascades', () => {
  it('stay on one grid while the field of view widens for a sprint and comes back', () => {
    // Sized for the view of the moment, each radius, and so the size of a texel, changed every frame
    // of the ramp from 72 to 78 degrees, and the shadows were redrawn on a new grid each time.
    const s = cascades();
    s.update(camera(72), ...LIGHT, true);
    const texel = Array.from(s.texel);
    const matrices = Array.from(s.matrices);
    for (const fov of [72.4, 73.1, 74.9, 76.3, 77.7, 78, 75, 72]) {
      s.update(camera(fov), ...LIGHT, true);
      expect(Array.from(s.texel), `texel size at ${fov} degrees`).toEqual(texel);
      expect(Array.from(s.matrices), `matrices at ${fov} degrees`).toEqual(matrices);
    }
  });

  it('take in a camera wider than was promised, once', () => {
    const s = cascades(78);
    s.update(camera(72), ...LIGHT, true);
    const before = Array.from(s.texel);
    s.update(camera(90), ...LIGHT, true);
    const wide = Array.from(s.texel);
    for (let i = 0; i < CASCADES; i++) expect(wide[i]!).toBeGreaterThan(before[i]!);
    // Having seen it, they keep that size as the view narrows again.
    s.update(camera(72), ...LIGHT, true);
    expect(Array.from(s.texel)).toEqual(wide);
  });

  it('hold every corner of the slice they are for, at any field of view up to the widest', () => {
    for (const fov of [60, 72, 78]) {
      const s = cascades();
      const cam = camera(fov);
      s.update(cam, ...LIGHT, true);
      for (let i = 0; i < CASCADES; i++) {
        const near = i === 0 ? 0.05 : s.splits[i - 1]! * 0.9;
        for (const d of [near, s.splits[i]!]) {
          for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
              const ax = sx * d * cam.tanHalfFovY * cam.aspect;
              const ay = sy * d * cam.tanHalfFovY;
              const p: [number, number, number] = [
                cam.x + cam.fx * d + cam.rx * ax + cam.ux * ay,
                cam.y + cam.fy * d + cam.ry * ax + cam.uy * ay,
                cam.z + cam.fz * d + cam.rz * ax + cam.uz * ay,
              ];
              const [tx, ty] = texelOf(s, i, p);
              const where = `cascade ${i} at ${fov} degrees, corner ${sx},${sy} at ${d.toFixed(1)} m`;
              expect(tx, where).toBeGreaterThanOrEqual(0);
              expect(tx, where).toBeLessThanOrEqual(RES);
              expect(ty, where).toBeGreaterThanOrEqual(0);
              expect(ty, where).toBeLessThanOrEqual(RES);
            }
          }
        }
      }
    }
  });

  it('move by whole texels as the camera moves, so a shadow edge does not shimmer', () => {
    const s = cascades();
    const point: [number, number, number] = [540.2, 48, 566.9];
    s.update(camera(72), ...LIGHT, true);
    const first = Array.from({ length: CASCADES }, (_, i) => texelOf(s, i, point));
    let moved = 0;
    for (let step = 1; step <= 40; step++) {
      // A walk with a turn in it: nothing about it lines up with any grid.
      s.update(camera(72, 532.3 + step * 0.0731, 49.6 + Math.sin(step) * 0.11, 561.7 + step * 0.0417, 0.8 + step * 0.013), ...LIGHT, true);
      for (let i = 0; i < CASCADES; i++) {
        const [tx, ty] = texelOf(s, i, point);
        const dx = tx - first[i]![0];
        const dy = ty - first[i]![1];
        // Single-precision matrices leave a little noise; a real slip would be any fraction of a texel.
        expect(Math.abs(dx - Math.round(dx)), `cascade ${i}, step ${step}`).toBeLessThan(0.02);
        expect(Math.abs(dy - Math.round(dy)), `cascade ${i}, step ${step}`).toBeLessThan(0.02);
        if (Math.round(dx) !== 0 || Math.round(dy) !== 0) moved++;
      }
    }
    // The maps did follow the camera; they were not simply standing still.
    expect(moved).toBeGreaterThan(0);
  });
});
