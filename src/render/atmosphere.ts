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

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const v3 = (v: Vec3): string => `vec3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;

export const ATMOSPHERE_GLSL = /* glsl */ `
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
// True if a ray from p along dir runs into the ground: p is then in the planet's shadow for a light that way.
// A ray that misses the sphere altogether comes back from raySphere as (big, -big), which must not count.
bool hitsGround(vec3 p, vec3 dir) {
  vec2 t = raySphere(p, dir, R_GROUND);
  return t.x > 0.0 && t.x <= t.y;
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
  if (ground.x > 0.0 && ground.x <= ground.y) tMax = min(tMax, ground.x);
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
    if (hitsGround(p, lightDir)) continue; // in the planet's shadow
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
`;

// ---------------------------------------------------------------------------
// CPU side
// ---------------------------------------------------------------------------
//
// These integrals take a couple of thousand steps for one sky and are run from
// the frame, so nothing in them allocates: the helpers leave their answers in
// the variables just below, and the exported functions fill a vector the
// caller may hand in.

/** Where the last ray given to `raySphere` enters and leaves its sphere; (big, -big) if it misses. */
let nearT = 0;
let farT = 0;
/** What `depthToward` last found: the Rayleigh, Mie and ozone depth of the air along its ray. */
let depthR = 0;
let depthM = 0;
let depthO = 0;

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const d = b * b - c;
  if (d < 0) {
    nearT = 1e12;
    farT = -1e12;
    return;
  }
  const s = Math.sqrt(d);
  nearT = -b - s;
  farT = -b + s;
}

/** True if a ray runs into the ground. A ray that misses the sphere comes back from `raySphere` as (big, -big), which must not count. */
function hitsGround(px: number, py: number, pz: number, d: Vec3): boolean {
  raySphere(px, py, pz, d.x, d.y, d.z, R_GROUND);
  return nearT > 0 && nearT <= farT;
}

const rayleighAt = (h: number): number => Math.exp(-h / H_RAYLEIGH);
const mieAt = (h: number): number => Math.exp(-h / H_MIE);
const ozoneAt = (h: number): number => Math.max(0, 1 - Math.abs(h - 25000) / 15000);

function depthToward(px: number, py: number, pz: number, d: Vec3, steps: number): void {
  raySphere(px, py, pz, d.x, d.y, d.z, R_TOP);
  const dt = farT / steps;
  let r = 0, m = 0, o = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt;
    const h = Math.hypot(px + d.x * s, py + d.y * s, pz + d.z * s) - R_GROUND;
    r += rayleighAt(h) * dt;
    m += mieAt(h) * dt;
    o += ozoneAt(h) * dt;
  }
  depthR = r;
  depthM = m;
  depthO = o;
}

/** Fraction of a light's colour that survives the air on its way to the ground, per channel. Fills and returns `out`. */
export function transmittanceTo(dir: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  if (hitsGround(0, R_GROUND + EYE, 0, dir)) {
    out.x = out.y = out.z = 0;
    return out;
  }
  depthToward(0, R_GROUND + EYE, 0, dir, 24);
  out.x = Math.exp(-(RAYLEIGH.x * depthR + MIE_EXTINCT * depthM + OZONE.x * depthO));
  out.y = Math.exp(-(RAYLEIGH.y * depthR + MIE_EXTINCT * depthM + OZONE.y * depthO));
  out.z = Math.exp(-(RAYLEIGH.z * depthR + MIE_EXTINCT * depthM + OZONE.z * depthO));
  return out;
}

/** Sky radiance along `rd` for a light of unit intensity toward `light`: the CPU twin of scatterFrom. Fills and returns `out`. */
export function skyRadiance(rd: Vec3, light: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const oy = R_GROUND + EYE;
  raySphere(0, oy, 0, rd.x, rd.y, rd.z, R_TOP);
  let tMax = farT;
  raySphere(0, oy, 0, rd.x, rd.y, rd.z, R_GROUND);
  if (nearT > 0 && nearT <= farT) tMax = Math.min(tMax, nearT);
  const N = 18;
  const mu = rd.x * light.x + rd.y * light.y + rd.z * light.z;
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu) + MULTI / (4 * Math.PI);
  const pm = (1 - MIE_G * MIE_G) / (4 * Math.PI * Math.pow(1 + MIE_G * MIE_G - 2 * MIE_G * mu, 1.5)) + MULTI / (4 * Math.PI);
  let odR = 0, odM = 0, odO = 0;
  let sx = 0, sy = 0, sz = 0;
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    const t = tMax * u * u;
    const dt = t - prev;
    prev = t;
    const px = rd.x * t;
    const py = oy + rd.y * t;
    const pz = rd.z * t;
    const h = Math.hypot(px, py, pz) - R_GROUND;
    const dR = rayleighAt(h);
    const dM = mieAt(h);
    odR += dR * dt;
    odM += dM * dt;
    odO += ozoneAt(h) * dt;
    if (hitsGround(px, py, pz, light)) continue; // in the planet's shadow
    depthToward(px, py, pz, light, 6);
    const r = odR + depthR;
    const m = odM + depthM;
    const o = odO + depthO;
    sx += Math.exp(-(RAYLEIGH.x * r + MIE_EXTINCT * m + OZONE.x * o)) * (RAYLEIGH.x * dR * dt * pr + MIE_SCATTER * dM * dt * pm);
    sy += Math.exp(-(RAYLEIGH.y * r + MIE_EXTINCT * m + OZONE.y * o)) * (RAYLEIGH.y * dR * dt * pr + MIE_SCATTER * dM * dt * pm);
    sz += Math.exp(-(RAYLEIGH.z * r + MIE_EXTINCT * m + OZONE.z * o)) * (RAYLEIGH.z * dR * dt * pr + MIE_SCATTER * dM * dt * pm);
  }
  out.x = sx;
  out.y = sy;
  out.z = sz;
  return out;
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
const domeSample: Vec3 = { x: 0, y: 0, z: 0 };

/** Mean radiance of the sky dome for a unit light: what open ground receives from above, over pi. Fills and returns `out`. */
export function domeRadiance(light: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < DOME.length; i++) {
    const w = i === 0 ? 0.3 : 0.7 / 6;
    const r = skyRadiance(DOME[i] as Vec3, light, domeSample);
    x += r.x * w;
    y += r.y * w;
    z += r.z * w;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * What the air does to one light, the sun or the moon: how much of its colour
 * reaches the ground, and the sky dome it lights. Both are integrals through
 * the atmosphere, some two thousand samples between them, and both depend only
 * on where the light stands. It moves when the clock does: ten times a second
 * in play, not at all while the game is paused, never between two frames of
 * one step. So the answers are kept, and worked out again only when it has moved.
 */
export class AirLight {
  /** Fraction of the light's colour that survives the air on its way to the ground (see `transmittanceTo`). */
  readonly through: Vec3 = { x: 0, y: 0, z: 0 };
  /** Mean radiance of the sky dome for unit intensity (see `domeRadiance`). */
  readonly dome: Vec3 = { x: 0, y: 0, z: 0 };
  /** How many times the integrals have been worked out. */
  integrations = 0;
  private x = NaN;
  private y = NaN;
  private z = NaN;

  /** Bring `through` and `dome` up to date for a light toward `dir`. */
  toward(dir: Vec3): this {
    if (dir.x !== this.x || dir.y !== this.y || dir.z !== this.z) {
      this.x = dir.x;
      this.y = dir.y;
      this.z = dir.z;
      transmittanceTo(dir, this.through);
      domeRadiance(dir, this.dome);
      this.integrations++;
    }
    return this;
  }
}
