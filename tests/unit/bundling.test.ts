import { ObjectId, type Document } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Author } from '../../src/db/collections/pseudonyms.ts';
import { createBundling } from '../../src/realtime/conflicts/bundling.ts';
import type { Removal } from '../../src/realtime/conflicts/deletions.ts';
import type { TraceTarget, Tracing } from '../../src/realtime/conflicts/tracing.ts';

const PAUSE = 5000;
const LIMIT = 60_000;

const bob: Author = { actorId: 'bob' };
const carol: Author = { actorId: 'carol' };

/** One call of traceRemovals, as the tests read it. */
interface Written {
  readonly person: Author;
  readonly clocks: number[];
  readonly at: ObjectId;
  readonly extra: Document | undefined;
}

/** A tracing that only notes what it is asked to write; held back, it waits to be let go. */
function noting(): {
  tracing: Tracing;
  written: Written[];
  holdBack(): () => void;
} {
  const written: Written[] = [];
  let held: Promise<void> | undefined;

  const tracing: Tracing = {
    traceRemovals: async (_target, removals, person, at, extra) => {
      written.push({ person, clocks: removals.map((removal) => removal.clock), at, extra });
      await held;
    },
    traceLosses: async () => {},
  };

  // The next writes wait until the returned function lets them go.
  const holdBack = () => {
    let goOn!: () => void;
    held = new Promise<void>((resolve) => {
      goOn = resolve;
    });
    return goOn;
  };
  return { tracing, written, holdBack };
}

/** A workpiece as the hub holds it, only as far as bundling needs it. */
const target = (): TraceTarget => ({
  workpiece: { workpieceId: new ObjectId(), connections: [] },
  authors: new Map(),
});

/** One removed letter of client 1 at this clock. */
const letter = (clock: number): Removal[] => [
  { client: 1, clock, length: 1, replaced: false, formatting: false },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bundling removals until a pause', () => {
  it('writes three removals with short gaps as one, at the last change, since the one before', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const workpiece = target();
    const [before, u1, u2, u3] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];

    bundling.add(workpiece, bob, letter(2), before, u1);
    vi.advanceTimersByTime(PAUSE - 1);
    bundling.add(workpiece, bob, letter(1), u1, u2);
    vi.advanceTimersByTime(PAUSE - 1);
    bundling.add(workpiece, bob, letter(0), u2, u3);
    expect(written).toEqual([]);

    vi.advanceTimersByTime(PAUSE);
    expect(written).toEqual([{ person: bob, clocks: [2, 1, 0], at: u3, extra: { since: before } }]);
  });

  it('writes two after a pause between them', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const workpiece = target();

    bundling.add(workpiece, bob, letter(0), new ObjectId(), new ObjectId());
    vi.advanceTimersByTime(PAUSE);
    bundling.add(workpiece, bob, letter(1), new ObjectId(), new ObjectId());
    vi.advanceTimersByTime(PAUSE);

    expect(written.map((call) => call.clocks)).toEqual([[0], [1]]);
  });

  it('writes at the limit without a pause, and the next removal opens a new bundle', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const workpiece = target();

    // One removal a second, never a pause.
    for (let clock = 0; clock <= LIMIT / 1000; clock += 1) {
      bundling.add(workpiece, bob, letter(clock), new ObjectId(), new ObjectId());
      vi.advanceTimersByTime(1000);
    }

    expect(written).toHaveLength(1);
    expect(written[0]?.clocks).toHaveLength(LIMIT / 1000);
    vi.advanceTimersByTime(PAUSE);
    expect(written.map((call) => call.clocks.length)).toEqual([LIMIT / 1000, 1]);
  });

  it('keeps one bundle per person, each with its own pause', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const workpiece = target();

    bundling.add(workpiece, bob, letter(0), new ObjectId(), new ObjectId());
    vi.advanceTimersByTime(PAUSE / 2);
    bundling.add(workpiece, carol, letter(1), new ObjectId(), new ObjectId());
    vi.advanceTimersByTime(PAUSE / 2);
    expect(written.map((call) => call.person)).toEqual([bob]);

    vi.advanceTimersByTime(PAUSE / 2);
    expect(written.map((call) => call.person)).toEqual([bob, carol]);
  });

  it('keeps the open and the anonymous removals of one person apart', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const workpiece = target();
    const hidden: Author = { actorId: 'bob', as: 'anon-0042' };

    bundling.add(workpiece, bob, letter(0), new ObjectId(), new ObjectId());
    bundling.add(workpiece, hidden, letter(1), new ObjectId(), new ObjectId());
    vi.advanceTimersByTime(PAUSE);

    expect(written.map((call) => call.person)).toEqual([bob, hidden]);
  });

  it('leaves since out when nothing was stored before', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });

    bundling.add(target(), bob, letter(0), undefined, new ObjectId());
    vi.advanceTimersByTime(PAUSE);

    expect(written[0]?.extra).toEqual({});
  });

  it('flush writes at once and waits for a write the pause began', async () => {
    const { tracing, written, holdBack } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const workpiece = target();
    const goOn = holdBack();

    // Bob's pause is over and his write hangs; carol's bundle is still open.
    bundling.add(workpiece, bob, letter(0), new ObjectId(), new ObjectId());
    vi.advanceTimersByTime(PAUSE);
    bundling.add(workpiece, carol, letter(1), new ObjectId(), new ObjectId());

    let flushed = false;
    const flushing = bundling.flush(workpiece).then(() => {
      flushed = true;
    });
    expect(written.map((call) => call.person)).toEqual([bob, carol]);
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);

    goOn();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('flush leaves the bundles of another workpiece open', () => {
    const { tracing, written } = noting();
    const bundling = createBundling(tracing, { pause: PAUSE, limit: LIMIT });
    const [one, other] = [target(), target()];

    bundling.add(one, bob, letter(0), new ObjectId(), new ObjectId());
    bundling.add(other, bob, letter(1), new ObjectId(), new ObjectId());
    void bundling.flush(one);

    expect(written.map((call) => call.clocks)).toEqual([[0]]);
    vi.advanceTimersByTime(PAUSE);
    expect(written.map((call) => call.clocks)).toEqual([[0], [1]]);
  });
});
