// GLSL shared by every pass: the per-frame uniform block and small helpers.
// The block's layout is mirrored by FrameUniforms in ../frame.ts; change both together.

export const FRAME_BLOCK = /* glsl */ `
layout(std140) uniform Frame {
  mat4 uView;
  mat4 uProj;
  mat4 uViewProj;
  mat4 uInvViewProj;
  mat4 uInvProj;
  vec4 uCameraPos;     // xyz eye, w time in seconds
  vec4 uLightDir;      // xyz toward the key light (sun by day, moon by night), w shadow strength
  vec4 uLightColor;    // rgb key light irradiance / pi at the ground
  vec4 uSunDir;        // xyz toward the sun, w sun disc visibility
  vec4 uMoonDir;       // xyz toward the moon, w lit fraction of its disc
  vec4 uAmbientSky;    // rgb irradiance / pi arriving from the sky dome
  vec4 uAmbientGround; // rgb light bounced up from the ground
  vec4 uFog;           // rgb tint of local fog, a density per metre at sea level
  vec4 uWind;          // xy wind velocity along x and z in m/s, z strength 0..1, w gust travel
  vec4 uWeather;       // x wetness, y snow cover, z precipitation, w cloud cover
  vec4 uScreen;        // xy render size in pixels, zw its reciprocal
  vec4 uClip;          // x near, y far, z sea surface height, w exposure
  vec4 uGrassTint;     // rgb multiplier for grass, a unused
  vec4 uFoliageTint;   // rgb multiplier for deciduous leaves
  vec4 uBirchTint;     // rgb multiplier for birch leaves
  vec4 uWorld;         // xy world size in blocks along x and z, z night factor 0..1, w lightning flash
  vec4 uMisc;          // x camera underwater (0 or 1), y frame index, z sim time of day in hours, w storminess
};
`;

export const COMMON = /* glsl */ `
const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float saturate(float v) { return clamp(v, 0.0, 1.0); }
vec3 saturate3(vec3 v) { return clamp(v, 0.0, 1.0); }

// Octahedral normal packing into two components in 0..1.
vec2 encodeNormal(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 o = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return o * 0.5 + 0.5;
}
vec3 decodeNormal(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return w.xyz / w.w;
}
float linearDepth(float d) {
  float n = uClip.x;
  float f = uClip.y;
  return (2.0 * n * f) / (f + n - (d * 2.0 - 1.0) * (f - n));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// Interleaved gradient noise: a cheap, well-distributed per-pixel dither.
float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm2(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * valueNoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return s;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/**
 * Samples a 16-pixel tile so texels stay crisp squares up close (with a
 * one-pixel antialiased edge) and still filter and mip properly at distance.
 * Plain nearest magnification is not an option: anisotropic filtering, which
 * the ground needs at grazing angles, forces linear magnification on Direct3D.
 */
export const TILE_SAMPLE = /* glsl */ `
// dx and dy are the screen-space derivatives of uv, passed in so callers can transform uv per block
// without the discontinuities that would confuse automatic derivatives.
vec4 tileSampleGrad(sampler2DArray tex, vec2 uv, float layer, vec2 dx, vec2 dy) {
  vec2 px = uv * 16.0;
  vec2 fw = max((abs(dx) + abs(dy)) * 16.0, vec2(1e-5));
  vec2 f = fract(px);
  f = clamp(f / fw, 0.0, 0.5) + clamp((f - 1.0) / fw + 0.5, 0.0, 0.5);
  return textureGrad(tex, vec3((floor(px) + f) / 16.0, layer), dx, dy);
}
vec4 tileSample(sampler2DArray tex, vec2 uv, float layer) {
  return tileSampleGrad(tex, uv, layer, dFdx(uv), dFdy(uv));
}
`;

/** Wind displacement for foliage; shared by the G-buffer and shadow passes so shadows move with the leaves. */
export const WIND = /* glsl */ `
vec3 windOffset(vec3 p, uint cls) {
  float t = uCameraPos.w;
  float strength = uWind.z;
  vec2 dir = normalize(uWind.xy + vec2(1e-4, 0.0));
  // Gusts travel downwind as broad waves, so a field ripples instead of twitching in unison.
  float gust = sin(dot(p.xz, dir) * 0.32 - uWind.w) * 0.5 + 0.5;
  gust *= 0.6 + 0.4 * sin(dot(p.xz, vec2(-dir.y, dir.x)) * 0.11 + t * 0.4);
  float flutter = sin(t * 3.7 + p.x * 2.1 + p.z * 1.7 + p.y * 1.3);
  if (cls == 1u) {
    float amp = 0.015 + 0.07 * strength;
    return vec3(dir.x, 0.25, dir.y) * amp * (gust * 0.8 + 0.25 * flutter);
  }
  float amp = (cls == 3u ? 0.07 : 0.05) + (cls == 3u ? 0.34 : 0.24) * strength;
  vec2 bend = dir * amp * (gust - 0.25) + vec2(flutter, sin(t * 2.9 + p.x * 1.3)) * 0.02 * (0.5 + strength);
  return vec3(bend.x, -dot(bend, bend) * 0.8, bend.y);
}
`;
