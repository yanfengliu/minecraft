// Entry point: shows the loading screen, builds the game, and publishes the
// debug interface that the browser gate and visual inspection both drive.

import { Game } from './game';
import { REGIMES, type Regime } from './sim/weather';
import { DEFAULT_ISLAND, type IslandConfig } from './world/gen/terrain';

export interface DebugApi {
  ready: boolean;
  webgl2: boolean;
  renderer: string;
  error: string | null;
  game: Game | null;
  /** Move the camera; angles in degrees. */
  look(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
  setHour(hour: number): void;
  setWeather(regime: string | null): void;
  setTimeScale(scale: number): void;
  /** Run the game loop by hand for this many seconds (works in a hidden tab, where animation frames do not arrive). */
  step(seconds: number): void;
  /** Render a frame and return a coarse grid of its pixels (r, g, b bytes, top row first). */
  probe(cols?: number, rows?: number): number[];
  stats(): Record<string, number | string>;
}

declare global {
  interface Window {
    __tidewick?: DebugApi;
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.createElement('div');
overlay.id = 'loading';
overlay.style.cssText =
  'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
  'background:#0b0f14;color:#d8cfb8;font:16px Georgia,serif;letter-spacing:0.04em;z-index:10';
overlay.innerHTML = '<div style="font-size:44px;letter-spacing:0.12em">TIDEWICK</div><div id="stage"></div>' +
  '<div style="width:280px;height:4px;background:#1d2530"><div id="bar" style="height:4px;width:0;background:#c9a45a"></div></div>';
document.body.appendChild(overlay);
const stageEl = overlay.querySelector('#stage') as HTMLElement;
const barEl = overlay.querySelector('#bar') as HTMLElement;

const api: DebugApi = {
  ready: false,
  webgl2: false,
  renderer: '',
  error: null,
  game: null,
  look(x, y, z, yawDeg, pitchDeg) {
    const g = api.game;
    if (!g) return;
    // Place the eyes there and hold still: flight keeps gravity from pulling the view away.
    g.player.flying = true;
    g.player.teleport(x, y - 1.62, z);
    g.player.yaw = (yawDeg * Math.PI) / 180;
    g.player.pitch = (pitchDeg * Math.PI) / 180;
  },
  setHour(hour) {
    api.game?.setHour(hour);
  },
  setWeather(regime) {
    if (regime !== null && !(REGIMES as readonly string[]).includes(regime)) throw new Error(`unknown weather: ${regime}`);
    api.game?.setWeather(regime as Regime | null);
  },
  setTimeScale(scale) {
    if (api.game) api.game.timeScale = scale;
  },
  step(seconds) {
    api.game?.advance(seconds);
  },
  probe(cols, rows) {
    return api.game?.probe(cols, rows) ?? [];
  },
  stats(): Record<string, number | string> {
    const g = api.game;
    const none: Record<string, number | string> = {};
    if (!g) return none;
    const s = g.renderer.stats;
    return {
      fps: Math.round(g.fps), frameMs: Number(g.frameMs.toFixed(2)), drawCalls: s.drawCalls, triangles: s.triangles,
      sections: s.sections, visible: s.visible, width: s.width, height: s.height, meshMB: Number((s.meshBytes / 1048576).toFixed(1)),
      pendingMeshes: g.pool.pending, clock: g.clock.format(), weather: g.weather.regime, exposure: Number(g.env.exposure.toFixed(3)),
    };
  },
};
window.__tidewick = api;

function fail(message: string): void {
  api.error = message;
  api.ready = true;
  stageEl.textContent = message;
  stageEl.style.cssText = 'color:#e08a6a;max-width:70ch;white-space:pre-wrap;font:13px ui-monospace,monospace;text-align:left';
  console.error(message);
}

async function boot(): Promise<void> {
  // A smaller world for quick checks: ?size=256 (multiple of 32), ?seed=...
  const params = new URLSearchParams(location.search);
  const size = Number(params.get('size')) || DEFAULT_ISLAND.sx;
  const config: IslandConfig = { ...DEFAULT_ISLAND, sx: size, sz: size, seed: Number(params.get('seed')) || DEFAULT_ISLAND.seed };
  try {
    const game = await Game.create(canvas, (stage, fraction) => {
      stageEl.textContent = stage;
      barEl.style.width = `${Math.round(fraction * 100)}%`;
    }, config);
    api.game = game;
    const gl = game.renderer.gl;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    api.renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    api.webgl2 = true;
    game.start();
    overlay.remove();
    api.ready = true;
  } catch (e) {
    fail(e instanceof Error ? `${e.message}` : String(e));
  }
}

void boot();
