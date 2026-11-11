// A physically based clear-sky model: Rayleigh and Mie scattering with ozone
// absorption around a spherical planet, integrated along the view ray with the
// planet's own shadow taken into account (which is what makes twilight).
//
// The same model runs twice. On the GPU it fills a small sky-view lookup each
// frame that the sky, fog and reflections sample. On the CPU it gives the
// colour of sunlight at the ground and the light arriving from the sky dome.
// The constants below feed both, so they cannot drift apart.

import type { Vec3 } from '../core/math';

const R_GROUND = 6360e3;
const R_TOP = 6460e3;
const RAYLEIGH: Vec3 = { x: 5.802e-6, y: 13.558e-6, z: 33.1e-6 };
const MIE_SCATTER = 3.996e-6;
const MIE_EXTINCT = 4.4e-6;
const OZONE: Vec3 = { x: 0.65e-6, y: 1.881e-6, z: 0.085e-6 };
const H_RAYLEIGH = 8000;
const H_MIE = 1200;
const MIE_G = 0.8;
/** Observer height above the ground sphere, in metres. */
const EYE = 300;
/** How much isotropically re-scattered light is added on top of single scattering. */
const MULTI = 0.65;

export const SUN_INTENSITY = 22;
/** Moonlight relative to sunlight at full moon. Far brighter than reality so nights stay readable. */
export const MOON_RATIO = 0.03;
/** Radiance of the twilight dome at the zenith per unit of `twilight()`. The ambient light uses the same colour. */
export const TWILIGHT_DOME: readonly [number, number, number] = [0.16, 0.19, 0.3];

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const v3 = (v: Vec3): string => `vec3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;

export const ATMOSPHERE_GLSL = /* glsl */ `
const vec3 TWILIGHT_DOME = vec3(${TWILIGHT_DOME.map(f).join(', ')});
const float R_GROUND = ${f(R_GROUND)};
const float R_TOP = ${f(R_TOP)};
const vec3 RAYLEIGH = ${v3(RAYLEIGH)};
const float MIE_SCATTER = ${f(MIE_SCATTER)};
const float MIE_EXTINCT = ${f(MIE_EXTINCT)};
const vec3 OZONE = ${v3(OZONE)};

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e12, -1e12);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
vec3 airDensity(float h) {
  return vec3(exp(-h / ${f(H_RAYLEIGH)}), exp(-h / ${f(H_MIE)}), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0));
}
vec3 airExtinction(vec3 od) {
  return RAYLEIGH * od.x + MIE_EXTINCT * od.y + OZONE * od.z;
}
vec3 depthToward(vec3 p, vec3 dir) {
  float t = raySphere(p, dir, R_TOP).y;
  float dt = t / 6.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    vec3 q = p + dir * (float(i) + 0.5) * dt;
    sum += airDensity(length(q) - R_GROUND) * dt;
  }
  return sum;
}
float phaseMie(float mu) {
  float g = ${f(MIE_G)};
  return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
}
// Radiance arriving along rd from one light of unit intensity; 'through' receives the view transmittance.
vec3 scatterFrom(vec3 rd, vec3 lightDir, out vec3 through) {
  vec3 ro = vec3(0.0, R_GROUND + ${f(EYE)}, 0.0);
  float tMax = raySphere(ro, rd, R_TOP).y;
  vec2 ground = raySphere(ro, rd, R_GROUND);
  if (ground.x > 0.0) tMax = min(tMax, ground.x);
  const int N = 18;
  float mu = dot(rd, lightDir);
  float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float pm = phaseMie(mu);
  vec3 od = vec3(0.0);
  vec3 sum = vec3(0.0);
  float prev = 0.0;
  for (int i = 0; i < N; i++) {
    // Samples bunch up near the eye, where density changes fastest along a low ray.
    float u = (float(i) + 0.5) / float(N);
    float t = tMax * u * u;
    float dt = t - prev;
    prev = t;
    vec3 p = ro + rd * t;
    vec3 d = airDensity(length(p) - R_GROUND) * dt;
    od += d;
    if (raySphere(p, lightDir, R_GROUND).x > 0.0) continue; // in the planet's shadow
    vec3 T = exp(-airExtinction(od + depthToward(p, lightDir)));
    vec3 scatter = RAYLEIGH * d.x * (pr + ${f(MULTI)} / (4.0 * PI)) + MIE_SCATTER * d.y * (pm + ${f(MULTI)} / (4.0 * PI));
    sum += T * scatter;
  }
  through = exp(-airExtinction(od));
  return sum;
}
// Sky-view lookup parameterisation: azimuth across, elevation up, squeezed toward the horizon.
vec3 skyLutDir(vec2 uv) {
  float az = uv.x * TAU;
  float v = uv.y * 2.0 - 1.0;
  float el = sign(v) * v * v * (PI * 0.5);
  return vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az));
}
vec2 skyLutUV(vec3 d) {
  float az = atan(d.x, d.z);
  float el = asin(clamp(d.y, -1.0, 1.0));
  return vec2(az / TAU, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (PI * 0.5)));
}
// Twilight: see twilight() on the CPU side, which this mirrors.
float twilight(float sunY) {
  return 0.42 * exp(-pow(max(0.06 - sunY, 0.0) * 9.5, 1.6)) * (1.0 - smoothstep(0.02, 0.22, sunY));
}
// What twilight adds to the sky in a direction: a blue dome, and a warm band low toward where the sun went down.
vec3 twilightSky(vec3 rd, vec3 sunDir) {
  float tw = twilight(sunDir.y);
  float toward = dot(normalize(rd.xz + vec2(1e-5)), normalize(sunDir.xz + vec2(1e-5))) * 0.5 + 0.5;
  float low = pow(1.0 - clamp(rd.y, 0.0, 1.0), 5.0);
  vec3 dome = TWILIGHT_DOME * (0.55 + 0.45 * clamp(rd.y, 0.0, 1.0));
  vec3 band = vec3(1.25, 0.5, 0.17) * low * pow(toward, 3.0) + vec3(0.36, 0.2, 0.26) * low * 0.4;
  return (dome + band) * tw;
}
`;

/**
 * How much glow the sky keeps around sunset and sunrise, by the height of the
 * sun (the y of its direction): 0 by day, about 0.4 with the sun on the
 * horizon, fading through dusk to nothing in full night. The atmosphere above
 * is single scattering, which gives out as soon as the sun is low; the real
 * sky stays lit by light scattered more than once, and this stands in for it.
 */
export function twilight(sunY: number): number {
  const t = Math.min(Math.max((sunY - 0.02) / 0.2, 0), 1);
  return 0.42 * Math.exp(-Math.pow(Math.max(0.06 - sunY, 0) * 9.5, 1.6)) * (1 - t * t * (3 - 2 * t));
}

// ---------------------------------------------------------------------------
// CPU side
// ---------------------------------------------------------------------------

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): [number, number] {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const d = b * b - c;
  if (d < 0) return [1e12, -1e12];
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}

function density(h: number): [number, number, number] {
  return [Math.exp(-h / H_RAYLEIGH), Math.exp(-h / H_MIE), Math.max(0, 1 - Math.abs(h - 25000) / 15000)];
}

function depthToward(px: number, py: number, pz: number, d: Vec3, steps: number): [number, number, number] {
  const t = raySphere(px, py, pz, d.x, d.y, d.z, R_TOP)[1];
  const dt = t / steps;
  let r = 0, m = 0, o = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt;
    const q = density(Math.hypot(px + d.x * s, py + d.y * s, pz + d.z * s) - R_GROUND);
    r += q[0] * dt;
    m += q[1] * dt;
    o += q[2] * dt;
  }
  return [r, m, o];
}

const transmit = (od: readonly [number, number, number]): Vec3 => ({
  x: Math.exp(-(RAYLEIGH.x * od[0] + MIE_EXTINCT * od[1] + OZONE.x * od[2])),
  y: Math.exp(-(RAYLEIGH.y * od[0] + MIE_EXTINCT * od[1] + OZONE.y * od[2])),
  z: Math.exp(-(RAYLEIGH.z * od[0] + MIE_EXTINCT * od[1] + OZONE.z * od[2])),
});

/** Fraction of a light's colour that survives the air on its way to the ground, per channel. */
export function transmittanceTo(dir: Vec3): Vec3 {
  if (raySphere(0, R_GROUND + EYE, 0, dir.x, dir.y, dir.z, R_GROUND)[0] > 0) return { x: 0, y: 0, z: 0 };
  return transmit(depthToward(0, R_GROUND + EYE, 0, dir, 24));
}

/** Sky radiance along `rd` for a light of unit intensity toward `light`: the CPU twin of scatterFrom. */
export function skyRadiance(rd: Vec3, light: Vec3): Vec3 {
  const oy = R_GROUND + EYE;
  let tMax = raySphere(0, oy, 0, rd.x, rd.y, rd.z, R_TOP)[1];
  const g = raySphere(0, oy, 0, rd.x, rd.y, rd.z, R_GROUND)[0];
  if (g > 0) tMax = Math.min(tMax, g);
  const N = 18;
  const mu = rd.x * light.x + rd.y * light.y + rd.z * light.z;
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu) + MULTI / (4 * Math.PI);
  const pm = (1 - MIE_G * MIE_G) / (4 * Math.PI * Math.pow(1 + MIE_G * MIE_G - 2 * MIE_G * mu, 1.5)) + MULTI / (4 * Math.PI);
  const od: [number, number, number] = [0, 0, 0];
  const sum = { x: 0, y: 0, z: 0 };
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    const t = tMax * u * u;
    const dt = t - prev;
    prev = t;
    const px = rd.x * t;
    const py = oy + rd.y * t;
    const pz = rd.z * t;
    const d = density(Math.hypot(px, py, pz) - R_GROUND);
    od[0] += d[0] * dt;
    od[1] += d[1] * dt;
    od[2] += d[2] * dt;
    if (raySphere(px, py, pz, light.x, light.y, light.z, R_GROUND)[0] > 0) continue;
    const s = depthToward(px, py, pz, light, 6);
    const T = transmit([od[0] + s[0], od[1] + s[1], od[2] + s[2]]);
    sum.x += T.x * (RAYLEIGH.x * d[0] * dt * pr + MIE_SCATTER * d[1] * dt * pm);
    sum.y += T.y * (RAYLEIGH.y * d[0] * dt * pr + MIE_SCATTER * d[1] * dt * pm);
    sum.z += T.z * (RAYLEIGH.z * d[0] * dt * pr + MIE_SCATTER * d[1] * dt * pm);
  }
  return sum;
}

const DOME: Vec3[] = (() => {
  // Zenith plus a ring at 25 degrees: enough to weight the bright horizon against the darker crown.
  const out: Vec3[] = [{ x: 0, y: 1, z: 0 }];
  const el = (25 * Math.PI) / 180;
  for (let i = 0; i < 6; i++) {
    const az = (i / 6) * Math.PI * 2;
    out.push({ x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: Math.cos(el) * Math.cos(az) });
  }
  return out;
})();

/** Mean radiance of the sky dome for a unit light: what open ground receives from above, over pi. */
export function domeRadiance(light: Vec3): Vec3 {
  const sum = { x: 0, y: 0, z: 0 };
  DOME.forEach((d, i) => {
    const w = i === 0 ? 0.3 : 0.7 / 6;
    const r = skyRadiance(d, light);
    sum.x += r.x * w;
    sum.y += r.y * w;
    sum.z += r.z * w;
  });
  return sum;
}
