import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, State } from '../src/index.js';

function makeBreaker(overrides = {}) {
  let t = 0;
  const breaker = new CircuitBreaker({ now: () => t, ...overrides });
  const tick = (ms) => { t += ms; };
  return { breaker, tick, now: () => t };
}

test('starts closed and allows calls', () => {
  const { breaker } = makeBreaker();
  assert.equal(breaker.state, State.CLOSED);
  assert.equal(breaker.allow(), true);
});

test('opens after failureThreshold failures in the rolling window', () => {
  const { breaker } = makeBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(breaker.allow(), true);
    breaker.failure();
  }
  assert.equal(breaker.state, State.OPEN);
  assert.equal(breaker.allow(), false);
});

test('successes do not clear the rolling failure window', () => {
  const { breaker } = makeBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 2; i++) { breaker.allow(); breaker.failure(); }
  breaker.allow(); breaker.success();
  breaker.allow(); breaker.failure();
  assert.equal(breaker.state, State.OPEN);
});

test('old failures age out of the rolling window', () => {
  const { breaker, tick } = makeBreaker({ failureThreshold: 3, rollingWindow: 1000 });
  breaker.allow(); breaker.failure();
  breaker.allow(); breaker.failure();
  tick(1001);
  breaker.allow(); breaker.failure();
  assert.equal(breaker.state, State.CLOSED);
});

test('OPEN transitions to HALF_OPEN lazily after resetTimeout', () => {
  const { breaker, tick } = makeBreaker({ failureThreshold: 1, resetTimeout: 5000 });
  breaker.allow(); breaker.failure();
  assert.equal(breaker.state, State.OPEN);
  tick(4999);
  assert.equal(breaker.state, State.OPEN);
  tick(1);
  assert.equal(breaker.state, State.HALF_OPEN);
});

test('HALF_OPEN admits one probe at a time by default', () => {
  const { breaker, tick } = makeBreaker({ failureThreshold: 1, resetTimeout: 100 });
  breaker.allow(); breaker.failure();
  tick(100);
  assert.equal(breaker.state, State.HALF_OPEN);
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.allow(), false); // probe in flight
  breaker.success();
  assert.equal(breaker.state, State.CLOSED);
});

test('a successful probe closes the breaker', () => {
  const { breaker, tick } = makeBreaker({ failureThreshold: 1, resetTimeout: 100, halfOpenSuccesses: 1 });
  breaker.allow(); breaker.failure();
  tick(100);
  assert.equal(breaker.allow(), true);
  breaker.success();
  assert.equal(breaker.state, State.CLOSED);
});

test('a failed probe re-opens the breaker and restarts cooldown', () => {
  const { breaker, tick } = makeBreaker({ failureThreshold: 1, resetTimeout: 100 });
  breaker.allow(); breaker.failure();
  tick(100);
  assert.equal(breaker.allow(), true);
  breaker.failure();
  assert.equal(breaker.state, State.OPEN);
  // Cooldown restarted: not yet half-open.
  tick(99);
  assert.equal(breaker.state, State.OPEN);
  tick(1);
  assert.equal(breaker.state, State.HALF_OPEN);
});

test('halfOpenSuccesses greater than halfOpenMax throws', () => {
  assert.throws(() => makeBreaker({ halfOpenMax: 1, halfOpenSuccesses: 2 }), RangeError);
});

test('requires a now function', () => {
  assert.throws(() => new CircuitBreaker({}), TypeError);
});

test('stray success in OPEN is ignored', () => {
  const { breaker, tick } = makeBreaker({ failureThreshold: 1, resetTimeout: 100 });
  breaker.allow(); breaker.failure();
  breaker.success(); // stray
  assert.equal(breaker.state, State.OPEN);
});

test('reset forces CLOSED and clears counters', () => {
  const { breaker } = makeBreaker({ failureThreshold: 1 });
  breaker.allow(); breaker.failure();
  assert.equal(breaker.state, State.OPEN);
  breaker.reset();
  assert.equal(breaker.state, State.CLOSED);
  assert.equal(breaker.allow(), true);
});

test('multiple probes required to close', () => {
  const { breaker, tick } = makeBreaker({
    failureThreshold: 1, resetTimeout: 100, halfOpenMax: 3, halfOpenSuccesses: 2,
  });
  breaker.allow(); breaker.failure();
  tick(100);
  assert.equal(breaker.state, State.HALF_OPEN);
  // First probe succeeds.
  assert.equal(breaker.allow(), true); breaker.success();
  assert.equal(breaker.state, State.HALF_OPEN);
  // Second probe succeeds — threshold met.
  assert.equal(breaker.allow(), true); breaker.success();
  assert.equal(breaker.state, State.CLOSED);
});

test('probes exhausted without enough successes re-opens', () => {
  const { breaker, tick } = makeBreaker({
    failureThreshold: 1, resetTimeout: 100, halfOpenMax: 2, halfOpenSuccesses: 2,
  });
  breaker.allow(); breaker.failure();
  tick(100);
  assert.equal(breaker.allow(), true); breaker.success();
  assert.equal(breaker.state, State.HALF_OPEN);
  assert.equal(breaker.allow(), true); breaker.success();
  assert.equal(breaker.state, State.CLOSED);
});
