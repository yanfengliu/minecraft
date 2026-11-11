// Mesh worker entry: a copied section in, packed quads out.

import type { MeshJob, MeshResult } from '../mesh/job';
import { meshSection } from '../mesh/mesher';

interface Scope {
  onmessage: ((e: MessageEvent<MeshJob>) => void) | null;
  postMessage(message: MeshResult, transfer: Transferable[]): void;
}

const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  const job = e.data;
  const out = meshSection(job);
  const result: MeshResult = { ...out, id: job.id, section: job.section, states: job.states, light: job.light };
  scope.postMessage(result, [out.data.buffer, job.states.buffer, job.light.buffer]);
};
