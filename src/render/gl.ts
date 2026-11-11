// A thin layer over WebGL2: programs with cached uniforms and readable compile
// errors, textures, framebuffers and the full-screen triangle. Each pass sets
// the GL state it depends on; nothing here hides state.

export type GL = WebGL2RenderingContext;

/** The few source lines around each line the compiler complained about: enough to see the mistake, not the whole shader. */
function excerpt(source: string, log: string): string {
  const lines = source.split('\n');
  const wanted = new Set<number>();
  for (const m of log.matchAll(/ERROR: \d+:(\d+)/g)) {
    const n = Number(m[1]);
    for (let i = n - 2; i <= n + 2; i++) if (i >= 1 && i <= lines.length) wanted.add(i);
  }
  return [...wanted].sort((a, b) => a - b).slice(0, 40).map((n) => `${String(n).padStart(4)}: ${lines[n - 1]}`).join('\n');
}

function compile(gl: GL, type: number, source: string, name: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`could not create shader for ${name}`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`${name} ${kind} shader failed to compile:\n${log.slice(0, 1200)}\n${excerpt(source, log)}`);
  }
  return shader;
}

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2DArray;\nprecision highp sampler2DArrayShadow;\nprecision highp sampler3D;\nprecision highp usampler2D;\n';

export class Program {
  readonly gl: GL;
  readonly handle: WebGLProgram;
  readonly name: string;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  /** `defines` become `#define NAME value` lines ahead of both sources. The Frame uniform block, if declared, binds to point 0. */
  constructor(gl: GL, name: string, vertex: string, fragment: string, defines: Record<string, string | number | boolean> = {}) {
    this.gl = gl;
    this.name = name;
    let defs = '';
    for (const [k, v] of Object.entries(defines)) {
      if (v === false) continue;
      defs += `#define ${k} ${v === true ? '1' : v}\n`;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, HEADER + defs + vertex, name);
    const fs = compile(gl, gl.FRAGMENT_SHADER, HEADER + defs + fragment, name);
    const handle = gl.createProgram();
    if (!handle) throw new Error(`could not create program ${name}`);
    gl.attachShader(handle, vs);
    gl.attachShader(handle, fs);
    gl.linkProgram(handle);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      throw new Error(`${name} failed to link: ${gl.getProgramInfoLog(handle) ?? ''}`);
    }
    this.handle = handle;
    const block = gl.getUniformBlockIndex(handle, 'Frame');
    if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(handle, block, 0);
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, l);
    }
    return l;
  }

  i(name: string, v: number): this { this.gl.uniform1i(this.loc(name), v); return this; }
  ui(name: string, v: number): this { this.gl.uniform1ui(this.loc(name), v >>> 0); return this; }
  f(name: string, v: number): this { this.gl.uniform1f(this.loc(name), v); return this; }
  f2(name: string, x: number, y: number): this { this.gl.uniform2f(this.loc(name), x, y); return this; }
  f3(name: string, x: number, y: number, z: number): this { this.gl.uniform3f(this.loc(name), x, y, z); return this; }
  f4(name: string, x: number, y: number, z: number, w: number): this { this.gl.uniform4f(this.loc(name), x, y, z, w); return this; }
  fv(name: string, v: Float32Array | number[]): this { this.gl.uniform1fv(this.loc(name), v); return this; }
  f3v(name: string, v: Float32Array | number[]): this { this.gl.uniform3fv(this.loc(name), v); return this; }
  f4v(name: string, v: Float32Array | number[]): this { this.gl.uniform4fv(this.loc(name), v); return this; }
  m4(name: string, m: Float32Array): this { this.gl.uniformMatrix4fv(this.loc(name), false, m); return this; }

  /** Bind a texture to a unit and point the sampler at it. */
  tex(name: string, unit: number, target: number, texture: WebGLTexture | null): this {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

export interface TextureOptions {
  width: number;
  height: number;
  /** Layers of a 2D array, or depth of a 3D texture. */
  depth?: number;
  target?: number;
  internalFormat: number;
  format: number;
  type: number;
  data?: ArrayBufferView | null;
  min?: number;
  mag?: number;
  wrap?: number;
  mips?: boolean;
  compare?: boolean;
  anisotropy?: number;
}

export function createTexture(gl: GL, o: TextureOptions): WebGLTexture {
  const target = o.target ?? gl.TEXTURE_2D;
  const tex = gl.createTexture();
  if (!tex) throw new Error('could not create texture');
  gl.bindTexture(target, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (target === gl.TEXTURE_2D) {
    gl.texImage2D(target, 0, o.internalFormat, o.width, o.height, 0, o.format, o.type, o.data ?? null);
  } else {
    gl.texImage3D(target, 0, o.internalFormat, o.width, o.height, o.depth ?? 1, 0, o.format, o.type, o.data ?? null);
  }
  const wrap = o.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, o.min ?? gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, o.mag ?? gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrap);
  if (o.compare) {
    gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(target, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  }
  if (o.anisotropy && o.anisotropy > 1) {
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) {
      const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(target, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(o.anisotropy, max));
    }
  }
  if (o.mips) gl.generateMipmap(target);
  return tex;
}

export interface Target {
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  colors: WebGLTexture[];
  depth: WebGLTexture | null;
}

/** A framebuffer over existing textures. Pass `layer` to attach one layer of an array or 3D depth/colour texture. */
export function createTarget(gl: GL, width: number, height: number, colors: WebGLTexture[], depth: WebGLTexture | null = null, layer = -1): Target {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('could not create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  colors.forEach((c, i) => {
    if (layer >= 0) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, c, 0, layer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c, 0);
  });
  if (depth) {
    if (layer >= 0 && colors.length === 0) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depth, 0, layer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  }
  if (colors.length === 0) {
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
  } else {
    gl.drawBuffers(colors.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)} (${width}x${height}, ${colors.length} colour)`);
  return { fbo, width, height, colors, depth };
}

export function bindTarget(gl: GL, target: Target | null, width = 0, height = 0): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  gl.viewport(0, 0, target ? target.width : width, target ? target.height : height);
}

export function deleteTarget(gl: GL, t: Target | null, textures = true): void {
  if (!t) return;
  gl.deleteFramebuffer(t.fbo);
  if (!textures) return;
  for (const c of t.colors) gl.deleteTexture(c);
  if (t.depth) gl.deleteTexture(t.depth);
}

/** Vertex shader for full-screen passes: one triangle from gl_VertexID, `vUV` in 0..1. */
export const FULLSCREEN_VS = /* glsl */ `
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

let fullscreenVao: WebGLVertexArrayObject | null = null;
let fullscreenOwner: GL | null = null;

/** Draw the full-screen triangle with whatever program is bound. */
export function drawFullscreen(gl: GL): void {
  if (fullscreenOwner !== gl) {
    fullscreenVao = gl.createVertexArray();
    fullscreenOwner = gl;
  }
  gl.bindVertexArray(fullscreenVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Extensions the renderer cannot do without; throws a readable error naming what is missing. */
export function requireExtensions(gl: GL): void {
  for (const name of ['EXT_color_buffer_float', 'OES_texture_float_linear']) {
    if (!gl.getExtension(name)) throw new Error(`this GPU or browser lacks the WebGL2 extension ${name}`);
  }
}
