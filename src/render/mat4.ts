// Column-major 4x4 matrices in Float32Array, the layout WebGL expects, plus the
// frustum test the renderer culls sections with. Right-handed, -z forward in
// view space, clip z in [-1, 1].

export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function ortho(out: Mat4, l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  out.fill(0);
  out[0] = 2 / (r - l);
  out[5] = 2 / (t - b);
  out[10] = -2 / (f - n);
  out[12] = -(r + l) / (r - l);
  out[13] = -(t + b) / (t - b);
  out[14] = -(f + n) / (f - n);
  out[15] = 1;
  return out;
}

/** View matrix looking from `eye` along a forward vector, with `up` as the world up hint. */
export function lookDir(out: Mat4, ex: number, ey: number, ez: number, fx: number, fy: number, fz: number, ux = 0, uy = 1, uz = 0): Mat4 {
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // right = forward x up
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // true up = right x forward
  const tx = ry * fz - rz * fy;
  const ty = rz * fx - rx * fz;
  const tz = rx * fy - ry * fx;
  out[0] = rx; out[1] = tx; out[2] = -fx; out[3] = 0;
  out[4] = ry; out[5] = ty; out[6] = -fy; out[7] = 0;
  out[8] = rz; out[9] = tz; out[10] = -fz; out[11] = 0;
  out[12] = -(rx * ex + ry * ey + rz * ez);
  out[13] = -(tx * ex + ty * ey + tz * ez);
  out[14] = fx * ex + fy * ey + fz * ez;
  out[15] = 1;
  return out;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!, b1 = b[c * 4 + 1]!, b2 = b[c * 4 + 2]!, b3 = b[c * 4 + 3]!;
    out[c * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[c * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[c * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[c * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

export function invert(out: Mat4, m: Mat4): Mat4 {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity(out);
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Transform a point (w = 1) and divide by w. */
export function transformPoint(m: Mat4, x: number, y: number, z: number, out: Float32Array | number[] = [0, 0, 0]): Float32Array | number[] {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! || 1;
  out[0] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  out[1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  out[2] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w;
  return out;
}

/** Six planes (a, b, c, d) with normals pointing inward, extracted from a view-projection matrix. */
export function frustumPlanes(vp: Mat4, out: Float32Array = new Float32Array(24)): Float32Array {
  const rows = [
    [vp[3]! + vp[0]!, vp[7]! + vp[4]!, vp[11]! + vp[8]!, vp[15]! + vp[12]!],
    [vp[3]! - vp[0]!, vp[7]! - vp[4]!, vp[11]! - vp[8]!, vp[15]! - vp[12]!],
    [vp[3]! + vp[1]!, vp[7]! + vp[5]!, vp[11]! + vp[9]!, vp[15]! + vp[13]!],
    [vp[3]! - vp[1]!, vp[7]! - vp[5]!, vp[11]! - vp[9]!, vp[15]! - vp[13]!],
    [vp[3]! + vp[2]!, vp[7]! + vp[6]!, vp[11]! + vp[10]!, vp[15]! + vp[14]!],
    [vp[3]! - vp[2]!, vp[7]! - vp[6]!, vp[11]! - vp[10]!, vp[15]! - vp[14]!],
  ];
  for (let i = 0; i < 6; i++) {
    const r = rows[i]!;
    const len = Math.hypot(r[0]!, r[1]!, r[2]!) || 1;
    out[i * 4] = r[0]! / len;
    out[i * 4 + 1] = r[1]! / len;
    out[i * 4 + 2] = r[2]! / len;
    out[i * 4 + 3] = r[3]! / len;
  }
  return out;
}

/** False only when the box is wholly outside one of the planes. */
export function boxInFrustum(planes: Float32Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let i = 0; i < 24; i += 4) {
    const a = planes[i]!, b = planes[i + 1]!, c = planes[i + 2]!;
    const d = a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + planes[i + 3]!;
    if (d < 0) return false;
  }
  return true;
}
