import { wrapInSafety } from './safety.js';

/**
 * Serialized execution queue — guarantees one-at-a-time JSX execution in AE.
 * Uses a promise chain as a mutex.
 */
export class Queue {
  constructor(bridge) {
    this.bridge = bridge;
    this.pending = Promise.resolve();
    // In-flight JSX count — lets a shutdown/reload wait for AE work to finish
    // (not just chat/sign-in) so an update never cuts off a runJSX mid-execution.
    this.inFlight = 0;
  }

  enqueue(code, undoLabel, readOnly, target) {
    var wrapped = wrapInSafety(code, undoLabel, readOnly);
    this.inFlight++;
    var task = this.pending.then(() => this.bridge.send(wrapped, target));
    var settle = () => { this.inFlight--; };
    // Swallow rejection to keep chain alive for next call
    this.pending = task.then(settle, settle);
    return task;
  }

  // True when no JSX is executing — one half of the daemon's "idle" gate.
  isIdle() {
    return this.inFlight === 0;
  }
}
