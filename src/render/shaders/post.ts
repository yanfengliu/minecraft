// Screen-space passes after lighting: ambient occlusion, bloom, tone mapping
// with grading, and antialiasing.

import { COMMON, FRAME_BLOCK } from './common';

/** Ambient occlusion from depth and normals, at half resolution. */
export const SSAO_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
uniform sampler2D uDepth;
uniform sampler2D uNormal;
in vec2 vUV;
out vec4 oColor;
void main() {
  float d = texture(uDepth, vUV).r;
  if (d >= 1.0) { oColor = vec4(1.0); return; }
  vec3 P = worldFromDepth(vUV, d);
  vec3 N = decodeNormal(texture(uNormal, vUV).rg);
  float viewZ = linearDepth(d);
  const float RADIUS = 1.1;
  // Projected radius in UV units; kept within a sane number of pixels near and far.
  float r = clamp(RADIUS * uProj[1][1] * 0.5 / viewZ, 2.0 * uScreen.w, 0.12);
  float spin = ign(gl_FragCoord.xy) * TAU;
  float aspect = uScreen.y / uScreen.x;
  float occ = 0.0;
  const int S = 11;
  for (int i = 0; i < S; i++) {
    float t = (float(i) + 0.5) / float(S);
    float a = spin + t * 15.1;
    vec2 uv = vUV + vec2(cos(a) * aspect, sin(a)) * t * r;
    vec3 v = worldFromDepth(uv, texture(uDepth, uv).r) - P;
    float l2 = dot(v, v);
    // Count only geometry within the radius, so distant silhouettes do not darken what they merely overlap.
    occ += max(dot(N, v) - 0.04, 0.0) / (l2 + 0.015) * smoothstep(RADIUS * RADIUS * 1.6, RADIUS * RADIUS * 0.5, l2);
  }
  float ao = saturate(1.0 - occ * (RADIUS * 1.5 / float(S)));
  oColor = vec4(ao * ao, viewZ, 0.0, 1.0);
}
`;

/** Depth-aware blur of the occlusion buffer; run once across and once down. */
export const SSAO_BLUR_FS = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUV;
out vec4 oColor;
void main() {
  vec2 c = texture(uSource, vUV).rg;
  float sum = c.r;
  float weight = 1.0;
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    vec2 s = texture(uSource, vUV + uStep * float(i)).rg;
    float w = max(0.0, 1.0 - abs(s.g - c.g) / (0.06 * c.g + 0.05)) * (1.0 - abs(float(i)) * 0.18);
    sum += s.r * w;
    weight += w;
  }
  oColor = vec4(sum / weight, c.g, 0.0, 1.0);
}
`;

/** Bloom downsample: 13 taps, with the first level weighted against single hot pixels. */
export const BLOOM_DOWN_FS = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uFirst;
in vec2 vUV;
out vec4 oColor;
float weightOf(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
void main() {
  vec3 a = texture(uSource, vUV + uTexel * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(uSource, vUV + uTexel * vec2(0.0, 2.0)).rgb;
  vec3 c = texture(uSource, vUV + uTexel * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(uSource, vUV + uTexel * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(uSource, vUV).rgb;
  vec3 f = texture(uSource, vUV + uTexel * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(uSource, vUV + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSource, vUV + uTexel * vec2(0.0, -2.0)).rgb;
  vec3 i = texture(uSource, vUV + uTexel * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(uSource, vUV + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(uSource, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(uSource, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSource, vUV + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 color;
  if (uFirst > 0.5) {
    vec3 g0 = (j + k + l + m) * 0.25;
    vec3 g1 = (a + b + d + e) * 0.25;
    vec3 g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25;
    vec3 g4 = (e + f + h + i) * 0.25;
    float w0 = weightOf(g0) * 0.5;
    float w1 = weightOf(g1) * 0.125;
    float w2 = weightOf(g2) * 0.125;
    float w3 = weightOf(g3) * 0.125;
    float w4 = weightOf(g4) * 0.125;
    color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    // Only what is brighter than a lit surface feeds the glow.
    float lum = max(color.r, max(color.g, color.b));
    color *= smoothstep(0.9, 2.2, lum);
  } else {
    color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  oColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

/** Bloom upsample: a 3x3 tent, added onto the level above. */
export const BLOOM_UP_FS = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 oColor;
void main() {
  vec3 c = texture(uSource, vUV).rgb * 4.0;
  c += (texture(uSource, vUV + uTexel * vec2(1.0, 0.0)).rgb + texture(uSource, vUV + uTexel * vec2(-1.0, 0.0)).rgb
      + texture(uSource, vUV + uTexel * vec2(0.0, 1.0)).rgb + texture(uSource, vUV + uTexel * vec2(0.0, -1.0)).rgb) * 2.0;
  c += texture(uSource, vUV + uTexel * vec2(1.0, 1.0)).rgb + texture(uSource, vUV + uTexel * vec2(-1.0, 1.0)).rgb
     + texture(uSource, vUV + uTexel * vec2(1.0, -1.0)).rgb + texture(uSource, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  oColor = vec4(c / 16.0, 1.0);
}
`;

/** Exposure, bloom, filmic tone curve, grading, vignette. Writes display-ready colour with luma in alpha for FXAA. */
export const COMPOSITE_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
in vec2 vUV;
out vec4 oColor;

// ACES filmic fit (Stephen Hill): input and output transforms around the RRT+ODT curve.
vec3 aces(vec3 c) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = inM * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return saturate3(outM * (a / b));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = vUV;
  float under = uMisc.x;
  if (under > 0.5) {
    // Looking through moving water: the image swims.
    float t = uCameraPos.w;
    uv += vec2(sin(uv.y * 34.0 + t * 2.1), cos(uv.x * 29.0 + t * 1.7)) * 0.0028;
  }
  vec3 scene = texture(uScene, uv).rgb;
  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 c = (scene + bloom * uBloomStrength) * uClip.w;
  if (under > 0.5) c *= vec3(0.62, 0.9, 1.0);

  c = aces(c * 1.05);

  // Night: the eye loses colour and leans blue in dim light.
  float night = uWorld.z;
  float dim = (1.0 - smoothstep(0.02, 0.3, luma(c))) * night;
  c = mix(c, vec3(luma(c)) * vec3(0.78, 0.9, 1.18), dim * 0.55);
  // A touch more separation and colour than the bare curve gives.
  c = mix(vec3(luma(c)), c, 1.1);
  c = saturate3((c - 0.5) * 1.04 + 0.5);

  vec2 q = vUV - 0.5;
  c *= 1.0 - dot(q, q) * 0.42;

  c = toSrgb(saturate3(c));
  c += (ign(gl_FragCoord.xy + 13.0 * uMisc.y) - 0.5) / 255.0;
  oColor = vec4(c, luma(c));
}
`;

/** FXAA 3.11, console-quality variant: cheap edge antialiasing on the display-ready image. */
export const FXAA_FS = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 oColor;
void main() {
  vec3 rgbM = texture(uSource, vUV).rgb;
  float lumaM = texture(uSource, vUV).a;
  float lumaNW = texture(uSource, vUV + vec2(-1.0, -1.0) * uTexel).a;
  float lumaNE = texture(uSource, vUV + vec2(1.0, -1.0) * uTexel).a;
  float lumaSW = texture(uSource, vUV + vec2(-1.0, 1.0) * uTexel).a;
  float lumaSE = texture(uSource, vUV + vec2(1.0, 1.0) * uTexel).a;
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  if (lumaMax - lumaMin < max(0.0312, lumaMax * 0.125)) { oColor = vec4(rgbM, 1.0); return; }
  vec2 dir = vec2(-((lumaNW + lumaNE) - (lumaSW + lumaSE)), (lumaNW + lumaSW) - (lumaNE + lumaSE));
  float reduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture(uSource, vUV + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uSource, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uSource, vUV + dir * -0.5).rgb + texture(uSource, vUV + dir * 0.5).rgb);
  float lumaB = dot(b, vec3(0.299, 0.587, 0.114));
  oColor = vec4(lumaB < lumaMin || lumaB > lumaMax ? a : b, 1.0);
}
`;
