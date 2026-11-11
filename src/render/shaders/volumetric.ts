// Light shafts: the key light scattered toward the eye by the mist and dust
// between the eye and what it sees. Each view ray is marched through the shadow
// cascades at half resolution; where trees, roofs or clouds shade the air it
// stays dark, so beams show. The air's density is the weather's fog (the same
// height falloff the distance fog uses) plus a little dust that is always there.

import { CLOUD_DENSITY } from './clouds';
import { COMMON, FRAME_BLOCK } from './common';
import { SHADOWS } from './lighting';

export const VOLUME_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${SHADOWS}
${CLOUD_DENSITY}
uniform sampler2D uDepth;
in vec2 vUV;
out vec4 oColor;

const int STEPS = 24;
const float RANGE = 160.0;
// Matches the height falloff of the distance fog in lighting.ts.
const float SCALE_HEIGHT = 55.0;

float litAt(vec3 p, float viewDist) {
  int c = viewDist < uShadowSplit.x ? 0 : viewDist < uShadowSplit.y ? 1 : viewDist < uShadowSplit.z ? 2 : 3;
  vec3 q = (uShadowMat[c] * vec4(p, 1.0)).xyz * 0.5 + 0.5;
  if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0 || q.z >= 1.0) return 1.0;
  return texture(uShadowMap, vec4(q.xy, float(c), q.z - 0.0006));
}

void main() {
  float depth = texture(uDepth, vUV).r;
  float z = linearDepth(depth);
  if (uMisc.x > 0.5) { oColor = vec4(0.0, 0.0, 0.0, z); return; }
  vec3 eye = uCameraPos.xyz;
  vec3 ray = worldFromDepth(vUV, depth) - eye;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-4);
  float reach = min(dist, min(uShadowSplit.w, RANGE));
  float dt = reach / float(STEPS);
  float t = dt * fract(ign(gl_FragCoord.xy) + uMisc.y * 0.618034);
  float sigma0 = uFog.a + 0.0005 + uWeather.x * 0.0007;
  // Cloud shadow changes slowly over the marched stretch: two lookups, blended along the ray.
  float cloud0 = cloudShadow(eye);
  float cloud1 = cloudShadow(eye + dir * reach);
  float through = 1.0;
  float scattered = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = eye + dir * t;
    float seg = sigma0 * exp(-max(p.y - uClip.z, 0.0) / SCALE_HEIGHT) * dt;
    float lit = mix(1.0, litAt(p, t), uLightDir.w) * mix(cloud0, cloud1, t / max(reach, 1e-3));
    float kept = exp(-seg);
    scattered += lit * through * (1.0 - kept);
    through *= kept;
    t += dt;
  }
  // Droplets throw most light forward, so shafts are brightest looking toward the light,
  // but an even share goes every way, which is what lets a beam be seen from the side.
  float mu = dot(dir, uLightDir.xyz);
  float g = 0.7;
  float forward = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  float phase = mix(1.0 / (4.0 * PI), forward, 0.5);
  oColor = vec4(uLightColor.rgb * PI * phase * scattered, z);
}
`;

/** Adds the half-resolution shafts to the scene. Taps are weighted by depth so a bright gap does not bleed onto the leaves in front of it. */
export const VOLUME_ADD_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
uniform sampler2D uVolume;
uniform sampler2D uDepth;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 oColor;
void main() {
  float z = linearDepth(texture(uDepth, vUV).r);
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -0.75 : 0.75, i < 2 ? -0.75 : 0.75);
    vec4 s = texture(uVolume, vUV + uTexel * o);
    float w = 1.0 / (0.03 + abs(s.a - z) / z);
    sum += s.rgb * w;
    weight += w;
  }
  oColor = vec4(sum / weight, 1.0);
}
`;
