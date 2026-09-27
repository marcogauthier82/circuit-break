/**
 * Circuit breaker state machine.
 *
 * CLOSED  — requests flow normally.
 * OPEN    — requests are rejected immediately; we are in a cooldown.
 * HALF_OPEN — a limited number of probe requests are allowed through to test recovery.
 *
 * The half-open state is the whole point of this library. A naive breaker flips
 * straight from OPEN back to CLOSED after the cooldown, which means a burst of
 * traffic hits a possibly-still-broken dependency all at once. Instead we admit
 * a small number of probes; only when enough succeed do we fully re-close.
 *
 * Design decisions (stated plainly so the tests and the README agree):
 *
 * 1. Time is injected. The breaker never reads the system clock. Callers pass a
 *    `now` function (milliseconds, numeric). This makes every transition
 *    deterministic and testable without sleeping.
 *
 * 2. Half-open uses a fixed allowance of `halfOpenMax` concurrent in-flight
 *    probes, not a rate. While any probe is in flight, further `allow()` calls
 *    are rejected. This is simpler to reason about than a leaky bucket and maps
 *    cleanly onto a single-request probe model. When all probes resolve, if
 *    successes met the threshold we close; otherwise we re-open and restart the
 *    cooldown from the current `now()`.
 *
 * 3. `success()` and `failure()` are only meaningful for calls that `allow()`
 *    admitted. The caller is expected to pair them. We do not throw on a stray
 *    report — real systems double-report under load — but we ignore it so it
 *    cannot corrupt the state machine.
 */

/**
 * @enum {number}
 */
export const State = Object.freeze({
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
});

/**
 * @typedef {Object} BreakerOptions
 * @property {() => number} now            Returns current time in ms (injected for determinism).
 * @property {number} failureThreshold     Failures in the rolling window before opening.
 * @property {number} resetTimeout         Ms to wait in OPEN before transitioning to HALF_OPEN.
 * @property {number} halfOpenMax           Probe attempts admitted in HALF_OPEN (we admit one at a time).
 * @property {number} halfOpenSuccesses     Successes required in HALF_OPEN to re-close.
 * @property {number} rollingWindow         Ms over which failures are counted in CLOSED.
 */

const DEFAULTS = Object.freeze({
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenMax: 1,
  halfOpenSuccesses: 1,
  rollingWindow: 60000,
});

export class CircuitBreaker {
  /**
   * @param {Partial<BreakerOptions>} [opts]
   */
  constructor(opts = {}) {
    if (typeof opts.now !== 'function') {
      throw new TypeError('CircuitBreaker requires a now() function');
    }
    this._now = opts.now;
    this._failureThreshold = _nonNegInt(opts.failureThreshold, DEFAULTS.failureThreshold);
    this._resetTimeout = _nonNegNum(opts.resetTimeout, DEFAULTS.resetTimeout);
    this._halfOpenMax = _posInt(opts.halfOpenMax, DEFAULTS.halfOpenMax);
    this._halfOpenSuccessThreshold = _posInt(opts.halfOpenSuccesses, DEFAULTS.halfOpenSuccesses);
    this._rollingWindow = _nonNegNum(opts.rollingWindow, DEFAULTS.rollingWindow);

    if (this._halfOpenSuccessThreshold > this._halfOpenMax) {
      // Impossible to ever close from half-open; catch a misconfiguration early.
      throw new RangeError('halfOpenSuccesses cannot exceed halfOpenMax');
    }

    this._state = State.CLOSED;
    /** @type {number[]} */
    this._failures = [];
    this._openedAt = 0;
    this._halfOpenInFlight = 0;
    this._halfOpenSuccesses = 0;
    this._halfOpenAttempts = 0;
  }

  get state() {
    // Lazy transition: OPEN -> HALF_OPEN happens on the next allow()/peek(), not on a timer.
    // This avoids needing a background tick and keeps the breaker purely pull-driven.
    if (this._state === State.OPEN && this._now() - this._openedAt >= this._resetTimeout) {
      this._toHalfOpen();
    }
    return this._state;
  }

  /**
   * Decide whether a call should be allowed. Returns true if the caller may
   * proceed (and must later report success() or failure()), false otherwise.
   * @returns {boolean}
   */
  allow() {
    const s = this.state; // triggers lazy OPEN->HALF_OPEN
    if (s === State.OPEN) return false;
    if (s === State.HALF_OPEN) {
      if (this._halfOpenInFlight >= this._halfOpenMax) return false;
      this._halfOpenInFlight++;
      return true;
    }
    return true;
  }

  /**
   * Report a successful call.
   */
  success() {
    if (this._state === State.HALF_OPEN) {
      this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
      this._halfOpenSuccesses++;
      this._halfOpenAttempts++;
      if (this._halfOpenSuccesses >= this._halfOpenSuccessThreshold) {
        this._toClosed();
      } else if (this._halfOpenInFlight === 0 && this._halfOpenAttempts >= this._halfOpenMax) {
        // Probes exhausted without reaching the success threshold.
        this._toOpen();
      }
      return;
    }
    if (this._state === State.CLOSED) {
      // A success does not clear the rolling failure window. We only forget
      // failures when they age out. Clearing on success would hide a flaky
      // dependency that fails one in three calls.
      return;
    }
    // OPEN: a stray success report (e.g. a late callback from before opening).
    // Ignore rather than throw — real callers double-report under pressure.
  }

  /**
   * Report a failed call.
   */
  failure() {
    if (this._state === State.HALF_OPEN) {
      this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
      this._halfOpenAttempts++;
      // A single failure during probing re-opens immediately. The dependency
      // is telling us it is not ready; do not keep poking it.
      this._toOpen();
      return;
    }
    if (this._state === State.CLOSED) {
      const t = this._now();
      this._failures.push(t);
      this._trimFailures(t);
      if (this._failures.length >= this._failureThreshold) {
        this._toOpen();
      }
      return;
    }
    // OPEN: stray failure report. Ignore.
  }

  /**
   * Force the breaker into CLOSED, clearing all counters. Useful in tests and
   * for operators who want to override the breaker manually.
   */
  reset() {
    this._toClosed();
  }

  _trimFailures(now) {
    if (this._rollingWindow <= 0) return;
    const cutoff = now - this._rollingWindow;
    // Filter in place to avoid allocating a new array on every failure.
    let w = 0;
    for (let i = 0; i < this._failures.length; i++) {
      if (this._failures[i] > cutoff) {
        this._failures[w++] = this._failures[i];
      }
    }
    this._failures.length = w;
  }

  _toOpen() {
    this._state = State.OPEN;
    this._openedAt = this._now();
    this._failures.length = 0;
    this._halfOpenInFlight = 0;
    this._halfOpenSuccesses = 0;
    this._halfOpenAttempts = 0;
  }

  _toHalfOpen() {
    this._state = State.HALF_OPEN;
    this._halfOpenInFlight = 0;
    this._halfOpenSuccesses = 0;
    this._halfOpenAttempts = 0;
  }

  _toClosed() {
    this._state = State.CLOSED;
    this._failures.length = 0;
    this._halfOpenInFlight = 0;
    this._halfOpenSuccesses = 0;
    this._halfOpenAttempts = 0;
  }
}

function _nonNegInt(v, dflt) {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new TypeError('expected non-negative integer');
  }
  return v;
}

function _posInt(v, dflt) {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new TypeError('expected positive integer');
  }
  return v;
}

function _nonNegNum(v, dflt) {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new TypeError('expected non-negative finite number');
  }
  return v;
}
