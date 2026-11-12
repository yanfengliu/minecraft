// A stand-in for a WebGL2 context, for unit tests of what the renderer works
// out on the CPU (cascade fitting, instance uploads, extension checks). It
// draws nothing: every call is recorded and answered with something harmless.
// Tests only; nothing in the game imports this.

import type { GL } from './gl';

export interface GlCall {
  name: string;
  args: unknown[];
}

export interface FakeGl {
  gl: GL;
  /** Every call made so far, in order. */
  calls: GlCall[];
  /** The calls made to one function. */
  callsTo(name: string): GlCall[];
}

/**
 * `answers` gives the return value of particular functions: a value, or a
 * function of the call's arguments. Constants (`gl.TEXTURE_2D`) come back as
 * numbers, a different one for each name, so code may compare and offset them.
 */
export function fakeGl(answers: Record<string, unknown> = {}): FakeGl {
  const calls: GlCall[] = [];
  const constants = new Map<string, number>();
  const functions = new Map<string, (...args: unknown[]) => unknown>();
  const constant = (name: string): number => {
    let v = constants.get(name);
    if (v === undefined) {
      // Spaced out, so that COLOR_ATTACHMENT0 + 3 or TEXTURE0 + 9 cannot land on another constant.
      v = 0x10000 + constants.size * 64;
      constants.set(name, v);
    }
    return v;
  };
  const gl = new Proxy({}, {
    get(_target, key): unknown {
      if (typeof key !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return constant(key);
      let fn = functions.get(key);
      if (!fn) {
        fn = (...args: unknown[]): unknown => {
          calls.push({ name: key, args });
          if (key in answers) {
            const a = answers[key];
            return typeof a === 'function' ? (a as (...p: unknown[]) => unknown)(...args) : a;
          }
          if (key === 'checkFramebufferStatus') return constant('FRAMEBUFFER_COMPLETE');
          if (key === 'isContextLost') return false;
          if (key.startsWith('create')) return {};
          if (key === 'getExtension') return null;
          if (key.startsWith('get')) return 0;
          return undefined;
        };
        functions.set(key, fn);
      }
      return fn;
    },
  }) as unknown as GL;
  return { gl, calls, callsTo: (name) => calls.filter((c) => c.name === name) };
}
