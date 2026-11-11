// Water and glass: the translucent run of each section, shaded forward over
// the lit scene. Water refracts what lies beneath it, absorbs colour with
// depth, reflects the scene (screen-space, with the sky as fallback), and
// carries waves that follow the wind and the current.
//
// Define OCEAN to draw the open-sea skirt beyond the world from plain positions.

import { ATMOSPHERE_GLSL } from '../atmosphere';
import { CLOUD_DENSITY } from './clouds';
import { CAUSTICS, COMMON, FRAME_BLOCK, TILE_SAMPLE } from './common';
import { FOG, SHADOWS } from './lighting';

export const WATER_VS = /* glsl */ `
${FRAME_BLOCK}
#ifdef OCEAN
layout(location = 0) in vec3 aPos;
#else
layout(location = 0) in uvec2 aData;
uniform vec3 uOrigin;
#endif
out vec3 vWorld;
out vec2 vUV;
out vec2 vLight;
flat out float vLayer;
flat out uint vBits;   // normal index | flowDir << 3 | hasFlow << 6 | isWater << 7 | spilt << 8

void main() {
#ifdef OCEAN
  vWorld = aPos;
  vUV = vec2(0.0);
  vLight = vec2(1.0, 0.0);
  vLayer = 0.0;
  vBits = 2u | 128u;
#else
  uint w0 = aData.x;
  uint w1 = aData.y;
  vec3 local = vec3(float(w0 & 1023u), float((w0 >> 10) & 1023u), float((w0 >> 20) & 1023u)) / 16.0;
  uint n = w1 & 7u;
  bool water = (w1 >> 31) == 1u;
  vWorld = uOrigin + local;
  vLight = vec2(float((w1 >> 13) & 31u), float((w1 >> 18) & 31u)) / 30.0;
  vLayer = float((w1 >> 3) & 1023u);
  vec2 uv;
  if (n == 0u) uv = vec2(-local.z, -local.y);
  else if (n == 1u) uv = vec2(local.z, -local.y);
  else if (n == 2u) uv = vec2(local.x, local.z);
  else if (n == 3u) uv = vec2(local.x, -local.z);
  else if (n == 4u) uv = vec2(local.x, -local.y);
  else uv = vec2(-local.x, -local.y);
  vUV = uv;
  vBits = n | (water ? (((w1 >> 23) & 15u) << 3) | 128u | (((w1 >> 27) & 1u) << 8) : 0u);
#endif
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

export const WATER_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${ATMOSPHERE_GLSL}
${SHADOWS}
${FOG}
${CLOUD_DENSITY}
${TILE_SAMPLE}
${CAUSTICS}
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2DArray uTiles;

in vec3 vWorld;
in vec2 vUV;
in vec2 vLight;
flat in float vLayer;
flat in uint vBits;
out vec4 oColor;

const vec3 NORMALS[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));

// Slope of the water surface at p: a few long swells that run with the wind, and fine chop on top.
vec2 waveSlope(vec2 p, float t, float chop, float distFade, float swellFade) {
  vec2 wind = normalize(uWind.xy + vec2(1e-3, 0.0));
  vec2 g = vec2(0.0);
  float len = 13.0;
  float ang = 0.0;
  // How much water one pixel covers here. A wave shorter than about two pixels cannot be drawn, only
  // aliased, so each wave fades out as it shrinks toward that size and the far sea goes glassy.
  float footprint = max(length(dFdx(p)), length(dFdy(p)));
  for (int i = 0; i < 5; i++) {
    float c = cos(ang);
    float s = sin(ang);
    vec2 dir = vec2(wind.x * c - wind.y * s, wind.x * s + wind.y * c);
    float k = TAU / len;
    // Deep-water waves: longer ones travel faster.
    float speed = sqrt(9.81 / k) * 0.55;
    float keep = 1.0 - smoothstep(0.18 * len, 0.45 * len, footprint);
    g += dir * (0.034 * chop * keep) * cos(dot(dir, p) * k - t * speed * k + float(i) * 1.7);
    len *= 0.54;
    ang += 1.1 + float(i) * 0.7;
  }
  g *= mix(0.3, 1.0, swellFade);
  // Fine ripples from moving noise, faded with distance so the far sea does not shimmer.
  vec2 q = p * 1.7 + wind * t * 0.9;
  float e = 0.12;
  float n0 = valueNoise(q) + 0.5 * valueNoise(q * 2.3 - t * 0.7);
  float nx = valueNoise(q + vec2(e, 0.0)) + 0.5 * valueNoise((q + vec2(e, 0.0)) * 2.3 - t * 0.7);
  float nz = valueNoise(q + vec2(0.0, e)) + 0.5 * valueNoise((q + vec2(0.0, e)) * 2.3 - t * 0.7);
  g += vec2(nx - n0, nz - n0) / e * 0.05 * (0.4 + chop) * distFade;
  return g;
}

// March the reflected ray through the depth buffer; 'hit' is how much to trust the result.
vec3 traceReflection(vec3 origin, vec3 dir, float jitter, out float hit) {
  hit = 0.0;
  float stepLen = 0.5;
  vec3 p = origin + dir * (0.3 + jitter * 0.5);
  for (int i = 0; i < 26; i++) {
    p += dir * stepLen;
    vec4 clip = uViewProj * vec4(p, 1.0);
    if (clip.w <= 0.0) break;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) break;
    float d = texture(uDepth, uv).r;
    float sceneZ = linearDepth(d);
    if (d < 1.0 && clip.w > sceneZ && clip.w - sceneZ < stepLen * 1.6 + 1.2) {
      // Fade toward the screen edge, where the reflected scene runs out.
      vec2 e = smoothstep(0.0, 0.08, uv) * (1.0 - smoothstep(0.92, 1.0, uv));
      hit = e.x * e.y;
      return texture(uScene, uv).rgb;
    }
    stepLen *= 1.24;
  }
  return vec3(0.0);
}

void main() {
  vec3 eye = uCameraPos.xyz;
  vec3 toEye = eye - vWorld;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-4);
  vec2 suv = gl_FragCoord.xy * uScreen.zw;
  uint ni = vBits & 7u;
  vec3 N = NORMALS[min(ni, 5u)];

  if ((vBits & 128u) == 0u) {
    // Glass: the lead and frame are solid, the panes a faint tint that catches the light.
    vec4 a = tileSample(uTiles, vUV, vLayer);
    if (!gl_FrontFacing) N = -N;
    float sky = vLight.x * vLight.x;
    vec3 lit = uAmbientSky.rgb * sky + uLightColor.rgb * saturate(dot(N, uLightDir.xyz)) * 0.8;
    // Lamplight behind a window makes the panes glow from outside.
    vec3 warm = vec3(1.0, 0.62, 0.28) * pow(vLight.y, 2.2) * 2.2 * uGrassTint.a;
    bool pane = a.a < 0.6;
    // A pane is nearly clear: by day it shows the dim room behind it and a sheen of sky; by night, the lamplight inside.
    vec3 c = a.rgb * (lit * (pane ? 0.22 : 1.0) + warm * (pane ? 2.4 : 1.0));
    float fres = 0.05 + 0.95 * pow(1.0 - saturate(dot(N, V)), 5.0);
    vec3 R = reflect(-V, N);
    if (pane) c += skyColor(normalize(vec3(R.x, abs(R.y) + 0.05, R.z))) * fres * 0.8 * sky;
    oColor = vec4(applyFog(c, eye, vWorld), pane ? max(0.32, fres) : 1.0);
    return;
  }

  bool below = uMisc.x > 0.5;
  float t = uCameraPos.w;
  bool top = ni == 2u;
  float storm = uMisc.w;
  float chop = 0.35 + uWind.z * 1.5 + storm * 0.5;
  vec2 p = vWorld.xz;
  bool flowing = (vBits & 64u) != 0u;
  if (flowing) {
    // The pattern rides the current, so a river visibly runs.
    float a = float((vBits >> 3) & 7u) * (PI / 4.0);
    p -= vec2(cos(a), -sin(a)) * t * 1.5;
    chop = 0.8;
  }
  float distFade = 1.0 - smoothstep(60.0, 260.0, dist);
  if (top) {
    vec2 g = waveSlope(p, t, chop, distFade, 1.0 - smoothstep(250.0, 1100.0, dist));
    // Rain: each drop throws out a ring that widens and dies.
    float rain = uWeather.z * distFade * (1.0 - step(0.5, uMisc.x));
    if (rain > 0.02) {
      vec2 c = vWorld.xz * 1.6;
      vec2 cell = floor(c);
      float life = fract(t * 1.7 + hash12(cell) * 9.0);
      vec2 centre = cell + 0.25 + 0.5 * hash22(cell + floor(t * 1.7 + hash12(cell) * 9.0));
      vec2 d = c - centre;
      float r = length(d);
      float ring = sin((r - life * 0.42) * 46.0) * exp(-pow((r - life * 0.42) * 9.0, 2.0)) * (1.0 - life);
      g += normalize(d + 1e-4) * ring * 0.55 * rain * step(hash12(cell + 3.7), rain * 1.4);
    }
    N = normalize(vec3(-g.x, 1.0, -g.y));
  } else {
    // Falling water: streaks sliding down the face.
    float streak = valueNoise(vec2(dot(vWorld.xz, vec2(3.1, 2.3)), vWorld.y * 1.6 + t * 5.0));
    N = normalize(N + vec3(0.0, 0.25, 0.0) * (streak - 0.5));
  }
  if (below) N = -N;

  float sceneD = texture(uDepth, suv).r;
  float sceneZ = linearDepth(sceneD);
  float waterZ = linearDepth(gl_FragCoord.z);
  float thick = max(sceneZ - waterZ, 0.0);

  // Refraction: look at the scene behind, nudged by the surface slope; never pull in what is in front of the water.
  vec2 offset = N.xz * 0.05 * saturate(thick * 0.5) / (1.0 + waterZ * 0.04);
  vec2 ruv = clamp(suv + offset, vec2(0.002), vec2(0.998));
  float rD = texture(uDepth, ruv).r;
  if (linearDepth(rD) < waterZ) { ruv = suv; rD = sceneD; }
  thick = max(linearDepth(rD) - waterZ, 0.0);
  vec3 behind = texture(uScene, ruv).rgb;

  vec3 L = uLightDir.xyz;
  float ndlUp = saturate(L.y);
  float shadow = mix(1.0, keyShadow(vWorld, vec3(0.0, 1.0, 0.0), ndlUp, dist, gl_FragCoord.xy), uLightDir.w) * cloudShadow(vWorld);
  float sky = vLight.x * vLight.x;

  if (below) {
    // From underneath: the sky through Snell's window, a mirror of the deep outside it.
    vec3 T = refract(-V, N, 1.33);
    vec3 deep = vec3(0.02, 0.16, 0.2) * (uAmbientSky.rgb * 1.5 + uLightColor.rgb * 0.4);
    vec3 c = dot(T, T) > 0.0 ? skyColor(normalize(vec3(T.x, abs(T.y) + 0.02, T.z))) * 0.9 + uLightColor.rgb * pow(saturate(dot(T, L)), 180.0) * 8.0 : deep;
    oColor = vec4(mix(c, deep, saturate(dist * 0.035)), 1.0);
    return;
  }

  // What is under the surface: the scene dimmed and tinted by the water it is seen through.
  bool fresh = flowing || vWorld.y > uClip.z + 0.5;
  vec3 absorb = fresh ? vec3(0.34, 0.12, 0.1) : vec3(0.4, 0.09, 0.055);
  vec3 body = fresh ? vec3(0.04, 0.16, 0.13) : vec3(0.015, 0.11, 0.16);
  vec3 bodyLit = body * (uAmbientSky.rgb * 1.4 * sky + uLightColor.rgb * ndlUp * 0.55 * shadow);
  if (top) {
    // Sunlight gathered by the waves into moving lines on the bed: strongest a little way down, lost in the deep.
    vec3 bed = worldFromDepth(ruv, rD);
    float down = max(vWorld.y - bed.y, 0.0);
    float gather = saturate(down * 1.4) * exp(-down * 0.2) * shadow * ndlUp * uLightDir.w * (1.0 - uWeather.w * 0.85);
    behind *= 1.0 + (causticNet(bed.xz + bed.y * 0.3, t) - 0.3) * 1.5 * gather;
  }
  vec3 under = behind * exp(-thick * absorb) + bodyLit * (1.0 - exp(-thick * 0.21));

  // Reflection.
  float ndv = saturate(dot(N, V));
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = skyColor(R) * mix(0.35, 1.0, sky);
  float hit = 0.0;
  if (top && distFade > 0.0) {
    vec3 traced = traceReflection(vWorld, R, ign(gl_FragCoord.xy + 5.0 * uMisc.y), hit);
    refl = mix(refl, traced, hit * distFade);
  }

  vec3 color = mix(under, refl, fres);

  // The sun's glitter path.
  vec3 H = normalize(L + V);
  float ndh = saturate(dot(N, H));
  float gloss = mix(900.0, 160.0, saturate(chop * 0.5));
  color += uLightColor.rgb * pow(ndh, gloss) * (gloss * 0.045) * shadow * uLightDir.w * (1.0 - uWeather.w * 0.9);

  // Foam where the water runs out against a shore or over a drop.
  if (top) {
    float below_ = vWorld.y - worldFromDepth(suv, sceneD).y;
    // Surf belongs to the sea and to running rivers. A pond is calm, and spilt water is shallow
    // everywhere, so without this a puddle would be one sheet of foam.
    bool spilt = (vBits & 256u) != 0u;
    float surf = spilt ? 0.0 : flowing ? 1.0 : 1.0 - smoothstep(0.3, 0.8, abs(vWorld.y - uClip.z));
    float edge = (1.0 - smoothstep(0.0, flowing ? 0.5 : 0.32, below_)) * surf;
    float lace = valueNoise(p * 2.6 + vec2(t * 0.3, 0.0)) * 0.6 + valueNoise(p * 7.0 - vec2(0.0, t * 0.5)) * 0.4;
    // A river over its shallows breaks into streaks and patches, not the solid band of a beach.
    float foam = smoothstep(0.42, 0.75, flowing ? edge * (0.22 + 0.62 * lace) + 0.12 * lace : edge * 0.75 + lace * edge);
    color = mix(color, (uAmbientSky.rgb * 1.6 + uLightColor.rgb * ndlUp * shadow) * 0.82, foam * 0.85);
  } else {
    float streak = valueNoise(vec2(dot(vWorld.xz, vec2(3.1, 2.3)), vWorld.y * 1.6 + t * 5.0));
    color = mix(color, (uAmbientSky.rgb * 1.6 + uLightColor.rgb * ndlUp * shadow) * 0.82, smoothstep(0.45, 0.8, streak) * 0.6);
  }

  oColor = vec4(applyFog(color, eye, vWorld), 1.0);
}
`;
