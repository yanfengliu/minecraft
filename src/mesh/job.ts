// Messages between the mesh scheduler and its workers.

import type { MeshOutput } from './mesher';

export interface MeshJob {
  id: number;
  section: number;
  ox: number;
  oy: number;
  oz: number;
  states: Uint16Array;
  light: Uint8Array;
}

/** The mesh, plus the job's input buffers riding back for reuse. */
export interface MeshResult extends MeshOutput {
  id: number;
  section: number;
  states: Uint16Array;
  light: Uint8Array;
}
