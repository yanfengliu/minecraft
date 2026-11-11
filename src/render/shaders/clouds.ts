// Volumetric clouds: a slab of sky ray-marched through tiling 3D noise, lit by
// the key light with self-shadowing, drawn at quarter resolution and blended
// over frames. The same density function casts moving cloud shadows on the land.

import { ATMOSPHERE_GLSL } from '../atmosphere';
import { COMMON, FRAME_BLOCK } from './common';

export const NOISE_SIZE = 96;

/** Fills one slice of the tiling noise volume: r = billowy base shape, g = fine erosion detail. */
export const CLOUD_NOISE_FS = /* glsl */ `
uniform float uSlice;
in vec2 vUV;
out vec4 oColor;

vec3 hash33(vec3 p, float period) {
  p = mod(p, period);
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
// Tiling Worley noise: 1 at cell centres, falling toward the cell walls.
float worley(vec3 p, float period) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(i + o, period) - f;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
// Tiling gradient noise in 0..1.
float perlin(vec3 p, float period) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n = 0.0;
  for (int z = 0; z <= 1; z++) for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 g = hash33(i + o, period) * 2.0 - 1.0;
    vec3 w = mix(1.0 - u, u, o);
    n += dot(g, f - o) * w.x * w.y * w.z;
  }
  return n * 0.5 + 0.5;
}
void main() {
  vec3 p = vec3(vUV, uSlice);
  float pfbm = perlin(p * 4.0, 4.0) * 0.55 + perlin(p * 8.0, 8.0) * 0.28 + perlin(p * 16.0, 16.0) * 0.17;
  float wfbm = worley(p * 4.0, 4.0) * 0.6 + worley(p * 8.0, 8.0) * 0.27 + worley(p * 16.0, 16.0) * 0.13;
  // Perlin-Worley: the soft noise carved into cauliflower by the cellular one.
  float base = clamp((pfbm - (1.0 - wfbm) * 0.42) / (1.0 - (1.0 - wfbm) * 0.42), 0.0, 1.0);
  float detail = worley(p * 12.0, 12.0) * 0.6 + worley(p * 24.0, 24.0) * 0.4;
  oColor = vec4(base, detail, 0.0, 1.0);
}
`;

/** Cloud density and the ground shadow it casts. Needs uCloudNoise and the Frame block. */
export const CLOUD_DENSITY = /* glsl */ `
uniform sampler3D uCloudNoise;
const float CLOUD_BASE = 290.0;
const float CLOUD_TOP = 690.0;

float cloudDensity(vec3 p, bool fine) {
  float h = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float cover = uWeather.w;
  // Clouds are where all the wind so far has carried them (uDrift), and their tops lean downwind by
  // about a minute of the wind there is now. Never wind times elapsed time: that moves the whole sky
  // again whenever the wind changes, and further the longer the game has run.
  vec3 q = p + vec3(uDrift.x, 0.0, uDrift.y) + vec3(uWind.x, 0.0, uWind.y) * (60.0 * h);
  vec2 n = texture(uCloudNoise, q * vec3(1.0 / 2300.0, 1.0 / 900.0, 1.0 / 2300.0)).rg;
  // Fair-weather heaps have flat bases and round tops; overcast fills the whole slab.
  // (smoothstep with its edges the wrong way round is undefined in GLSL, so falling ramps are written 1 - rising.)
  float heap = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.35, 1.0, h));
  float sheet = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.8, 1.0, h));
  float profile = mix(heap, sheet, smoothstep(0.55, 0.95, cover));
  float amount = mix(0.3, 0.98, pow(cover, 0.75));
  float d = n.r * profile - (1.0 - amount);
  if (d <= 0.0) return 0.0;
  d /= amount;
  if (fine) {
    float e = texture(uCloudNoise, q * (1.0 / 420.0) + vec3(0.0, uCameraPos.w * 0.004, 0.0)).g;
    d = max(d - (1.0 - e) * 0.34 * (1.0 - d), 0.0);
  }
  return d * (0.05 + 0.05 * uMisc.w + 0.03 * cover);
}

// How much of the key light reaches a point on the ground through the cloud deck.
float cloudShadow(vec3 world) {
  vec3 L = uLightDir.xyz;
  if (L.y < 0.06) return 1.0;
  float mid = CLOUD_BASE + (CLOUD_TOP - CLOUD_BASE) * 0.35;
  vec3 p = world + L * ((mid - world.y) / L.y);
  float d = cloudDensity(p, false);
  return mix(1.0, exp(-d * 190.0), 0.9);
}
`;

export const CLOUDS_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${ATMOSPHERE_GLSL}
${CLOUD_DENSITY}
uniform sampler2D uSkyLut;
uniform sampler2D uHistory;
uniform mat4 uPrevViewProj;
uniform float uBlend;
in vec2 vUV;
out vec4 oColor;

float hg(float mu, float g) {
  return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
}

void main() {
  vec3 eye = uCameraPos.xyz;
  vec3 far = worldFromDepth(vUV, 1.0);
  vec3 dir = normalize(far - eye);

  vec3 sum = vec3(0.0);
  float through = 1.0;
  // Where the ray is inside the cloud slab.
  float t0 = (CLOUD_BASE - eye.y) / dir.y;
  float t1 = (CLOUD_TOP - eye.y) / dir.y;
  if (t0 > t1) { float s = t0; t0 = t1; t1 = s; }
  t0 = max(t0, 0.0);
  const float MAX_DIST = 14000.0;
  if (abs(dir.y) > 1e-4 && t1 > 0.0 && t0 < MAX_DIST) {
    t1 = min(t1, MAX_DIST);
    const int STEPS = 44;
    float dt = (t1 - t0) / float(STEPS);
    float t = t0 + dt * fract(ign(gl_FragCoord.xy) + uMisc.y * 0.618034);
    vec3 L = uLightDir.xyz;
    float mu = dot(dir, L);
    // Bright silver lining toward the light, a softer return away from it.
    float phase = mix(hg(mu, 0.72), hg(mu, -0.25), 0.4);
    vec3 lightColor = uLightColor.rgb * PI;
    vec3 amb = uAmbientSky.rgb;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = eye + dir * t;
      float d = cloudDensity(p, true);
      if (d > 0.0) {
        // March a short way toward the light for self-shadowing.
        float shade = 0.0;
        float stepL = 34.0;
        vec3 lp = p;
        for (int j = 0; j < 5; j++) {
          lp += L * stepL;
          shade += cloudDensity(lp, false) * stepL;
          stepL *= 1.45;
        }
        float h = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
        float beer = exp(-shade);
        // Light that scatters many times inside the cloud still gets out: a second, slower falloff.
        float energy = max(beer, 0.25 * exp(-shade * 0.22));
        float powder = 1.0 - exp(-d * dt * 2.0);
        vec3 lit = lightColor * energy * (phase * 4.0 + 0.16) * (0.5 + 0.5 * powder) * 0.9
                 + amb * (0.55 + 0.75 * h)
                 + vec3(1.0) * uWorld.w * 1.5 * uGrassTint.a;
        float a = 1.0 - exp(-d * dt);
        // Distant cloud fades into the air between here and there.
        float haze = 1.0 - exp(-t * 0.00011);
        vec3 c = mix(lit, texture(uSkyLut, skyLutUV(normalize(vec3(dir.x, max(dir.y, 0.02), dir.z)))).rgb, haze);
        sum += c * a * through;
        through *= 1.0 - a;
        if (through < 0.02) { through = 0.0; break; }
      }
      t += dt;
    }
  }
  vec4 now = vec4(sum, through);

  // Blend with last frame, looked up where this piece of sky was then.
  vec4 prev = uPrevViewProj * vec4(eye + dir * 6000.0, 1.0);
  vec2 puv = prev.xy / prev.w * 0.5 + 0.5;
  float valid = prev.w > 0.0 && puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0 ? 1.0 : 0.0;
  oColor = mix(now, texture(uHistory, puv), valid * (1.0 - uBlend));
}
`;
