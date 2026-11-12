import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshOutput } from '../mesh/mesher';
import { Clock } from '../sim/clock';
import type { WeatherView } from '../sim/weather';
import { B } from '../world/blocks';
import { World } from '../world/world';
import { Environment } from './environment';
import { fakeGl } from './fakeGl';
import { type Camera, type FrameInfo, Renderer } from './renderer';

const FAIR: WeatherView = {
  regime: 'fair', cloudCover: 0.3, precipitation: 0, snowing: false, windX: 2, windZ: 1, windSpeed: 2.2, fog: 0.03,
  temperature: 10, wetness: 0, snowCover: 0, storminess: 0, isRaining: false,
};
const CAMERA: Camera = { x: 20, y: 20, z: 20, yaw: 0.6, pitch: -0.2, fov: (72 * Math.PI) / 180 };
const INFO: FrameInfo = {
  time: 1, hour: 15, wind: { x: 2, z: 1, strength: 0.2 },
  weather: { wetness: 0, snow: 0, rain: 0, cloud: 0.3, storm: 0, snowing: false }, underwater: false,
};
const MESH: MeshOutput = { data: new Uint32Array(8), opaque: 1, cutout: 0, translucent: 0, minY: 0, maxY: 1 };

/** A renderer on a canvas whose context draws nothing, and a way to take that context away as a browser does. */
function build(): { renderer: Renderer; calls: () => number; lose: () => void } {
  let lost = false;
  // A lost context answers every request for a new object with null.
  const made = (): object | null => (lost ? null : {});
  const fake = fakeGl({
    getExtension: {}, getShaderParameter: true, getProgramParameter: true,
    createTexture: made, createBuffer: made, createVertexArray: made, createFramebuffer: made,
  });
  const listeners: Record<string, (() => void)[]> = {};
  const canvas = {
    width: 0, height: 0, clientWidth: 640, clientHeight: 360,
    getContext: () => fake.gl,
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
  } as unknown as HTMLCanvasElement;
  const world = new World(64, 64, 64, 0);
  world.setRaw(5, 5, 5, B.stone);
  const renderer = new Renderer(canvas, world);
  return {
    renderer,
    calls: () => fake.calls.length,
    lose: () => {
      lost = true;
      for (const fn of listeners.webglcontextlost ?? []) fn();
    },
  };
}

describe('the renderer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops drawing and taking in meshes once the browser has taken its context away, and says so', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const env = new Environment();
    env.update(new Clock(15), FAIR, 1, 0, 0);
    const { renderer, calls, lose } = build();
    let told = 0;
    renderer.onContextLost = () => told++;

    // While it has a context, a frame is a great many calls and a mesh goes in.
    const before = calls();
    renderer.setMesh(0, MESH);
    renderer.render(CAMERA, env, INFO);
    expect(calls() - before).toBeGreaterThan(100);
    expect(renderer.sections.count).toBe(1);
    expect(renderer.contextLost).toBe(false);

    lose();
    expect(renderer.contextLost).toBe(true);
    expect(told).toBe(1);
    // Nothing more is asked of the dead context: not a frame, and not buffers for a mesh, which it
    // would refuse (that refusal used to be thrown from inside the mesh pool, once for every section).
    const after = calls();
    expect(() => renderer.render(CAMERA, env, INFO)).not.toThrow();
    expect(() => renderer.setMesh(1, MESH)).not.toThrow();
    expect(calls()).toBe(after);
    expect(renderer.sections.count).toBe(1);
    // The browser may say it twice; the game is told once.
    lose();
    expect(told).toBe(1);
  });
});
