// Entry point. For now it only proves the page can get a hardware WebGL2
// context and publishes what it found for the browser gate; the engine boots
// from here once the renderer lands.

export interface BootReport {
  ready: boolean;
  webgl2: boolean;
  renderer: string;
  error: string | null;
}

declare global {
  interface Window {
    __tidewick?: BootReport;
  }
}

function boot(): BootReport {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) return { ready: false, webgl2: false, renderer: '', error: 'no canvas' };
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl) return { ready: false, webgl2: false, renderer: '', error: 'WebGL2 is not available' };
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  gl.clearColor(0.05, 0.07, 0.1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { ready: true, webgl2: true, renderer, error: null };
}

window.__tidewick = boot();
