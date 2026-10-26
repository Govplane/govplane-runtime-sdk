/**
 * Timer plumbing, injectable so tests can drive it without fake timers.
 *
 * The observability module carries its own copy of `unref`; it cannot be
 * shared because that module may not be imported from here (see
 * `test/packaging/observeIsolation.test.ts`).
 */

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Timers {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
}

/** A timer must never be what keeps a process alive. */
const unref = (handle: TimerHandle): TimerHandle => {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  return handle;
};

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  setTimer: (callback, ms) => unref(setTimeout(callback, ms)),
  clearTimer: (handle) => clearTimeout(handle),
};
