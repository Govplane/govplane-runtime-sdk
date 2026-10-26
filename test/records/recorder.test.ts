import { describe, expect, it } from '@jest/globals';
import { createRecorder } from '../../src/records/recorder.js';
import { validateRecordConfig } from '../../src/records/validateRecordConfig.js';
import { verifyRecordChain } from '../../src/records/chain.js';
import type { Timers, TimerHandle } from '../../src/records/timers.js';
import type {
  BundleSnapshot, DecisionRecord, RecordConfig,
} from '../../src/records/types.js';
import type { Decision } from '../../src/engine/types.js';

/**
 * The recorder.
 *
 * What these guard: the sink is never called inside `observe()`; a slow,
 * throwing or rejecting sink is reported and never grows memory without
 * bound; every drop is counted and leaves a `seq` gap; and `close()` returns
 * on a deadline whatever the sink does. Time is injected, so nothing here
 * waits on a real clock.
 */

const SNAPSHOT: BundleSnapshot = {
  version: 1, checksum: 'sha256:00', signature: { verified: true }, origin: 'local',
};
const INPUT = { target: { service: 's', resource: 'r', action: 'a' }, context: { x: 1 } };
const DENY: Decision = { decision: 'deny', reason: 'rule', policyKey: 'p', ruleId: 'r' };
const ALLOW: Decision = { decision: 'allow', reason: 'default' };

/** A clock and timer set driven by hand. */
const fakeTimers = () => {
  let now = 1_700_000_000_000;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let nextHandle = 1;
  const timers: Timers = {
    now: () => now,
    setTimer: (callback, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { at: now + ms, callback });
      return handle as unknown as TimerHandle;
    },
    clearTimer: (handle) => { pending.delete(handle as unknown as number); },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [handle, entry] of [...pending.entries()]) {
      if (entry.at <= now) {
        pending.delete(handle);
        entry.callback();
      }
    }
  };
  return { timers, advance, armed: () => pending.size };
};

/** Lets a microtask drain run. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
};

const make = (
  overrides: Partial<RecordConfig> = {},
  deps: { timers?: Timers; random?: () => number } = {},
) => {
  const batches: DecisionRecord[][] = [];
  const errors: unknown[] = [];
  const config = validateRecordConfig({
    sink: (records: DecisionRecord[]) => { batches.push(records); },
    ...overrides,
  });
  const recorder = createRecorder(config, { onError: (e) => { errors.push(e); }, ...deps });
  return {
    recorder, batches, errors, all: () => batches.flat(),
  };
};

describe('delivery', () => {
  it('never calls the sink inside observe()', async () => {
    const { recorder, batches } = make({ batch: { maxRecords: 1 } });
    recorder.observe(DENY, INPUT, SNAPSHOT);
    expect(batches).toHaveLength(0);
    await settle();
    expect(batches).toHaveLength(1);
  });

  it('flushes when the batch fills', async () => {
    const { recorder, batches } = make({ batch: { maxRecords: 3, maxDelayMs: 60_000 } });
    for (let i = 0; i < 7; i += 1) recorder.observe(DENY, INPUT, SNAPSHOT);
    await settle();
    expect(batches.map((b) => b.length)).toEqual([3, 3]);
    expect(recorder.status().queued).toBe(1);
  });

  it('flushes when the delay elapses', async () => {
    const clock = fakeTimers();
    const { recorder, batches } = make({ batch: { maxRecords: 100, maxDelayMs: 250 } }, clock);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    clock.advance(249);
    await settle();
    expect(batches).toHaveLength(0);
    clock.advance(1);
    await settle();
    expect(batches.map((b) => b.length)).toEqual([2]);
    expect(clock.armed()).toBe(0);
  });

  it('numbers records consecutively and counts what was emitted', async () => {
    const { recorder, all } = make();
    for (let i = 0; i < 5; i += 1) recorder.observe(DENY, INPUT, SNAPSHOT);
    await recorder.flush();
    expect(all().map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(recorder.status()).toMatchObject({
      enabled: true, queued: 0, emitted: 5, dropped: 0, lastError: null,
    });
  });

  it('stamps each record with the snapshot it was given', async () => {
    const { recorder, all } = make();
    recorder.observe(DENY, INPUT, SNAPSHOT);
    recorder.observe(DENY, INPUT, { ...SNAPSHOT, version: 2, checksum: 'sha256:01' });
    await recorder.flush();
    expect(all().map((r) => r.bundle.checksum)).toEqual(['sha256:00', 'sha256:01']);
  });
});

describe('sampling', () => {
  it('always records the named decisions and samples the rest', async () => {
    let roll = 0;
    const { recorder, all } = make(
      { sample: { rate: 0.5, always: ['deny'] } },
      { random: () => roll },
    );
    recorder.observe(ALLOW, INPUT, SNAPSHOT); // roll 0 < 0.5: recorded
    roll = 0.9;
    recorder.observe(ALLOW, INPUT, SNAPSHOT); // not recorded
    recorder.observe(DENY, INPUT, SNAPSHOT); // always
    await recorder.flush();
    expect(all().map((r) => r.decision)).toEqual(['allow', 'deny']);
  });

  it('records only the always set at rate 0', async () => {
    const { recorder, all } = make({ sample: { rate: 0 } });
    recorder.observe(ALLOW, INPUT, SNAPSHOT);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    recorder.observe({ decision: 'requires_approval', reason: 'rule' }, INPUT, SNAPSHOT);
    await recorder.flush();
    expect(all().map((r) => r.decision)).toEqual(['deny', 'requires_approval']);
  });

  it('numbers after sampling, so a gap always means a drop', async () => {
    const { recorder, all } = make({ sample: { rate: 0 } });
    recorder.observe(ALLOW, INPUT, SNAPSHOT);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    recorder.observe(ALLOW, INPUT, SNAPSHOT);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    await recorder.flush();
    expect(all().map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe('overflow', () => {
  /** A sink that holds its first batch until released and takes the rest at once. */
  const blockingSink = () => {
    let release: () => void = () => {};
    const batches: DecisionRecord[][] = [];
    return {
      batches,
      sink: (records: DecisionRecord[]) => {
        batches.push(records);
        if (batches.length > 1) return undefined;
        return new Promise<void>((resolve) => { release = resolve; });
      },
      release: () => { release(); },
    };
  };

  it.each<['drop-oldest' | 'drop-newest' | 'block-never', number[]]>([
    ['drop-oldest', [6, 7, 8, 9]],
    ['block-never', [6, 7, 8, 9]],
    ['drop-newest', [4, 5, 6, 7]],
  ])('%s under saturation', async (overflow, expected) => {
    const held = blockingSink();
    const errors: unknown[] = [];
    const recorder = createRecorder(
      validateRecordConfig({
        sink: held.sink, batch: { maxRecords: 3 }, maxQueue: 4, overflow,
      }),
      { onError: (e) => { errors.push(e); } },
    );
    // First three go to the sink and block it; the next six hit a queue of four.
    for (let i = 0; i < 9; i += 1) {
      recorder.observe(DENY, INPUT, SNAPSHOT);
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
    expect(held.batches).toHaveLength(1);
    expect(recorder.status()).toMatchObject({ queued: 4, dropped: 2 });
    held.release();
    await recorder.flush();
    const seqs = held.batches.flat().map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, ...expected]);
    expect(recorder.status()).toMatchObject({ emitted: 7, dropped: 2 });
    expect(errors).toEqual([]);
  });
});

describe('sink failure', () => {
  const expectSinkError = (error: unknown, records: number): void => {
    expect(error).toMatchObject({ code: 'RECORD_SINK_ERROR', details: { records } });
  };

  it('reports a throwing sink and keeps going', async () => {
    let calls = 0;
    const { recorder, errors } = make({
      batch: { maxRecords: 2 },
      sink: () => {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
      },
    });
    for (let i = 0; i < 4; i += 1) recorder.observe(DENY, INPUT, SNAPSHOT);
    await recorder.flush();
    expect(errors).toHaveLength(1);
    expectSinkError(errors[0], 2);
    expect((errors[0] as Error).message).toContain('disk full');
    expect(recorder.status()).toMatchObject({
      emitted: 2, dropped: 2, lastError: { code: 'RECORD_SINK_ERROR', message: 'disk full' },
    });
  });

  it('reports a rejecting sink the same way', async () => {
    const { recorder, errors } = make({ sink: () => Promise.reject(new Error('503')) });
    recorder.observe(DENY, INPUT, SNAPSHOT);
    await recorder.flush();
    expectSinkError(errors[0], 1);
    expect(recorder.status().lastError?.message).toBe('503');
  });

  it('survives an onError that throws', async () => {
    const recorder = createRecorder(
      validateRecordConfig({ sink: () => { throw new Error('x'); } }),
      { onError: () => { throw new Error('handler broke'); } },
    );
    recorder.observe(DENY, INPUT, SNAPSHOT);
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it('bounds memory under a slow sink', async () => {
    let release: () => void = () => {};
    const { recorder } = make({
      batch: { maxRecords: 100 },
      maxQueue: 200,
      sink: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    for (let i = 0; i < 2_000; i += 1) recorder.observe(DENY, INPUT, SNAPSHOT);
    await settle();
    expect(recorder.status().queued).toBeLessThanOrEqual(200);
    expect(recorder.status().dropped).toBeGreaterThan(0);
    release();
    await settle();
  });

  it('never throws out of observe()', () => {
    const { recorder, errors } = make();
    // A snapshot the builder cannot read is the closest thing to a bug here.
    expect(() => recorder.observe(
      DENY, { target: undefined as never, context: undefined }, SNAPSHOT,
    )).not.toThrow();
    expect(errors.length).toBeLessThanOrEqual(1);
  });
});

describe('chain', () => {
  it('links the records that reach the sink, across batches', async () => {
    const { recorder, all } = make({ chain: true, batch: { maxRecords: 4 } });
    for (let i = 0; i < 10; i += 1) recorder.observe(DENY, INPUT, SNAPSHOT);
    await recorder.flush();
    expect(all()[0]?.prev).toBeNull();
    expect(verifyRecordChain(all())).toEqual({ ok: true, records: 10 });
  });

  it('leaves no chain fields when off', async () => {
    const { recorder, all } = make();
    recorder.observe(DENY, INPUT, SNAPSHOT);
    await recorder.flush();
    expect(all()[0]).not.toHaveProperty('prev');
    expect(all()[0]).not.toHaveProperty('hash');
  });
});

describe('flush and close', () => {
  it('flush resolves only once the sink has taken everything', async () => {
    let release: () => void = () => {};
    let taken = 0;
    const { recorder } = make({
      sink: (records) => new Promise<void>((resolve) => {
        taken += records.length;
        release = resolve;
      }),
    });
    recorder.observe(DENY, INPUT, SNAPSHOT);
    let flushed = false;
    const flush = recorder.flush().then(() => { flushed = true; });
    await settle();
    expect(taken).toBe(1);
    expect(flushed).toBe(false);
    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it('flush resolves immediately when idle', async () => {
    const { recorder } = make();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it('close returns on the deadline with a hanging sink, then drops', async () => {
    const clock = fakeTimers();
    const { recorder } = make({ sink: () => new Promise<void>(() => {}) }, clock);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    let closed = false;
    const closing = recorder.close(50).then(() => { closed = true; });
    await settle();
    expect(closed).toBe(false);
    clock.advance(50);
    await closing;
    expect(closed).toBe(true);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    expect(recorder.status().dropped).toBe(1);
  });

  it('close delivers what is queued when the sink is prompt', async () => {
    const clock = fakeTimers();
    const { recorder, all } = make({ batch: { maxDelayMs: 60_000 } }, clock);
    recorder.observe(DENY, INPUT, SNAPSHOT);
    expect(clock.armed()).toBe(1);
    await recorder.close(2000);
    expect(all()).toHaveLength(1);
    expect(clock.armed()).toBe(0);
  });
});
