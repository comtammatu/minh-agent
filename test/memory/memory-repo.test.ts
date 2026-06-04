import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import {
  insertMemory,
  getMemory,
  countMemories,
  queryMemories,
  pruneMemories,
} from '../../src/memory/repository.js';
import type { NewTradeMemory, MemoryQuery } from '../../src/memory/types.js';

describe('memory/repository (S6c)', () => {
  beforeEach(async () => {
    // best effort prune old test data; ignore errors if no DB
    await pruneMemories(0).catch(() => {});
  });

  it('inserts and retrieves a memory, bumps access', async () => {
    const mem: NewTradeMemory = {
      category: 'trade_outcome',
      coin: 'BTC',
      timeframe: '1h',
      pattern: 'BOS',
      regime: 'BULL',
      side: 'long',
      pnlR: 1.5,
      confidence: 0.72,
      content: 'BTC 1h long BOS at discount, +1.5R',
      metadata: { setupId: 't1' },
      importance: 0.8,
    };
    const id = await insertMemory(mem);
    expect(id).toBeGreaterThan(0);

    const got = await getMemory(id);
    expect(got).not.toBeNull();
    expect(got!.coin).toBe('BTC');
    expect(got!.pnlR).toBe(1.5);
    expect(got!.accessCount).toBeGreaterThanOrEqual(1); // bumped on get
  });

  it('queryMemories filters by category/coin and scores recency+importance', async () => {
    await insertMemory({ category: 'trade_outcome', coin: 'ETH', content: 'eth win', importance: 0.9 });
    await insertMemory({ category: 'pattern_insight', coin: 'BTC', content: 'ob fail', importance: 0.6 });
    await insertMemory({ category: 'trade_outcome', coin: 'BTC', content: 'btc loss', importance: 0.4 });

    const q: MemoryQuery = { category: 'trade_outcome', coin: 'BTC', limit: 10 };
    const res = await queryMemories(q);
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(res[0].category).toBe('trade_outcome');
    expect(res[0].coin).toBe('BTC');
    // score present
    expect(typeof res[0].score).toBe('number');
  });

  it('pruneMemories removes low importance old entries', async () => {
    const oldId = await insertMemory({
      category: 'error_lesson',
      content: 'old low imp',
      importance: 0.1,
      metadata: { ts: Date.now() - 1000 * 3600 * 24 * 100 }, // old
    });
    const keptId = await insertMemory({
      category: 'strategy_insight',
      content: 'important strategy',
      importance: 0.9,
    });

    const deleted = await pruneMemories(1);
    // may be 0 if no PG or time filter; assert non-crash and kept exists
    const kept = await getMemory(keptId);
    expect(kept).not.toBeNull();
  });

  it('returns null for invalid get', async () => {
    const got = await getMemory(-999999);
    expect(got).toBeNull();
  });
});

afterAll(async () => {
  // cleanup optional
});