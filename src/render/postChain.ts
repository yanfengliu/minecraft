// The end of the frame: bloom from the bright parts of the lit scene, tone
// mapping and grading down to display range, then antialiasing onto the canvas.

import { FULLSCREEN_VS, type GL, Program, type Target, bindTarget, drawFullscreen } from './gl';
import { BLOOM_DOWN_FS, BLOOM_UP_FS, COMPOSITE_FS, FXAA_FS } from './shaders/post';
import type { FrameTargets } from './targets';

const BLOOM_STRENGTH = 0.055;

export class PostChain {
  private readonly gl: GL;
  private readonly down: Program;
  private readonly up: Program;
  private readonly composite: Program;
  private readonly fxaa: Program;

  constructor(gl: GL) {
    this.gl = gl;
    this.down = new Program(gl, 'bloom-down', FULLSCREEN_VS, BLOOM_DOWN_FS);
    this.up = new Program(gl, 'bloom-up', FULLSCREEN_VS, BLOOM_UP_FS);
    this.composite = new Program(gl, 'composite', FULLSCREEN_VS, COMPOSITE_FS);
    this.fxaa = new Program(gl, 'fxaa', FULLSCREEN_VS, FXAA_FS);
  }

  /**
   * Take `targets.hdr` to the canvas. `black` is a 1x1 black texture, used in
   * place of the bloom when that is off. Expects blending and depth testing off.
   */
  run(targets: FrameTargets, canvas: HTMLCanvasElement, black: WebGLTexture, bloom: boolean, fxaa: boolean): void {
    const gl = this.gl;
    const { hdr, ldr } = targets;
    let bloomTex = black;
    const levels = targets.bloom;
    if (bloom && levels.length > 1) {
      // Down the pyramid, then back up adding each level into the one above it.
      const down = this.down.use();
      let source: Target = hdr;
      levels.forEach((level, i) => {
        bindTarget(gl, level);
        down.tex('uSource', 0, gl.TEXTURE_2D, source.colors[0] as WebGLTexture).f2('uTexel', 1 / source.width, 1 / source.height).f('uFirst', i === 0 ? 1 : 0);
        drawFullscreen(gl);
        source = level;
      });
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const up = this.up.use();
      for (let i = levels.length - 1; i > 0; i--) {
        const from = levels[i] as Target;
        bindTarget(gl, levels[i - 1] as Target);
        up.tex('uSource', 0, gl.TEXTURE_2D, from.colors[0] as WebGLTexture).f2('uTexel', 1 / from.width, 1 / from.height);
        drawFullscreen(gl);
      }
      gl.disable(gl.BLEND);
      bloomTex = (levels[0] as Target).colors[0] as WebGLTexture;
    }

    // Tone mapping, straight to the canvas or into `ldr` for the antialiasing pass to read.
    if (fxaa) bindTarget(gl, ldr);
    else bindTarget(gl, null, canvas.width, canvas.height);
    this.composite.use()
      .tex('uScene', 0, gl.TEXTURE_2D, hdr.colors[0] as WebGLTexture)
      .tex('uBloom', 1, gl.TEXTURE_2D, bloomTex)
      .f('uBloomStrength', BLOOM_STRENGTH);
    drawFullscreen(gl);
    if (fxaa) {
      bindTarget(gl, null, canvas.width, canvas.height);
      this.fxaa.use().tex('uSource', 0, gl.TEXTURE_2D, ldr.colors[0] as WebGLTexture).f2('uTexel', 1 / targets.width, 1 / targets.height);
      drawFullscreen(gl);
    }
  }
}
