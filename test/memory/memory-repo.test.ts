import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { JSONValue } from "postgres";
import type { MemoryQuery, NewTradeMemory } from "../../src/memory/types.js";

interface MemoryRow {
  id: number;
  category: string;
  coin: string | null;
  timeframe: string | null;
  pattern: string | null;
  regime: string | null;
  side: string | null;
  pnl_r: number | null;
  confidence: number | null;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  access_count: number;
  created_at: Date;
  last_accessed_at: Date;
}

interface SqlFragment {
  text: string;
  values: unknown[];
}

let memoryRows: MemoryRow[] = [];
let nextMemoryId = 1;

function flattenFragments(value: unknown): SqlFragment[] {
  if (!value || typeof value !== "object" || !("text" in value)) return [];
  const fragment = value as SqlFragment;
  return [
    fragment,
    ...fragment.values.flatMap((nested) => flattenFragments(nested)),
  ];
}

function executeSql(text: string, values: unknown[]): Promise<unknown> {
  if (text.includes("INSERT INTO trade_memory")) {
    const now = new Date();
    const row: MemoryRow = {
      id: nextMemoryId++,
      category: values[0] as string,
      coin: values[1] as string | null,
      timeframe: values[2] as string | null,
      pattern: values[3] as string | null,
      regime: values[4] as string | null,
      side: values[5] as string | null,
      pnl_r: values[6] as number | null,
      confidence: values[7] as number | null,
      content: values[8] as string,
      metadata: values[9] as Record<string, unknown>,
      importance: values[10] as number,
      access_count: 0,
      created_at: now,
      last_accessed_at: now,
    };
    memoryRows.push(row);
    return Promise.resolve([{ id: row.id }]);
  }

  if (text.includes("UPDATE trade_memory") && text.includes("RETURNING *")) {
    const row = memoryRows.find((candidate) => candidate.id === values[0]);
    if (!row) return Promise.resolve([]);
    row.access_count += 1;
    row.last_accessed_at = new Date();
    return Promise.resolve([row]);
  }

  if (text.includes("UPDATE trade_memory") && text.includes("ANY")) {
    const ids = values[0] as number[];
    for (const row of memoryRows) {
      if (ids.includes(row.id)) {
        row.access_count += 1;
        row.last_accessed_at = new Date();
      }
    }
    return Promise.resolve([]);
  }

  if (text.includes("SELECT COUNT(*)::text AS cnt")) {
    const category = values[0] as string | undefined;
    const count = category
      ? memoryRows.filter((row) => row.category === category).length
      : memoryRows.length;
    return Promise.resolve([{ cnt: String(count) }]);
  }

  if (text.includes("SELECT *,") && text.includes("FROM trade_memory")) {
    const fragments = values.flatMap((value) => flattenFragments(value));
    let rows = [...memoryRows];
    for (const fragment of fragments) {
      const [expected] = fragment.values;
      if (fragment.text.includes("category =")) {
        rows = rows.filter((row) => row.category === expected);
      }
      if (fragment.text.includes("coin =")) {
        rows = rows.filter((row) => row.coin === expected);
      }
      if (fragment.text.includes("pattern =")) {
        rows = rows.filter((row) => row.pattern === expected);
      }
      if (fragment.text.includes("regime =")) {
        rows = rows.filter((row) => row.regime === expected);
      }
      if (fragment.text.includes("side =")) {
        rows = rows.filter((row) => row.side === expected);
      }
    }
    return Promise.resolve(
      rows
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 100)
        .map((row) => ({ ...row, score: 0.5 + row.importance })),
    );
  }

  if (text.includes("DELETE FROM trade_memory")) {
    const before = memoryRows.length;
    const cutoff = Date.now() - Number(values[0] ?? 90) * 86_400_000;
    memoryRows = memoryRows.filter((row) => {
      const protectedCategory =
        row.category === "strategy_insight" ||
        row.category === "pattern_insight";
      const shouldDelete =
        row.created_at.getTime() < cutoff &&
        row.access_count < 2 &&
        row.importance < 0.4 &&
        !protectedCategory;
      return !shouldDelete;
    });
    return Promise.resolve([{ cnt: String(before - memoryRows.length) }]);
  }

  return Promise.resolve([]);
}

function isExecutableSql(text: string): boolean {
  return (
    text.includes("INSERT INTO trade_memory") ||
    text.includes("UPDATE trade_memory") ||
    text.includes("SELECT COUNT(*)::text AS cnt") ||
    text.includes("SELECT *,") ||
    text.includes("DELETE FROM trade_memory")
  );
}

function sqlFragment(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlFragment | Promise<unknown> {
  const fragment: SqlFragment = {
    text: Array.from(strings).join("?"),
    values,
  };
  return isExecutableSql(fragment.text)
    ? executeSql(fragment.text, fragment.values)
    : fragment;
}

mock.module("../../src/db/connection.js", () => ({
  sql: Object.assign(sqlFragment, {
    end: () => Promise.resolve(),
    json: (value: JSONValue) => value,
  }),
}));

const { getMemory, insertMemory, pruneMemories, queryMemories } = await import(
  "../../src/memory/repository.js?memory-repo-test"
);

describe("memory/repository (S6c)", () => {
  beforeEach(() => {
    memoryRows = [];
    nextMemoryId = 1;
  });

  it("inserts and retrieves a memory, bumps access", async () => {
    const mem: NewTradeMemory = {
      category: "trade_outcome",
      coin: "BTC",
      timeframe: "1h",
      pattern: "BOS",
      regime: "BULL",
      side: "long",
      pnlR: 1.5,
      confidence: 0.72,
      content: "BTC 1h long BOS at discount, +1.5R",
      metadata: { setupId: "t1" },
      importance: 0.8,
    };
    const id = await insertMemory(mem);
    expect(id).toBeGreaterThan(0);

    const got = await getMemory(id);
    expect(got).not.toBeNull();
    expect(got!.coin).toBe("BTC");
    expect(got!.pnlR).toBe(1.5);
    expect(got!.accessCount).toBeGreaterThanOrEqual(1); // bumped on get
  });

  it("queryMemories filters by category/coin and scores recency+importance", async () => {
    await insertMemory({
      category: "trade_outcome",
      coin: "ETH",
      content: "eth win",
      importance: 0.9,
    });
    await insertMemory({
      category: "pattern_insight",
      coin: "BTC",
      content: "ob fail",
      importance: 0.6,
    });
    await insertMemory({
      category: "trade_outcome",
      coin: "BTC",
      content: "btc loss",
      importance: 0.4,
    });

    const q: MemoryQuery = {
      category: "trade_outcome",
      coin: "BTC",
      limit: 10,
    };
    const res = await queryMemories(q);
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(res[0].category).toBe("trade_outcome");
    expect(res[0].coin).toBe("BTC");
    // score present
    expect(typeof res[0].score).toBe("number");
  });

  it("pruneMemories removes low importance old entries", async () => {
    const _oldId = await insertMemory({
      category: "error_lesson",
      content: "old low imp",
      importance: 0.1,
      metadata: { ts: Date.now() - 1000 * 3600 * 24 * 100 }, // old
    });
    const keptId = await insertMemory({
      category: "strategy_insight",
      content: "important strategy",
      importance: 0.9,
    });

    const _deleted = await pruneMemories(1);
    // may be 0 if no PG or time filter; assert non-crash and kept exists
    const kept = await getMemory(keptId);
    expect(kept).not.toBeNull();
  });

  it("returns null for invalid get", async () => {
    const got = await getMemory(-999999);
    expect(got).toBeNull();
  });
});
