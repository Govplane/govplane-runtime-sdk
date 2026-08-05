import type { StructuredTraceEvent, TraceSinkAsync, TraceQueueDropPolicy } from "./types.js";

interface Opts {
  sinkAsync: TraceSinkAsync;
  max: number;
  dropPolicy: TraceQueueDropPolicy;
  onError?: (err: unknown) => void;
}

export class TraceDispatcher {
  private q: StructuredTraceEvent[] = [];
  private draining = false;

  private flushWaiters: (() => void)[] = [];

  constructor(private readonly opts: Opts) {}

  enqueue(evt: StructuredTraceEvent): void {
    if (this.q.length >= this.opts.max) {
      if (this.opts.dropPolicy === "drop_old") {
        this.q.shift();
      } else {
        return;
      }
    }

    this.q.push(evt);
    this.kick();
  }

  async flush(): Promise<void> {
    if (!this.draining && this.q.length === 0) return;

    return new Promise<void>((resolve) => {
      this.flushWaiters.push(resolve);
      this.kick();
    });
  }

  private kick(): void {
    if (this.draining) return;
    if (this.q.length === 0) {
      this.resolveFlushWaitersIfIdle();
      return;
    }

    this.draining = true;

    // Non-blocking drain
    queueMicrotask(() => void this.drain());
  }

  private resolveFlushWaitersIfIdle(): void {
    if (this.draining) return;
    if (this.q.length !== 0) return;

    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const w of waiters) w();
  }

  private async drain(): Promise<void> {
    try {
      while (this.q.length) {
        const evt = this.q.shift()!;
        try {
          await this.opts.sinkAsync(evt);
        } catch (err) {
          if (this.opts.onError) this.opts.onError(err);
        }
      }
    } finally {
      this.draining = false;
      // resolve flush waiters if idle now
      this.resolveFlushWaitersIfIdle();
      // if items arrived during finishing, restart
      if (this.q.length) this.kick();
    }
  }
}