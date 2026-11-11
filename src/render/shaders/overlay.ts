// The outline around the block the player is aiming at, with cracks that
// spread across it as it is broken.

import { COMMON, FRAME_BLOCK } from './common';

export const OVERLAY_VS = /* glsl */ `
${FRAME_BLOCK}
layout(location = 0) in vec3 aPos;     // unit cube corner
layout(location = 1) in vec3 aFace;    // face uv and a per-face id
uniform vec3 uMin;
uniform vec3 uMax;
out vec3 vFace;
out vec2 vSize;
void main() {
  vec3 size = uMax - uMin;
  // Stand a hair proud of the block so the outline never fights its faces for depth.
  vec3 world = uMin - 0.004 + aPos * (size + 0.008);
  vFace = aFace;
  // Size of this face along its u and v, to keep the line the same width on thin boxes.
  int axis = int(aFace.z) / 2;
  vSize = axis == 0 ? size.zy : axis == 1 ? size.xz : size.xy;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const OVERLAY_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
uniform float uProgress;
in vec3 vFace;
in vec2 vSize;
out vec4 oColor;

float cracks(vec2 p, float progress) {
  vec2 g = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 r = o + hash22(g + o) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  float edge = sqrt(d2) - sqrt(d1);
  return (1.0 - smoothstep(0.0, 0.11, edge)) * smoothstep(0.0, 0.35, progress * 1.5 - hash12(g) * 0.5);
}

void main() {
  vec2 uv = vFace.xy;
  vec2 d = min(uv, 1.0 - uv) * vSize;
  float line = 1.0 - smoothstep(0.012, 0.026, min(d.x, d.y));
  float crack = uProgress > 0.0 ? cracks(uv * vSize * 5.0 + vFace.z * 7.3, uProgress) : 0.0;
  float a = max(line * 0.7, crack * 0.8);
  if (a < 0.01) discard;
  oColor = vec4(vec3(0.02), a);
}
`;

/** Unit cube as 36 vertices: position (3) then face u, v and face index (3). */
export function overlayCube(): Float32Array {
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 1], [0, 0, -1], [0, 1, 0]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 1], [1, 0, 0], [0, 0, -1]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0]],
  ];
  const out: number[] = [];
  faces.forEach(([o, u, v], f) => {
    const corner = (a: number, b: number): number[] => [
      (o[0] as number) + (u[0] as number) * a + (v[0] as number) * b,
      (o[1] as number) + (u[1] as number) * a + (v[1] as number) * b,
      (o[2] as number) + (u[2] as number) * a + (v[2] as number) * b,
      a, b, f,
    ];
    out.push(...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 0), ...corner(1, 1), ...corner(0, 1));
  });
  return new Float32Array(out);
}
