// Deferred lighting and the sky, in one full-screen pass over the G-buffer.
// Also holds the cascaded shadow lookup and the fog that every lit thing shares.

import { ATMOSPHERE_GLSL } from '../atmosphere';
import { COMMON, FRAME_BLOCK } from './common';

/** Cascaded shadow lookup. Needs uShadowMap, uShadowMat[4], uShadowSplit, uShadowTexel in scope. */
export const SHADOWS = /* glsl */ `
uniform sampler2DArrayShadow uShadowMap;
uniform mat4 uShadowMat[4];
uniform vec4 uShadowSplit;   // far view distance of each cascade
uniform vec4 uShadowTexel;   // world size of one texel in each cascade
uniform float uShadowRes;

float shadowTap(int c, vec3 world, vec3 n, float ndl, float spin) {
  float texel = uShadowTexel[c];
  // Push the lookup off the surface along its normal, further at grazing angles, to keep acne away without peter-panning.
  vec3 p = world + n * texel * (1.2 + 2.2 * (1.0 - ndl));
  vec3 q = (uShadowMat[c] * vec4(p, 1.0)).xyz * 0.5 + 0.5;
  if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0 || q.z >= 1.0) return 1.0;
  float radius = clamp(0.07 / texel, 1.1, 5.0) / uShadowRes;
  float sum = 0.0;
  for (int i = 0; i < 12; i++) {
    float r = sqrt((float(i) + 0.5) / 12.0);
    float a = float(i) * 2.39996323 + spin;
    sum += texture(uShadowMap, vec4(q.xy + vec2(cos(a), sin(a)) * r * radius, float(c), q.z - 0.00025));
  }
  return sum / 12.0;
}

float keyShadow(vec3 world, vec3 n, float ndl, float viewDist, vec2 px) {
  if (viewDist >= uShadowSplit.w) return 1.0;
  int c = viewDist < uShadowSplit.x ? 0 : viewDist < uShadowSplit.y ? 1 : viewDist < uShadowSplit.z ? 2 : 3;
  float spin = ign(px + 7.0 * uMisc.y) * TAU;
  float s = shadowTap(c, world, n, ndl, spin);
  float far = uShadowSplit[c];
  float t = smoothstep(far * 0.88, far, viewDist);
  if (t > 0.0) s = mix(s, c < 3 ? shadowTap(c + 1, world, n, ndl, spin) : 1.0, t);
  return s;
}
`;

/** Distance fog and aerial perspective. Needs uSkyLut in scope. */
export const FOG = /* glsl */ `
uniform sampler2D uSkyLut;

vec3 skyColor(vec3 dir) {
  return texture(uSkyLut, skyLutUV(dir)).rgb;
}
// Fraction of the scene's own light that is replaced by air light over 'dist' along a ray from the eye.
float fogAmount(vec3 eye, vec3 dir, float dist) {
  // Density falls off with height; integrate it in closed form along the ray.
  float h0 = eye.y - uClip.z;
  float k = 1.0 / 55.0;
  float dy = dir.y * dist;
  float integral = abs(dy) < 0.01 ? exp(-h0 * k) * dist : (exp(-h0 * k) - exp(-(h0 + dy) * k)) / (k * dir.y);
  return 1.0 - exp(-max(integral, 0.0) * uFog.a - dist * 0.00007);
}
vec3 fogColor(vec3 dir) {
  // The air takes the colour of the sky near the horizon in that direction, warmed toward the key light.
  vec3 flat_ = normalize(vec3(dir.x, abs(dir.y) * 0.25 + 0.03, dir.z));
  vec3 c = skyColor(flat_) * uFog.rgb;
  float toward = max(dot(dir, uLightDir.xyz), 0.0);
  return c + uLightColor.rgb * pow(toward, 8.0) * 0.35 * (1.0 - uWeather.w * 0.8);
}
vec3 applyFog(vec3 color, vec3 eye, vec3 world) {
  vec3 d = world - eye;
  float dist = length(d);
  vec3 dir = d / max(dist, 1e-4);
  if (uMisc.x > 0.5) {
    // Eye under water: everything fades into the colour of the water itself within a few metres.
    vec3 murk = vec3(0.025, 0.15, 0.19) * (uAmbientSky.rgb * 1.6 + uLightColor.rgb * 0.45);
    return mix(color * vec3(0.55, 0.85, 0.95), murk, 1.0 - exp(-dist * 0.085));
  }
  return mix(color, fogColor(dir), fogAmount(eye, dir, dist));
}
`;

export const LIGHTING_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${ATMOSPHERE_GLSL}
${SHADOWS}
${FOG}
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uLight;
uniform sampler2D uDepth;
uniform sampler2D uAO;
uniform sampler2D uClouds;

in vec2 vUV;
out vec4 oColor;

float distributionGGX(float ndh, float a) {
  float a2 = a * a;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float visibilitySmith(float ndv, float ndl, float a) {
  float k = a * 0.5;
  return 0.25 / ((ndv * (1.0 - k) + k) * (ndl * (1.0 - k) + k));
}

vec3 starField(vec3 dir) {
  // Turn the sky about the celestial pole once a day.
  float lat = radians(48.0);
  vec3 pole = vec3(0.0, sin(lat), -cos(lat));
  float ang = uMisc.z / 24.0 * TAU;
  vec3 d = dir * cos(ang) + cross(pole, dir) * sin(ang) + pole * dot(pole, dir) * (1.0 - cos(ang));
  vec3 p = d * 140.0;
  vec3 id = floor(p);
  float h = hash13(id);
  if (h < 0.972) return vec3(0.0);
  vec3 f = fract(p) - 0.5 - (vec3(hash13(id + 3.1), hash13(id + 7.7), hash13(id + 11.3)) - 0.5) * 0.6;
  float core = smoothstep(0.16, 0.0, length(f));
  float twinkle = 0.75 + 0.25 * sin(uCameraPos.w * (2.0 + 6.0 * hash13(id + 5.0)) + h * 80.0);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash13(id + 9.0));
  return tint * core * twinkle * (0.6 + 2.6 * pow((h - 0.972) / 0.028, 3.0));
}

vec3 renderSky(vec3 dir) {
  // Below the horizon there is only more sea, lost in haze: show the horizon's own colour.
  vec3 sky = skyColor(normalize(vec3(dir.x, max(dir.y, 0.004), dir.z)));
  float night = uWorld.z;
  // Sun disc with a soft limb.
  float sunCos = dot(dir, uSunDir.xyz);
  vec3 disc = vec3(1.0, 0.93, 0.82) * 220.0 * smoothstep(0.99993, 0.99996, sunCos) * uSunDir.w;
  // Moon: a lit sphere, so the terminator follows the sun. Drawn about twice life size so its phase reads.
  const float MOON_COS = 0.99985;
  vec3 md = uMoonDir.xyz;
  float moonCos = dot(dir, md);
  vec3 moon = vec3(0.0);
  if (moonCos > MOON_COS && md.y > -0.1) {
    vec3 right = normalize(cross(md, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, md);
    vec2 q = vec2(dot(dir, right), dot(dir, up)) / sqrt(1.0 - MOON_COS * MOON_COS);
    float r2 = dot(q, q);
    if (r2 < 1.0) {
      vec3 nrm = normalize(right * q.x + up * q.y - md * sqrt(1.0 - r2));
      float lit = smoothstep(-0.05, 0.25, dot(nrm, uSunDir.xyz));
      float maria = 0.72 + 0.28 * fbm2(q * 2.6 + 4.0);
      moon = vec3(0.92, 0.95, 1.0) * maria * (0.03 + lit) * 2.4 * smoothstep(-0.1, 0.05, md.y);
    }
  }
  vec3 stars = starField(dir) * night * smoothstep(-0.05, 0.2, dir.y) * (1.0 - uWeather.w);
  return sky + disc + moon + stars;
}

void main() {
  float depth = texture(uDepth, vUV).r;
  vec3 eye = uCameraPos.xyz;
  vec3 world = worldFromDepth(vUV, depth);
  vec3 toEye = eye - world;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-4);

  if (depth >= 1.0) {
    vec3 sky = renderSky(-V);
    vec4 cloud = texture(uClouds, vUV);
    oColor = vec4(sky * cloud.a + cloud.rgb, 1.0);
    return;
  }

  vec4 g0 = texture(uAlbedo, vUV);
  vec4 g1 = texture(uNormal, vUV);
  vec4 g2 = texture(uLight, vUV);
  vec3 albedo = g0.rgb;
  float emission = g0.a;
  vec3 N = decodeNormal(g1.rg);
  float rough = max(g1.b, 0.04);
  float sky = g2.r;
  float block = g2.g;
  float ao = g2.b;
  float foliage = g2.a;
  float ssao = texture(uAO, vUV).r;

  vec3 L = uLightDir.xyz;
  float ndl = dot(N, L);
  // Leaves and grass let some light through from behind instead of going black.
  float wrap = foliage * 0.35;
  float lambert = saturate((ndl + wrap) / (1.0 + wrap));
  float shadow = lambert > 0.0 ? keyShadow(world, N, saturate(ndl), dist, gl_FragCoord.xy) : 0.0;
  shadow = mix(1.0, shadow, uLightDir.w);

  float occl = mix(0.42, 1.0, ao) * ssao;
  float skyVis = sky * sky;

  // Key light.
  vec3 direct = uLightColor.rgb * lambert * shadow * mix(1.0, occl, 0.35);
  // Sky dome from above, ground bounce from below.
  float up = N.y * 0.5 + 0.5;
  vec3 ambient = mix(uAmbientGround.rgb, uAmbientSky.rgb, up) * skyVis * occl;
  // Torches and lanterns: warm, and warmer as they fade.
  float flicker = 0.94 + 0.06 * sin(uCameraPos.w * 9.0 + world.x * 0.7 + world.z * 0.9) * sin(uCameraPos.w * 5.3 + world.y);
  vec3 warm = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.72, 0.38), block);
  vec3 torch = warm * pow(block, 2.4) * 2.6 * flicker * mix(0.6, 1.0, occl);
  // Never quite black: a faint fill so deep caves and moonless nights keep their shapes.
  vec3 floor_ = vec3(0.012, 0.014, 0.02) * occl;

  vec3 color = albedo * (direct + ambient + torch + floor_);

  // Specular highlight of the key light.
  if (ndl > 0.0 && shadow > 0.0) {
    vec3 H = normalize(L + V);
    float ndv = max(dot(N, V), 1e-3);
    float ndh = saturate(dot(N, H));
    float a = rough * rough;
    float F = 0.04 + 0.96 * pow(1.0 - saturate(dot(V, H)), 5.0);
    color += uLightColor.rgb * PI * distributionGGX(ndh, a) * visibilitySmith(ndv, ndl, a) * F * ndl * shadow;
  }

  color += albedo * emission * 6.0;
  // A lightning stroke lights everything under open sky for an instant.
  color += albedo * uWorld.w * skyVis * (0.6 + 0.4 * up) * 3.0;

  oColor = vec4(applyFog(color, eye, world), 1.0);
}
`;

/** Fills the sky-view lookup: radiance of the clear sky for every direction, lit by sun and moon. */
export const SKY_LUT_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${ATMOSPHERE_GLSL}
uniform float uSunIntensity;
uniform float uMoonIntensity;
in vec2 vUV;
out vec4 oColor;
void main() {
  vec3 rd = skyLutDir(vUV);
  vec3 through;
  vec3 c = scatterFrom(rd, uSunDir.xyz, through) * uSunIntensity;
  if (uMoonIntensity > 0.0) c += scatterFrom(rd, uMoonDir.xyz, through) * uMoonIntensity;
  // Starlight and airglow: the sky is never fully black.
  c += vec3(0.0008, 0.0011, 0.002) * (0.4 + 0.6 * saturate(rd.y + 0.2));
  // Overcast flattens the sky toward the grey underside of the cloud deck.
  float cover = uWeather.w;
  float grey = luma(c);
  c = mix(c, vec3(grey) * vec3(0.92, 0.96, 1.0) * (0.75 - 0.3 * uMisc.w), cover * cover * 0.9);
  oColor = vec4(c, 1.0);
}
`;
