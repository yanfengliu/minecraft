// Rain and snow: stateless instanced streaks in a box that wraps around the
// camera, cut off wherever something overhead would stop them (the world's
// rain heightmap), plus the splash rings where drops land.

import { COMMON, FRAME_BLOCK } from './common';

export const PRECIP_VS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
layout(location = 0) in vec2 aCorner;   // x in -0.5..0.5 across, y in 0..1 along
uniform sampler2D uHeightTex;
uniform float uCount;
uniform float uSnow;
out vec2 vCorner;
out float vAlpha;

void main() {
#ifdef SPLASH
  // A ring on the ground where a drop has just landed.
  float id = float(gl_InstanceID);
  vec2 cell = vec2(hash12(vec2(id, 1.7)), hash12(vec2(id, 9.3)));
  float period = 0.35 + 0.25 * hash12(vec2(id, 4.1));
  float t = uCameraPos.w / period + cell.x * 7.0;
  float age = fract(t);
  // Each life lands somewhere new.
  vec2 jump = vec2(hash12(vec2(id, floor(t))), hash12(vec2(floor(t), id + 3.0)));
  vec2 xz = floor(uCameraPos.xz) + (jump - 0.5) * 30.0;
  float roof = texture(uHeightTex, xz / uWorld.xy).r * 255.0;
  float size = 0.08 + 0.34 * age;
  vec3 world = vec3(xz.x + aCorner.x * size, roof + 0.03, xz.y + (aCorner.y - 0.5) * size);
  vCorner = vec2(aCorner.x * 2.0, aCorner.y * 2.0 - 1.0);
  float near = 1.0 - smoothstep(11.0, 15.0, distance(xz, uCameraPos.xz));
  float level = abs(roof - uCameraPos.y) < 14.0 ? 1.0 : 0.0;
  vAlpha = (1.0 - age) * near * level * step(id, uCount) * (1.0 - uSnow);
  gl_Position = vAlpha > 0.001 ? uViewProj * vec4(world, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
#else
  float id = float(gl_InstanceID);
  vec3 h = vec3(hash12(vec2(id, 0.37)), hash12(vec2(id, 5.11)), hash12(vec2(id, 8.73)));
  vec3 box = vec3(34.0, 26.0, 34.0);
  bool snow = uSnow > 0.5;
  vec3 vel = snow ? vec3(uWind.x * 0.55, -1.25 - 0.5 * h.x, uWind.y * 0.55) : vec3(uWind.x * 0.4, -9.0 - 3.0 * h.x, uWind.y * 0.4);
  vec3 p = h * box + vel * uCameraPos.w;
  if (snow) p.xz += vec2(sin(uCameraPos.w * 0.9 + id), cos(uCameraPos.w * 0.7 + id * 1.3)) * 0.45;
  // Wrap the box around the eye so the weather is everywhere the player looks.
  vec3 eye = uCameraPos.xyz;
  p = mod(p - eye + box * 0.5, box) - box * 0.5 + eye;
  float roof = texture(uHeightTex, p.xz / uWorld.xy).r * 255.0;
  bool alive = p.y > roof && id < uCount;

  vec3 along = normalize(vel);
  vec3 toEye = normalize(eye - p);
  vec3 side = normalize(cross(along, toEye));
  float len = snow ? 0.055 : 0.5 + 0.45 * h.y;
  float wid = snow ? 0.055 : 0.016;
  vec3 up = snow ? normalize(cross(toEye, side)) : along;
  vec3 world = p + side * aCorner.x * wid + up * (aCorner.y - 0.5) * len;
  vCorner = vec2(aCorner.x * 2.0, aCorner.y * 2.0 - 1.0);
  // Fade at the edge of the box and right in front of the lens.
  vec3 d = abs(p - eye) / (box * 0.5);
  float edge = 1.0 - smoothstep(0.7, 1.0, max(d.x, max(d.y, d.z)));
  float lens = smoothstep(snow ? 1.4 : 0.6, snow ? 3.5 : 2.0, distance(p, eye));
  vAlpha = edge * lens;
  gl_Position = alive ? uViewProj * vec4(world, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
#endif
}
`;

export const PRECIP_FS = /* glsl */ `
${FRAME_BLOCK}
uniform float uSnow;
in vec2 vCorner;
in float vAlpha;
out vec4 oColor;
void main() {
  vec3 light = uAmbientSky.rgb * 1.7 + uLightColor.rgb * 0.35 + vec3(uWorld.w * 2.0) * uGrassTint.a;
#ifdef SPLASH
  float r = length(vCorner);
  float ring = smoothstep(0.55, 0.8, r) * (1.0 - smoothstep(0.85, 1.0, r));
  float a = ring * vAlpha * 0.5;
  oColor = vec4(light * a, a * 0.3);
#else
  if (uSnow > 0.5) {
    float a = (1.0 - smoothstep(0.4, 1.0, length(vCorner))) * vAlpha * 0.9;
    oColor = vec4(light * 1.25 * a, a);
  } else {
    // A streak: bright along its spine, thinning toward its ends.
    float a = (1.0 - abs(vCorner.x)) * (1.0 - vCorner.y * vCorner.y) * vAlpha * 0.34;
    oColor = vec4(light * a, a * 0.25);
  }
#endif
}
`;
