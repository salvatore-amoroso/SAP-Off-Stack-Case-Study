import test from 'node:test';
import assert from 'node:assert/strict';
import { controlTimingValid } from './benchmark-timing.mjs';
const block = { control_wall_ms: 181000, started_utc: '2026-01-01T00:00:00.000Z', finished_utc: '2026-01-01T00:03:01.000Z' };
const warmup = [{ metrics: { elapsed_ms: 500 } }];
test('controller duration bounds measured work plus warmup with millisecond rounding allowance', () => {
  assert(controlTimingValid(block, { measured_wall_ms: 180000 }, warmup));
  assert(controlTimingValid(block, { measured_wall_ms: 180502 }, warmup));
  assert(!controlTimingValid(block, { measured_wall_ms: 180503 }, warmup));
  assert(!controlTimingValid(block, { measured_wall_ms: 180000000 }, warmup));
});
test('missing, invalid or conflicting independent clocks cannot validate timing', () => {
  for (const change of [{ control_wall_ms: undefined }, { control_wall_ms: NaN }, { control_wall_ms: -1 },
    { control_wall_ms: Infinity }, { finished_utc: 'invalid' }, { finished_utc: block.started_utc }, { control_wall_ms: 185000 }]) {
    assert(!controlTimingValid({ ...block, ...change }, { measured_wall_ms: 180000 }, warmup));
  }
  assert(!controlTimingValid(block, { measured_wall_ms: 180000 }, [{ metrics: {} }]));
  assert(!controlTimingValid(block, { measured_wall_ms: 180000 }, [{ metrics: { elapsed_ms: -1 } }]));
  assert(!controlTimingValid(block, { measured_wall_ms: 180000 }, undefined));
});
