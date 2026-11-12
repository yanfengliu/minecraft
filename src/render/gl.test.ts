import { describe, expect, it } from 'vitest';
import { fakeGl } from './fakeGl';
import { requireExtensions } from './gl';

describe('what the renderer asks of the GPU', () => {
  it('starts on a GPU that can draw into float targets but cannot filter 32-bit float textures', () => {
    // No 32-bit float texture is ever made, and half-float ones filter linearly in core WebGL2, so a
    // GPU without OES_texture_float_linear lacks nothing the renderer uses.
    const asked: string[] = [];
    const { gl } = fakeGl({
      getExtension: (name: string) => {
        asked.push(name);
        return name === 'OES_texture_float_linear' ? null : {};
      },
    });
    expect(() => requireExtensions(gl)).not.toThrow();
    // Asking is what switches an extension on: the one that is needed must have been asked for.
    expect(asked).toContain('EXT_color_buffer_float');
  });

  it('says which extension is missing when the GPU cannot draw into float targets', () => {
    const { gl } = fakeGl({ getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? null : {}) });
    expect(() => requireExtensions(gl)).toThrow(/EXT_color_buffer_float/);
  });
});
