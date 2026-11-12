// The frame: shadow cascades, G-buffer, ambient occlusion, deferred lighting
// with the sky, then bloom, tone mapping and antialiasing. Each pass sets the
// GL state it relies on.

import type { MeshOutput } from '../mesh/mesher';
import { tileIndex } from '../world/tiles';
import type { World } from '../world/world';
import { Drift } from './drift';
import { EntityRenderer } from './entities/renderer';
import type { Environment } from './environment';
import { FrameUniforms } from './frame';
import { OCEAN_VERTICES, bakeCloudNoise, oceanSkirt, outlineBox, particleQuad } from './geometry';
import { FULLSCREEN_VS, type GL, Program, type Target, bindTarget, createTarget, createTexture, drawFullscreen, requireExtensions } from './gl';
import { type Mat4, frustumPlanes, invert, lookDir, mat4, multiply, perspective } from './mat4';
import { PostChain } from './postChain';
import { type SectionMesh, SectionStore } from './sectionStore';
import { CASCADES, type CameraFrame, ShadowCascades } from './shadows';
import { CHUNK_GBUFFER_FS, CHUNK_SHADOW_FS, CHUNK_VS } from './shaders/chunk';
import { CLOUDS_FS } from './shaders/clouds';
import { ENTITY_FS, ENTITY_SHADOW_FS, ENTITY_VS } from './shaders/entity';
import { LIGHTING_FS, SKY_LUT_FS } from './shaders/lighting';
import { OVERLAY_FS, OVERLAY_VS } from './shaders/overlay';
import { PRECIP_FS, PRECIP_VS } from './shaders/precip';
import { SSAO_BLUR_FS, SSAO_FS } from './shaders/post';
import { VOLUME_ADD_FS, VOLUME_FS } from './shaders/volumetric';
import { WATER_FS, WATER_VS } from './shaders/water';
import { FrameTargets } from './targets';
import { type TileSet, buildTileSet } from './tiles';

export interface Camera {
  x: number;
  y: number;
  z: number;
  /** Radians; 0 looks toward +z, positive turns toward +x. */
  yaw: number;
  /** Radians; positive looks up. */
  pitch: number;
  /** Vertical field of view in radians. */
  fov: number;
}

export interface RenderSettings {
  /** Internal resolution as a fraction of the canvas's device pixels. */
  scale: number;
  viewDistance: number;
  shadowDistance: number;
  shadowResolution: number;
  /**
   * The widest vertical field of view the camera will use, in radians. The shadow cascades are sized
   * for it, so that a field of view which changes in play (it widens for a sprint) does not rescale
   * them frame by frame. Keep it at or above the widest `Camera.fov` the game sets.
   */
  widestFov: number;
  ssao: boolean;
  /** Light shafts through the air. */
  shafts: boolean;
  bloom: boolean;
  fxaa: boolean;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  scale: 1,
  viewDistance: 640,
  shadowDistance: 220,
  shadowResolution: 2048,
  // 72 degrees at rest and 6 more at a full sprint: what game.ts gives the camera.
  widestFov: (78 * Math.PI) / 180,
  ssao: true,
  shafts: true,
  bloom: true,
  fxaa: true,
};

export interface FrameInfo {
  /** Seconds since start, for animation. */
  time: number;
  /** Hour of the simulated day, for the star field. */
  hour: number;
  wind: { x: number; z: number; strength: number };
  weather: { wetness: number; snow: number; rain: number; cloud: number; storm: number; snowing: boolean };
  underwater: boolean;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  sections: number;
  visible: number;
  shadowDraws: number;
  width: number;
  height: number;
  meshBytes: number;
}

const NEAR = 0.1;
const FAR = 3000;

/** Tiles with no grain or direction, which the shader may turn at random per block to hide repetition. */
const TURN_MASK = (['grass_top', 'dirt', 'forest_floor', 'stone', 'granite', 'gravel', 'sand', 'snow', 'bedrock', 'coal_ore', 'iron_ore', 'path_top'] as const)
  .reduce((mask, name) => {
    const i = tileIndex(name);
    if (i >= 32) throw new Error(`tile ${name} must sit in the first 32 to be turnable`);
    return mask | (1 << i);
  }, 0);

export class Renderer {
  readonly gl: GL;
  readonly canvas: HTMLCanvasElement;
  readonly sections: SectionStore;
  readonly settings: RenderSettings;
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, sections: 0, visible: 0, shadowDraws: 0, width: 0, height: 0, meshBytes: 0 };
  readonly frame: FrameUniforms;
  /** The painted tiles, kept for the interface's item icons. */
  readonly tileSet: TileSet;

  private readonly world: World;
  private readonly shadows: ShadowCascades;
  private readonly tiles: WebGLTexture;
  private readonly tilesMat: WebGLTexture;
  private readonly white: WebGLTexture;
  private readonly noCloud: WebGLTexture;
  private readonly skyLut: Target;

  private readonly pGbuffer: Program;
  private readonly pGbufferCutout: Program;
  private readonly pShadow: Program;
  private readonly pShadowCutout: Program;
  private readonly pLighting: Program;
  private readonly pSkyLut: Program;
  private readonly pSsao: Program;
  private readonly pSsaoBlur: Program;
  private readonly post: PostChain;
  private readonly pWater: Program;
  private readonly pOcean: Program;
  private readonly oceanVao: WebGLVertexArrayObject;
  private readonly pOverlay: Program;
  private readonly overlayVao: WebGLVertexArrayObject;
  private readonly pClouds: Program;
  private readonly cloudNoise: WebGLTexture;
  /** Which of the two cloud buffers is this frame's; the other holds last frame's. */
  private cloudFlip = 0;
  private cloudFresh = true;
  private readonly prevViewProj: Mat4 = mat4();
  private readonly pVolume: Program;
  private readonly pVolumeAdd: Program;
  /** Creatures and loose bodies: fill it between `begin()` and `finish()` each frame, before `render`. */
  readonly entities: EntityRenderer;
  private readonly pEntity: Program;
  private readonly pEntityShadow: Program;
  private readonly pPrecip: Program;
  private readonly pSplash: Program;
  private readonly quadVao: WebGLVertexArrayObject;
  /** Per column, the height below which rain cannot fall: the world's rain heightmap as a texture. */
  private readonly heightTex: WebGLTexture;
  /** Set when blocks changed; the height texture is refreshed a few times a second at most. */
  heightsDirty = false;
  private heightsAge = 0;
  /** The block to outline (world-space box) and how far along breaking it is, or null. */
  selection: { box: number[]; progress: number } | null = null;

  private readonly targets: FrameTargets;
  private readonly drift = new Drift();

  private readonly view: Mat4 = mat4();
  private readonly proj: Mat4 = mat4();
  private readonly viewProj: Mat4 = mat4();
  private readonly invViewProj: Mat4 = mat4();
  private readonly invProj: Mat4 = mat4();
  private readonly planes = new Float32Array(24);
  private readonly visible: SectionMesh[] = [];
  private readonly casters: SectionMesh[] = [];
  private frameIndex = 0;
  private lastKey = { x: 0, y: 0, z: 0 };

  constructor(canvas: HTMLCanvasElement, world: World, settings: RenderSettings = DEFAULT_SETTINGS) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    requireExtensions(gl);
    this.gl = gl;
    this.canvas = canvas;
    this.world = world;
    this.settings = { ...settings };
    this.frame = new FrameUniforms(gl);
    this.sections = new SectionStore(gl, world);
    this.shadows = new ShadowCascades(gl, this.settings.shadowResolution, this.settings.shadowDistance, this.settings.widestFov);

    const set = buildTileSet();
    this.tileSet = set;
    // Linear magnification on purpose: tileSample in the shaders rebuilds crisp texels from it.
    const layered = (data: Uint8Array, internalFormat: number): WebGLTexture => createTexture(gl, {
      target: gl.TEXTURE_2D_ARRAY, width: set.size, height: set.size, depth: set.count,
      internalFormat, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data,
      min: gl.LINEAR_MIPMAP_LINEAR, mag: gl.LINEAR, wrap: gl.REPEAT, mips: true, anisotropy: 8,
    });
    this.tiles = layered(set.albedo, gl.SRGB8_ALPHA8);
    this.tilesMat = layered(set.material, gl.RGBA8);
    const pixel = (r: number, g: number, b: number, a: number): WebGLTexture => createTexture(gl, {
      width: 1, height: 1, internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: new Uint8Array([r, g, b, a]),
      min: gl.NEAREST, mag: gl.NEAREST,
    });
    this.white = pixel(255, 255, 255, 255);
    this.noCloud = pixel(0, 0, 0, 255);
    const lut = createTexture(gl, { width: 192, height: 108, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    this.skyLut = createTarget(gl, 192, 108, [lut]);

    this.pGbuffer = new Program(gl, 'gbuffer', CHUNK_VS, CHUNK_GBUFFER_FS);
    this.pGbufferCutout = new Program(gl, 'gbuffer-cutout', CHUNK_VS, CHUNK_GBUFFER_FS, { CUTOUT: true });
    this.pShadow = new Program(gl, 'shadow', CHUNK_VS, CHUNK_SHADOW_FS, { SHADOW: true });
    this.pShadowCutout = new Program(gl, 'shadow-cutout', CHUNK_VS, CHUNK_SHADOW_FS, { SHADOW: true, CUTOUT: true });
    this.pLighting = new Program(gl, 'lighting', FULLSCREEN_VS, LIGHTING_FS);
    this.pSkyLut = new Program(gl, 'sky-lut', FULLSCREEN_VS, SKY_LUT_FS);
    this.pSsao = new Program(gl, 'ssao', FULLSCREEN_VS, SSAO_FS);
    this.pSsaoBlur = new Program(gl, 'ssao-blur', FULLSCREEN_VS, SSAO_BLUR_FS);
    this.post = new PostChain(gl);
    this.targets = new FrameTargets(gl);
    this.pWater = new Program(gl, 'water', WATER_VS, WATER_FS);
    this.pOcean = new Program(gl, 'ocean', WATER_VS, WATER_FS, { OCEAN: true });
    this.oceanVao = oceanSkirt(gl, world);
    this.pClouds = new Program(gl, 'clouds', FULLSCREEN_VS, CLOUDS_FS);
    this.cloudNoise = bakeCloudNoise(gl);
    this.pPrecip = new Program(gl, 'precip', PRECIP_VS, PRECIP_FS);
    this.pSplash = new Program(gl, 'splash', PRECIP_VS, PRECIP_FS, { SPLASH: true });
    this.quadVao = particleQuad(gl);
    this.heightTex = createTexture(gl, {
      width: world.sx, height: world.sz, internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, data: world.heightmap,
      min: gl.NEAREST, mag: gl.NEAREST,
    });

    this.pVolume = new Program(gl, 'volume', FULLSCREEN_VS, VOLUME_FS);
    this.pVolumeAdd = new Program(gl, 'volume-add', FULLSCREEN_VS, VOLUME_ADD_FS);
    this.entities = new EntityRenderer(gl);
    this.pEntity = new Program(gl, 'entity', ENTITY_VS, ENTITY_FS);
    this.pEntityShadow = new Program(gl, 'entity-shadow', ENTITY_VS, ENTITY_SHADOW_FS, { SHADOW: true });

    this.pOverlay = new Program(gl, 'overlay', OVERLAY_VS, OVERLAY_FS);
    this.overlayVao = outlineBox(gl);
  }

  setMesh(section: number, mesh: MeshOutput | null): void {
    this.sections.set(section, mesh);
  }

  /**
   * Where a world point falls on screen as of the last frame: x and y in 0..1
   * from the top left, and its distance along the view. Null if behind the eye.
   */
  project(x: number, y: number, z: number): { x: number; y: number; depth: number } | null {
    const m = this.viewProj;
    const w = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
    if (w <= 0.05) return null;
    const cx = ((m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number)) / w;
    const cy = ((m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)) / w;
    if (Math.abs(cx) > 1.1 || Math.abs(cy) > 1.1) return null;
    return { x: cx * 0.5 + 0.5, y: 0.5 - cy * 0.5, depth: w };
  }

  /** Match the internal targets to the canvas. Cheap when nothing changed. */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const ch = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const w = Math.max(2, Math.round(cw * this.settings.scale));
    const h = Math.max(2, Math.round(ch * this.settings.scale));
    // New cloud buffers hold no history to blend with.
    if (this.targets.resize(w, h)) this.cloudFresh = true;
  }

  render(cam: Camera, env: Environment, info: FrameInfo): void {
    const gl = this.gl;
    this.resize();
    const { gbuffer, hdr, ao, width: w, height: h } = this.targets;
    const stats = this.stats;
    stats.drawCalls = 0;
    stats.triangles = 0;
    stats.shadowDraws = 0;
    stats.width = w;
    stats.height = h;
    stats.sections = this.sections.count;
    stats.meshBytes = this.sections.bytes;
    this.frameIndex++;

    // --- camera -------------------------------------------------------------
    const cp = Math.cos(cam.pitch);
    const fx = Math.sin(cam.yaw) * cp;
    const fy = Math.sin(cam.pitch);
    const fz = Math.cos(cam.yaw) * cp;
    const aspect = w / h;
    lookDir(this.view, cam.x, cam.y, cam.z, fx, fy, fz);
    perspective(this.proj, cam.fov, aspect, NEAR, FAR);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
    invert(this.invProj, this.proj);
    frustumPlanes(this.viewProj, this.planes);
    const view = this.view;
    const frame: CameraFrame = {
      x: cam.x, y: cam.y, z: cam.z, fx, fy, fz,
      rx: view[0] as number, ry: view[4] as number, rz: view[8] as number,
      ux: view[1] as number, uy: view[5] as number, uz: view[9] as number,
      tanHalfFovY: Math.tan(cam.fov / 2), aspect,
    };

    // --- frame uniforms -----------------------------------------------------
    const u = this.frame;
    u.mat('view', this.view);
    u.mat('proj', this.proj);
    u.mat('viewProj', this.viewProj);
    u.mat('invViewProj', this.invViewProj);
    u.mat('invProj', this.invProj);
    u.vec('cameraPos', cam.x, cam.y, cam.z, info.time);
    u.vec('lightDir', env.keyDir.x, env.keyDir.y, env.keyDir.z, env.shadowStrength);
    u.vec('lightColor', env.keyColor[0], env.keyColor[1], env.keyColor[2]);
    u.vec('sunDir', env.sunDir.x, env.sunDir.y, env.sunDir.z, env.sunVisible);
    u.vec('moonDir', env.moonDir.x, env.moonDir.y, env.moonDir.z, env.moonLit);
    u.vec('ambientSky', env.ambientSky[0], env.ambientSky[1], env.ambientSky[2]);
    u.vec('ambientGround', env.ambientGround[0], env.ambientGround[1], env.ambientGround[2]);
    u.vec('fog', 1, 1, 1, env.fogDensity);
    const drift = this.drift;
    drift.advance(info.time, info.wind.x, info.wind.z);
    u.vec('wind', info.wind.x, info.wind.z, info.wind.strength, drift.gust);
    u.vec('drift', drift.cloudX, drift.cloudZ, drift.clock);
    u.vec('weather', info.weather.wetness, info.weather.snow, info.weather.rain, info.weather.cloud);
    u.vec('screen', w, h, 1 / w, 1 / h);
    u.vec('clip', NEAR, FAR, this.world.seaLevel - 1 + 15 / 16, env.exposure);
    u.vec('grassTint', env.grassTint[0], env.grassTint[1], env.grassTint[2], env.preExposure);
    u.vec('foliageTint', env.foliageTint[0], env.foliageTint[1], env.foliageTint[2], env.autumn);
    u.vec('birchTint', env.birchTint[0], env.birchTint[1], env.birchTint[2]);
    u.vec('world', this.world.sx, this.world.sz, env.night, env.flash);
    u.vec('misc', info.underwater ? 1 : 0, this.frameIndex % 64, info.hour, info.weather.storm);
    u.upload();

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);

    // --- sky lookup ---------------------------------------------------------
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    bindTarget(gl, this.skyLut);
    this.pSkyLut.use().f('uSunIntensity', env.sunIntensity).f('uMoonIntensity', env.moonDir.y > -0.2 ? env.moonIntensity : 0);
    drawFullscreen(gl);

    // --- rain heightmap -----------------------------------------------------
    if (this.heightsDirty && this.frameIndex - this.heightsAge > 15) {
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.world.sx, this.world.sz, gl.RED, gl.UNSIGNED_BYTE, this.world.heightmap);
      this.heightsDirty = false;
      this.heightsAge = this.frameIndex;
    }

    // --- clouds -------------------------------------------------------------
    const clouds = this.targets.clouds;
    this.cloudFlip ^= 1;
    const cloudNow = clouds[this.cloudFlip] as Target;
    const cloudPrev = clouds[this.cloudFlip ^ 1] as Target;
    bindTarget(gl, cloudNow);
    this.pClouds.use()
      .tex('uCloudNoise', 0, gl.TEXTURE_3D, this.cloudNoise)
      .tex('uSkyLut', 1, gl.TEXTURE_2D, this.skyLut.colors[0] as WebGLTexture)
      .tex('uHistory', 2, gl.TEXTURE_2D, cloudPrev.colors[0] as WebGLTexture)
      .m4('uPrevViewProj', this.prevViewProj)
      .f('uBlend', this.cloudFresh ? 1 : 0.14);
    drawFullscreen(gl);
    this.cloudFresh = false;
    this.prevViewProj.set(this.viewProj);

    // --- shadow cascades ----------------------------------------------------
    const k = env.keyDir;
    const jumped = Math.abs(k.x - this.lastKey.x) + Math.abs(k.y - this.lastKey.y) + Math.abs(k.z - this.lastKey.z) > 0.05;
    this.lastKey = { x: k.x, y: k.y, z: k.z };
    const mask = env.shadowStrength > 0 ? this.shadows.update(frame, k.x, k.y, k.z, this.frameIndex <= 1 || jumped) : 0;
    if (mask) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.colorMask(false, false, false, false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 3);
      for (let i = 0; i < CASCADES; i++) {
        if (!(mask & (1 << i))) continue;
        const planes = this.shadows.planes[i] as Float32Array;
        this.sections.collect(planes, cam.x, cam.y, cam.z, this.settings.shadowDistance + 320, this.casters);
        bindTarget(gl, this.shadows.targets[i] as Target);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const m = this.shadows.matrices.subarray(i * 16, i * 16 + 16);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        this.pShadow.use().m4('uLightViewProj', m);
        stats.shadowDraws += this.sections.draw(this.casters, 0, this.pShadow.loc('uOrigin')) > 0 ? this.casters.length : 0;
        gl.disable(gl.CULL_FACE);
        this.pShadowCutout.use().m4('uLightViewProj', m).tex('uTiles', 0, gl.TEXTURE_2D_ARRAY, this.tiles);
        this.sections.draw(this.casters, 1, this.pShadowCutout.loc('uOrigin'));
        // Creatures cast shadows in all but the far cascade, where they would be smaller than a texel.
        if (i < 3 && this.entities.count > 0) {
          this.pEntityShadow.use().m4('uLightViewProj', m);
          this.entities.draw();
        }
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.colorMask(true, true, true, true);
    }

    // --- G-buffer -----------------------------------------------------------
    this.sections.collect(this.planes, cam.x, cam.y, cam.z, this.settings.viewDistance, this.visible);
    stats.visible = this.visible.length;
    bindTarget(gl, gbuffer);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.pGbuffer.use().tex('uTiles', 0, gl.TEXTURE_2D_ARRAY, this.tiles).tex('uTilesMat', 1, gl.TEXTURE_2D_ARRAY, this.tilesMat).ui('uTurnMask', TURN_MASK);
    let quads = this.sections.draw(this.visible, 0, this.pGbuffer.loc('uOrigin'));
    gl.disable(gl.CULL_FACE);
    this.pGbufferCutout.use().tex('uTiles', 0, gl.TEXTURE_2D_ARRAY, this.tiles).tex('uTilesMat', 1, gl.TEXTURE_2D_ARRAY, this.tilesMat).ui('uTurnMask', 0);
    quads += this.sections.draw(this.visible, 1, this.pGbufferCutout.loc('uOrigin'));
    stats.triangles += quads * 2;
    stats.drawCalls += this.visible.length * 2;
    // Creatures and loose bodies.
    if (this.entities.count > 0) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      this.pEntity.use().tex('uTiles', 0, gl.TEXTURE_2D_ARRAY, this.tiles);
      this.entities.draw();
      stats.triangles += this.entities.count * 12;
      stats.drawCalls++;
    }

    // --- ambient occlusion --------------------------------------------------
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    let aoTex = this.white;
    if (this.settings.ssao) {
      bindTarget(gl, ao[0]);
      this.pSsao.use().tex('uDepth', 0, gl.TEXTURE_2D, gbuffer.depth);
      drawFullscreen(gl);
      bindTarget(gl, ao[1]);
      this.pSsaoBlur.use().tex('uSource', 0, gl.TEXTURE_2D, ao[0].colors[0] as WebGLTexture).f2('uStep', 1 / ao[0].width, 0);
      drawFullscreen(gl);
      bindTarget(gl, ao[0]);
      this.pSsaoBlur.use().tex('uSource', 0, gl.TEXTURE_2D, ao[1].colors[0] as WebGLTexture).f2('uStep', 0, 1 / ao[0].height);
      drawFullscreen(gl);
      aoTex = ao[0].colors[0] as WebGLTexture;
    }

    // --- lighting and sky ---------------------------------------------------
    bindTarget(gl, hdr);
    const p = this.pLighting.use();
    p.tex('uAlbedo', 0, gl.TEXTURE_2D, gbuffer.colors[0] as WebGLTexture);
    p.tex('uNormal', 1, gl.TEXTURE_2D, gbuffer.colors[1] as WebGLTexture);
    p.tex('uLight', 2, gl.TEXTURE_2D, gbuffer.colors[2] as WebGLTexture);
    p.tex('uDepth', 3, gl.TEXTURE_2D, gbuffer.depth);
    p.tex('uAO', 4, gl.TEXTURE_2D, aoTex);
    p.tex('uClouds', 5, gl.TEXTURE_2D, cloudNow.colors[0] as WebGLTexture);
    p.tex('uCloudNoise', 8, gl.TEXTURE_3D, this.cloudNoise);
    p.tex('uHeightTex', 9, gl.TEXTURE_2D, this.heightTex);
    p.tex('uSkyLut', 6, gl.TEXTURE_2D, this.skyLut.colors[0] as WebGLTexture);
    p.tex('uShadowMap', 7, gl.TEXTURE_2D_ARRAY, this.shadows.texture);
    gl.uniformMatrix4fv(p.loc('uShadowMat'), false, this.shadows.matrices);
    p.f4v('uShadowSplit', this.shadows.splits).f4v('uShadowTexel', this.shadows.texel).f('uShadowRes', this.shadows.res);
    drawFullscreen(gl);

    // --- water and glass ----------------------------------------------------
    const { hdrCopy, forward } = this.targets;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, hdr.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdrCopy.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gbuffer.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, forward.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    bindTarget(gl, forward);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Water first, writing depth, so that of two sheets of water one behind the other only the nearer
    // is seen. Glass afterwards without writing depth: within a section its faces come in mesh order,
    // not by distance, and a pane that wrote depth would hide the window behind it from one side.
    for (const prog of [this.pOcean, this.pWater]) {
      prog.use().f('uGlassPass', 0);
      prog.tex('uScene', 0, gl.TEXTURE_2D, hdrCopy.colors[0] as WebGLTexture);
      prog.tex('uDepth', 1, gl.TEXTURE_2D, gbuffer.depth);
      prog.tex('uTiles', 2, gl.TEXTURE_2D_ARRAY, this.tiles);
      prog.tex('uSkyLut', 6, gl.TEXTURE_2D, this.skyLut.colors[0] as WebGLTexture);
      prog.tex('uShadowMap', 7, gl.TEXTURE_2D_ARRAY, this.shadows.texture);
      prog.tex('uCloudNoise', 8, gl.TEXTURE_3D, this.cloudNoise);
      prog.tex('uHeightTex', 9, gl.TEXTURE_2D, this.heightTex);
      gl.uniformMatrix4fv(prog.loc('uShadowMat'), false, this.shadows.matrices);
      prog.f4v('uShadowSplit', this.shadows.splits).f4v('uShadowTexel', this.shadows.texel).f('uShadowRes', this.shadows.res);
      if (prog === this.pOcean) {
        gl.bindVertexArray(this.oceanVao);
        gl.drawArrays(gl.TRIANGLES, 0, OCEAN_VERTICES);
        stats.drawCalls++;
      } else {
        // Farthest first, so nearer water blends over what lies behind it.
        const drawn = this.sections.draw(this.visible, 2, prog.loc('uOrigin'), true);
        stats.triangles += drawn * 2;
      }
    }
    gl.depthMask(false);
    this.pWater.use().f('uGlassPass', 1);
    this.sections.draw(this.visible, 2, this.pWater.loc('uOrigin'), true);
    // The block under the crosshair.
    if (this.selection) {
      const b = this.selection.box;
      gl.depthMask(false);
      this.pOverlay.use()
        .f3('uMin', b[0] as number, b[1] as number, b[2] as number)
        .f3('uMax', b[3] as number, b[4] as number, b[5] as number)
        .f('uProgress', this.selection.progress);
      gl.bindVertexArray(this.overlayVao);
      gl.drawArrays(gl.TRIANGLES, 0, 36);
      stats.drawCalls++;
    }
    // Rain or snow, and the rings where rain lands. Premultiplied, so streaks add light without hiding the scene.
    if (info.weather.rain > 0.02 && !info.underwater) {
      gl.depthMask(false);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.quadVao);
      const snowing = info.weather.snowing ? 1 : 0;
      const drops = Math.round((snowing ? 5000 : 9000) * Math.min(1, info.weather.rain * 1.3));
      this.pPrecip.use().tex('uHeightTex', 0, gl.TEXTURE_2D, this.heightTex).f('uCount', drops).f('uSnow', snowing);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drops);
      if (!snowing) {
        const rings = Math.round(700 * Math.min(1, info.weather.rain * 1.3));
        this.pSplash.use().tex('uHeightTex', 0, gl.TEXTURE_2D, this.heightTex).f('uCount', rings).f('uSnow', 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rings);
      }
      stats.drawCalls += 2;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    // --- light shafts -------------------------------------------------------
    if (this.settings.shafts && !info.underwater) {
      const volume = this.targets.volume;
      // The shafts end at what the eye sees, and that includes water: the forward target's depth has
      // it, the G-buffer's does not. Marched to the G-buffer's depth, a ray went on through the water
      // to the bed, and the air over deep water glowed with mist that was not there.
      const seen = forward.depth;
      bindTarget(gl, volume);
      const pv = this.pVolume.use();
      pv.tex('uDepth', 0, gl.TEXTURE_2D, seen).tex('uShadowMap', 7, gl.TEXTURE_2D_ARRAY, this.shadows.texture);
      pv.tex('uCloudNoise', 8, gl.TEXTURE_3D, this.cloudNoise);
      gl.uniformMatrix4fv(pv.loc('uShadowMat'), false, this.shadows.matrices);
      pv.f4v('uShadowSplit', this.shadows.splits).f4v('uShadowTexel', this.shadows.texel).f('uShadowRes', this.shadows.res);
      drawFullscreen(gl);
      bindTarget(gl, hdr);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.pVolumeAdd.use().tex('uVolume', 0, gl.TEXTURE_2D, volume.colors[0] as WebGLTexture).tex('uDepth', 1, gl.TEXTURE_2D, seen)
        .f2('uTexel', 1 / volume.width, 1 / volume.height);
      drawFullscreen(gl);
      gl.disable(gl.BLEND);
    }

    // --- bloom, tone mapping, antialiasing onto the canvas ----------------------
    this.post.run(this.targets, this.canvas, this.noCloud, this.settings.bloom, this.settings.fxaa);
    gl.depthMask(true);
  }
}
