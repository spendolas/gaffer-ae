import { wrapInSafety } from './safety.js';

/**
 * Serialized execution queue — guarantees one-at-a-time JSX execution in AE.
 * Uses a promise chain as a mutex.
 */
export class Queue {
  constructor(bridge) {
    this.bridge = bridge;
    this.pending = Promise.resolve();
  }

  enqueue(code, undoLabel, readOnly) {
    var wrapped = wrapInSafety(code, undoLabel, readOnly);
    var task = this.pending.then(() => this.bridge.send(wrapped));
    // Swallow rejection to keep chain alive for next call
    this.pending = task.catch(() => {});
    return task;
  }
}
