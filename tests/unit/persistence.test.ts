import { describe, expect, it } from 'vitest';

import { enqueue } from '../../src/realtime/persistence.ts';

describe('enqueue', () => {
  it('runs work one after another, in the order it was queued', async () => {
    const copy = { queue: Promise.resolve() };
    const order: string[] = [];

    const slow = enqueue(copy, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first');
    });
    const fast = enqueue(copy, () => {
      order.push('second');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });

  it('hands a failure to whoever queued the work and carries on with the rest', async () => {
    const copy = { queue: Promise.resolve() };

    const failing = enqueue(copy, () => {
      throw new Error('lost');
    });
    const next = enqueue(copy, () => 'still runs');

    await expect(failing).rejects.toThrow('lost');
    await expect(next).resolves.toBe('still runs');
  });
});
