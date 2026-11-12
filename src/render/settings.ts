// What the renderer is told and what it reports: the camera, the quality
// settings, the facts of the frame in hand, and the counts it keeps. Kept apart
// from the frame itself so that the game and the interface can name them
// without reading the passes.

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
