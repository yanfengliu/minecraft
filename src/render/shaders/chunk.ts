// Section geometry: decodes the packed vertex format (see src/mesh/mesher.ts)
// and writes the G-buffer, or just depth for the shadow cascades.
//
// Defines: CUTOUT (alpha-tested foliage and fittings), SHADOW (depth only).

import { COMMON, FACE_CODE, FRAME_BLOCK, TILE_SAMPLE, WIND } from './common';

export const CHUNK_VS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${WIND}
layout(location = 0) in uvec2 aData;
uniform vec3 uOrigin;
#ifdef SHADOW
uniform mat4 uLightViewProj;
#endif

out vec2 vUV;
flat out float vLayer;
#ifndef SHADOW
out vec3 vWorld;
out vec3 vLight;        // sky, block, ambient occlusion
flat out uint vBits;    // normal index | tint << 3 | uvMode << 5 | uvRot << 6
#endif

void main() {
  uint w0 = aData.x;
  uint w1 = aData.y;
  vec3 local = vec3(float(w0 & 1023u), float((w0 >> 10) & 1023u), float((w0 >> 20) & 1023u)) / 16.0;
  uint normalIndex = w1 & 7u;
  uint wind = (w1 >> 29) & 3u;
  bool uvMode = ((w1 >> 23) & 1u) == 1u;
  bool uvRot = ((w1 >> 26) & 1u) == 1u;

  vec3 world = uOrigin + local;
  if ((w1 >> 31) == 1u && wind != 0u) world += windOffset(world, wind);

  // Texture coordinates come from position, so a partial box shows the matching part of its tile.
  vec2 uv;
  if (uvMode) {
    uint corner = (w1 >> 24) & 3u;
    uv = vec2(float(corner & 1u), float(corner >> 1));
  } else if (normalIndex == 0u) uv = vec2(-local.z, -local.y);
  else if (normalIndex == 1u) uv = vec2(local.z, -local.y);
  else if (normalIndex == 2u) uv = vec2(local.x, local.z);
  else if (normalIndex == 3u) uv = vec2(local.x, -local.z);
  else if (normalIndex == 4u) uv = vec2(local.x, -local.y);
  else uv = vec2(-local.x, -local.y);
  if (uvRot) uv = vec2(uv.y, -uv.x);
  vUV = uv;
  vLayer = float((w1 >> 3) & 1023u);

#ifdef SHADOW
  gl_Position = uLightViewProj * vec4(world, 1.0);
#else
  vWorld = world;
  vLight = vec3(float((w1 >> 13) & 31u) / 30.0, float((w1 >> 18) & 31u) / 30.0, float(w0 >> 30) / 3.0);
  vBits = normalIndex | (((w1 >> 27) & 3u) << 3) | (uvMode ? 32u : 0u) | (uvRot ? 64u : 0u);
  gl_Position = uViewProj * vec4(world, 1.0);
#endif
}
`;

export const CHUNK_SHADOW_FS = /* glsl */ `
uniform sampler2DArray uTiles;
in vec2 vUV;
flat in float vLayer;
void main() {
#ifdef CUTOUT
  if (texture(uTiles, vec3(vUV, vLayer)).a < 0.4) discard;
#endif
}
`;

export const CHUNK_GBUFFER_FS = /* glsl */ `
${FRAME_BLOCK}
${COMMON}
${FACE_CODE}
${TILE_SAMPLE}
uniform sampler2DArray uTiles;
uniform sampler2DArray uTilesMat;
uniform uint uTurnMask;   // one bit per tile index below 32: may be turned at random per block

in vec2 vUV;
flat in float vLayer;
in vec3 vWorld;
in vec3 vLight;
flat in uint vBits;

layout(location = 0) out vec4 oAlbedo;   // rgb albedo, a emission
layout(location = 1) out vec4 oNormal;   // rg octahedral normal (with the tile's relief), b roughness, a material class
layout(location = 2) out vec4 oLight;    // r sky, g block, b ambient occlusion, a which face this is and whether it is foliage (FACE_CODE)

// Tangent (along +u) and bitangent (along +v, which runs down the tile) for each face.
const vec3 TANGENTS[6] = vec3[6](vec3(0, 0, -1), vec3(0, 0, 1), vec3(1, 0, 0), vec3(1, 0, 0), vec3(1, 0, 0), vec3(-1, 0, 0));
const vec3 BITANGENTS[6] = vec3[6](vec3(0, -1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1), vec3(0, -1, 0), vec3(0, -1, 0));

void main() {
  uint ni = vBits & 7u;
  uint tint = (vBits >> 3) & 3u;
  bool uvMode = (vBits & 32u) != 0u;
  bool uvRot = (vBits & 64u) != 0u;
  uint face = min(ni, 5u);
  vec3 n = FACE_NORMALS[face];

  vec2 uv = vUV;
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  // Natural ground is turned at random block by block, so a cliff or a beach does not show the tile repeating.
  int turn = 0;
  uint layer = uint(vLayer + 0.5);
  if (!uvMode && layer < 32u && ((uTurnMask >> layer) & 1u) == 1u) {
    turn = int(hash13(floor(vWorld - n * 0.5)) * 4.0);
    vec2 f = fract(uv) - 0.5;
    if (turn == 1) { f = vec2(-f.y, f.x); dx = vec2(-dx.y, dx.x); dy = vec2(-dy.y, dy.x); }
    else if (turn == 2) { f = -f; dx = -dx; dy = -dy; }
    else if (turn == 3) { f = vec2(f.y, -f.x); dx = vec2(dx.y, -dx.x); dy = vec2(dy.y, -dy.x); }
    uv = f + 0.5;
  }

  vec4 albedo = tileSampleGrad(uTiles, uv, vLayer, dx, dy);
#ifdef CUTOUT
  // Distant mips average alpha toward the tile's coverage; easing the threshold keeps foliage from thinning out.
  vec2 texel = vUV * 16.0;
  float lod = 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel))));
  if (albedo.a < 0.5 - 0.1 * clamp(lod, 0.0, 3.0)) discard;
#endif
  vec4 mat = tileSampleGrad(uTilesMat, uv, vLayer, dx, dy);

  if (!uvMode) {
    vec3 t = TANGENTS[face];
    vec3 b = BITANGENTS[face];
    if (uvRot) { vec3 t0 = t; t = b; b = -t0; }
    vec2 d = mat.rg * 2.0 - 1.0;
    // The relief turns with the tile.
    if (turn == 1) d = vec2(d.y, -d.x);
    else if (turn == 2) d = -d;
    else if (turn == 3) d = vec2(-d.y, d.x);
    // Relief fades with distance so far ground does not sparkle.
    float keep = 1.0 - smoothstep(40.0, 110.0, distance(vWorld, uCameraPos.xyz));
    n = normalize(n + (t * d.x + b * d.y) * keep);
  }
#ifdef CUTOUT
  // Seen from behind (the inside of a canopy), a face looks the other way; in the mesher's order that is the next index of the pair.
  if (!gl_FrontFacing && !uvMode) { n = -n; face ^= 1u; }
#endif
  // A plant's crossed cards are stored looking up, to be lit as the ground they grow from: that stored normal is the one to go by.
  if (uvMode) face = FACE_OWN;

  // Seasonal and regional tint lands only on the green parts of a tile, so soil and bark keep their colour.
  if (tint != 0u) {
    vec3 tc = tint == 1u ? uGrassTint.rgb : tint == 2u ? uFoliageTint.rgb : uBirchTint.rgb;
    float patchy = fbm2(vWorld.xz * 0.045);
    tc *= 0.86 + 0.3 * patchy;
    if (tint != 1u) tc = mix(tc, tc * vec3(1.12, 0.96, 0.8), smoothstep(0.55, 0.8, fbm2(vWorld.xz * 0.11 + 40.0)) * uFoliageTint.a);
    float green = saturate((albedo.g - max(albedo.r, albedo.b)) * 7.0);
    albedo.rgb = mix(albedo.rgb, albedo.rgb * tc, green);
  }

  oAlbedo = vec4(albedo.rgb, mat.a);
  oNormal = vec4(encodeNormal(n), mat.b, 0.0);
#ifdef CUTOUT
  oLight = vec4(vLight, packFace(face, true));
#else
  oLight = vec4(vLight, packFace(face, false));
#endif
}
`;
