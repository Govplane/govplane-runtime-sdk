import { describe, expect, it } from '@jest/globals';
import { RecordBuffer, RECORD_LIMITS } from '../../src/observe/records.js';

/**
 * Correlated occurrences.
 *
 * This is the only part of the module that does not aggregate, so it is the
 * only part where a call site in a hot path costs real money. Most of what
 * follows guards that, not the feature.
 */

const at = '2026-01-01T00:00:00.000Z';
const buffer = (onError?: (e: unknown) => void) => new RecordBuffer(
  onError === undefined ? undefined : (e) => onError(e),
);

describe('keeping a record', () => {
  it('stores the message, level and code', () => {
    const buf = buffer();
    buf.record('payment declined', { level: 'error', code: 'card_declined' }, 'svc', at);

    const [entry] = buf.drain();
    expect(entry).toMatchObject({
      source: 'svc', level: 'error', message: 'payment declined', code: 'card_declined',
    });
  });

  it('carries the traceId that joins it to a decision', () => {
    // The whole reason this path exists: an aggregated metric cannot hold a
    // trace id, so it can never answer "which decision caused this one?".
    const buf = buffer();
    buf.record('declined', { traceId: 'trace-abc' }, 'svc', at);

    expect(buf.drain()[0]?.traceId).toBe('trace-abc');
  });

  it('defaults to info', () => {
    const buf = buffer();
    buf.record('something', {}, 'svc', at);
    expect(buf.drain()[0]?.level).toBe('info');
  });

  it('keeps each call rather than collapsing them', () => {
    // The opposite of event(): five calls are five records, which is why the
    // cap below matters.
    const buf = buffer();
    for (let i = 0; i < 5; i += 1) buf.record('same message', {}, 'svc', at);
    expect(buf.drain()).toHaveLength(5);
  });

  it('empties on drain so an interval is never sent twice', () => {
    const buf = buffer();
    buf.record('x', {}, 'svc', at);
    expect(buf.drain()).toHaveLength(1);
    expect(buf.drain()).toHaveLength(0);
  });
});

describe('the rate cap', () => {
  it('stops buffering past the per-interval limit', () => {
    const buf = buffer();
    for (let i = 0; i < RECORD_LIMITS.maxPerInterval + 500; i += 1) {
      buf.record('hot path', {}, 'svc', at);
    }

    expect(buf.size()).toBe(RECORD_LIMITS.maxPerInterval);
    expect(buf.droppedCount()).toBe(500);
  });

  it('reports the overflow once, not once per dropped record', () => {
    // A hot-path call site would otherwise turn one mistake into a second
    // flood, this time through the caller's own error handler.
    const errors: unknown[] = [];
    const buf = buffer((e) => errors.push(e));
    for (let i = 0; i < RECORD_LIMITS.maxPerInterval + 500; i += 1) {
      buf.record('hot path', {}, 'svc', at);
    }

    expect(errors).toHaveLength(1);
  });

  it('says what to use instead', () => {
    const errors: unknown[] = [];
    const buf = buffer((e) => errors.push(e));
    for (let i = 0; i < RECORD_LIMITS.maxPerInterval + 1; i += 1) {
      buf.record('hot path', {}, 'svc', at);
    }

    expect(String(errors[0])).toMatch(/event\(\)/);
  });
});

describe('nothing malformed reaches the batch', () => {
  it('drops an empty message', () => {
    const buf = buffer();
    buf.record('   ', {}, 'svc', at);
    expect(buf.drain()).toHaveLength(0);
  });

  it('drops metadata that cannot be serialised', () => {
    // A circular structure would fail at the wire and take the whole batch
    // with it.
    const errors: unknown[] = [];
    const buf = buffer((e) => errors.push(e));
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    buf.record('x', { metadata: circular }, 'svc', at);
    expect(buf.drain()).toHaveLength(0);
    expect(String(errors[0])).toMatch(/serialisable/i);
  });

  it('drops oversized metadata, and says why it matters', () => {
    const errors: unknown[] = [];
    const buf = buffer((e) => errors.push(e));
    buf.record('x', { metadata: { blob: 'y'.repeat(RECORD_LIMITS.maxMetadataBytes) } }, 'svc', at);

    expect(buf.drain()).toHaveLength(0);
    // Metadata is the one field on this path that carries free-form
    // application data, so the message says plainly that it leaves the process.
    expect(String(errors[0])).toMatch(/leaves your process/i);
  });

  it('truncates an overlong message rather than dropping it', () => {
    // A long message is a formatting mistake, not a data-protection one, and
    // losing the record entirely would be the worse outcome.
    const buf = buffer();
    buf.record('z'.repeat(5_000), {}, 'svc', at);

    expect(buf.drain()[0]?.message).toHaveLength(RECORD_LIMITS.maxMessageLength);
  });

  it('never throws at the caller', () => {
    const buf = buffer();
    expect(() => buf.record(undefined as unknown as string, {}, 'svc', at)).not.toThrow();
  });
});
