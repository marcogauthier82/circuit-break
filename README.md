# Circuit Break

A small circuit breaker with half-open probing. Time is injected, so every transition is deterministic and testable without sleeping.

## Usage

```js
import { CircuitBreaker, State } from 'circuit-break';

const breaker = new CircuitBreaker({
  now: () => Date.now(),
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenMax: 1,
  halfOpenSuccesses: 1,
  rollingWindow: 60000,
});

async function doWork() {
  // your dependency call goes here
}

if (breaker.allow()) {
  try {
    await doWork();
    breaker.success();
  } catch (e) {
    breaker.failure();
    throw e;
  }
} else {
  throw new Error('circuit open');
}
```

`State` is a frozen enum: `State.CLOSED`, `State.OPEN`, `State.HALF_OPEN`.

## Why

A naive breaker flips from OPEN straight back to CLOSED after the cooldown. On a busy service that means a stampede of requests hits a dependency that may still be broken. This library inserts a HALF_OPEN state: after the cooldown, a small number of probe requests are admitted. Only if enough probes succeed does the breaker fully close; a single probe failure re-opens it and restarts the cooldown.

The trade-off: the breaker is pull-driven. There is no background timer. The OPEN-to-HALF_OPEN transition happens lazily on the next `allow()` or `state` read. If nothing calls the breaker, it stays OPEN indefinitely. That is fine for request-driven code and avoids needing a scheduler.

## Edge cases worth knowing

- **Successes do not clear the rolling failure window.** A dependency that fails one in three calls will still trip the breaker. Failures only age out by time.
- **`success()` and `failure()` are only meaningful for calls `allow()` admitted.** Stray reports (a late callback from before the breaker opened) are silently ignored rather than throwing, because real callers double-report under load.
- **Half-open admits at most `halfOpenMax` in-flight probes.** While a probe is outstanding, further `allow()` calls return `false`. The default is one probe at a time.
- **`halfOpenSuccesses` must not exceed `halfOpenMax`.** The constructor throws `RangeError` otherwise — it would be an impossible configuration.

## Exports

- `CircuitBreaker` — the class. Constructor takes `{ now, failureThreshold, resetTimeout, halfOpenMax, halfOpenSuccesses, rollingWindow }`. `now` is required and must return a numeric time in milliseconds.
- `State` — frozen enum with `CLOSED`, `OPEN`, `HALF_OPEN`.

Methods: `allow()` returns `boolean`. `success()` and `failure()` return `undefined`. `reset()` forces CLOSED. `state` is a getter that performs the lazy OPEN-to-HALF_OPEN transition.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

## Contributing

Issues and pull requests are welcome. Please keep the dependency list empty —
that constraint is the point of the project, not an oversight.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

