// A minimal typed event emitter. Listeners are called synchronously in
// subscription order, which keeps simulation side effects deterministic.

export type Listener<T> = (event: T) => void;

export class Emitter<T> {
  private listeners: Listener<T>[] = [];

  on(listener: Listener<T>): () => void {
    this.listeners.push(listener);
    return () => this.off(listener);
  }

  off(listener: Listener<T>): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  emit(event: T): void {
    // Iterate over a snapshot so a listener may unsubscribe while being called.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) listener(event);
  }

  get size(): number {
    return this.listeners.length;
  }
}
