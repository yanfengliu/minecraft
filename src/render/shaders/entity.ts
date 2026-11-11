// Instanced boxes for creatures and loose bodies: G-buffer output, or depth
// only for the shadow cascades (define SHADOW).

import { COMMON, FRAME_BLOCK } from './common';

export const ENTITY_VS = /* glsl */ `
${FRAME_BLOCK}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aRow0;
layout(location = 3) in vec4 aRow1;
layout(location = 4) in vec4 aRow2;
layout(location = 5) in vec4 aColor;
layout(location = 6) in vec2 aLight;
#ifdef SHADOW
uniform mat4 uLightViewProj;
#else
out vec3 vNormal;
out vec3 vTexel;
out vec4 vColor;
out vec2 vLight;
#endif
void main() {
  vec4 p = vec4(aPos, 1.0);
  vec3 world = vec3(dot(aRow0, p), dot(aRow1, p), dot(aRow2, p));
#ifdef SHADOW
  gl_Position = uLightViewProj * vec4(world, 1.0);
#else
  // A face normal of a box maps to the matching column of its transform, whatever the box's proportions.
  vNormal = vec3(dot(aRow0.xyz, aNormal), dot(aRow1.xyz, aNormal), dot(aRow2.xyz, aNormal));
  // Position across the box in sixteenths of a metre, so its surface can be grained like the block textures.
  vec3 size = vec3(length(vec3(aRow0.x, aRow1.x, aRow2.x)), length(vec3(aRow0.y, aRow1.y, aRow2.y)), length(vec3(aRow0.z, aRow1.z, aRow2.z))) * 16.0;
  vTexel = (aPos + 0.5) * size + vec3(aRow0.w, aRow1.w, aRow2.w) * 0.001;
  vColor = aColor;
  vLight = aLight;
  gl_Position = uViewProj * vec4(world, 1.0);
#endif
}
`;

export const ENTITY_SHADOW_FS = /* glsl */ `
void main() {}
`;

export const ENTITY_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
in vec3 vNormal;
in vec3 vTexel;
in vec4 vColor;
in vec2 vLight;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
layout(location = 2) out vec4 oLight;
void main() {
  // Each sixteenth-metre cell gets its own slight shade, like a texel of cloth, fur or feather.
  float grain = hash13(floor(vTexel + 0.001));
  vec3 albedo = vColor.rgb * (0.9 + 0.2 * grain);
  oAlbedo = vec4(albedo, vColor.a);
  oNormal = vec4(encodeNormal(normalize(vNormal)), 0.82, 0.0);
  oLight = vec4(vLight, 1.0, 0.0);
}
`;
