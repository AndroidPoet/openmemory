// OpenMemory — Reciprocal Rank Fusion Tests
// Every fusion path, every weight scenario, every edge case.

import { describe, test, expect } from "bun:test";
import { reciprocalRankFusion, normalizeScores, type RankedList } from "../src/serve/fusion.ts";

// ─── Basic RRF ─────────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  test("single ranker preserves order", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b", "c"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    expect(results[0]!.id).toBe("a");
    expect(results[1]!.id).toBe("b");
    expect(results[2]!.id).toBe("c");
  });

  test("two rankers agree — order preserved", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b", "c"], weight: 1.0 },
      { name: "vector", items: ["a", "b", "c"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    expect(results[0]!.id).toBe("a");
    expect(results[1]!.id).toBe("b");
    expect(results[2]!.id).toBe("c");
  });

  test("two rankers disagree — consensus wins", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b", "c"], weight: 1.0 },
      { name: "vector", items: ["b", "a", "c"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    // Both "a" and "b" appear in top positions across rankers
    // "a" is rank 1+2, "b" is rank 2+1 — they should tie, but "c" should be last
    expect(results[2]!.id).toBe("c");
  });

  test("weighted ranker dominates", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b"], weight: 10.0 },  // heavily weighted
      { name: "vector", items: ["b", "a"], weight: 0.1 },  // barely counts
    ];
    const results = reciprocalRankFusion(lists);
    // BM25 weight=10 dominates, so "a" should win
    expect(results[0]!.id).toBe("a");
  });

  test("disjoint rankers — all items appear", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b"], weight: 1.0 },
      { name: "vector", items: ["c", "d"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    expect(results.length).toBe(4);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  test("empty rankers return empty", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: [], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    expect(results.length).toBe(0);
  });

  test("no rankers return empty", () => {
    const results = reciprocalRankFusion([]);
    expect(results.length).toBe(0);
  });

  test("rank positions are 1-indexed in output", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b"], weight: 1.0 },
      { name: "vector", items: ["b", "a"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    // Check that ranks are 1-indexed
    for (const r of results) {
      for (const rank of Object.values(r.ranks)) {
        expect(rank).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("scores are positive", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  test("results are sorted by score descending", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["a", "b", "c"], weight: 1.0 },
      { name: "vector", items: ["c", "a", "b"], weight: 0.8 },
      { name: "entity", items: ["b", "c", "a"], weight: 0.5 },
    ];
    const results = reciprocalRankFusion(lists);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("4 rankers (production scenario)", () => {
    const lists: RankedList[] = [
      { name: "bm25", items: ["f1", "f2", "f3"], weight: 2.0 },
      { name: "vector", items: ["f2", "f1", "f4"], weight: 0.6 },
      { name: "entity", items: ["f3", "f1", "f2"], weight: 0.7 },
      { name: "temporal", items: ["f4", "f1", "f3"], weight: 0.3 },
    ];
    const results = reciprocalRankFusion(lists);
    // f1 appears in all 4 rankers — should be near top
    const f1 = results.find((r) => r.id === "f1")!;
    expect(f1.ranks).toHaveProperty("bm25");
    expect(f1.ranks).toHaveProperty("vector");
    expect(f1.ranks).toHaveProperty("entity");
    expect(f1.ranks).toHaveProperty("temporal");
  });

  test("K=60 prevents top-rank domination", () => {
    // With K=60, rank 1 score = w/(61), rank 2 = w/(62)
    // The ratio is 62/61 ≈ 1.016 — NOT a huge gap
    const lists: RankedList[] = [
      { name: "r1", items: ["a", "b"], weight: 1.0 },
    ];
    const results = reciprocalRankFusion(lists);
    const ratio = results[0]!.score / results[1]!.score;
    expect(ratio).toBeLessThan(1.05); // Very close scores
  });
});

// ─── Normalize Scores ──────────────────────────────────────────────

describe("normalizeScores", () => {
  test("normalizes to [0, 1]", () => {
    const scores = new Map([["a", 10], ["b", 5], ["c", 1]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(1.0);
    expect(normalized.get("b")).toBe(0.5);
    expect(normalized.get("c")).toBe(0.1);
  });

  test("empty map returns empty", () => {
    const normalized = normalizeScores(new Map());
    expect(normalized.size).toBe(0);
  });

  test("all zeros returns same map", () => {
    const scores = new Map([["a", 0], ["b", 0]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(0);
    expect(normalized.get("b")).toBe(0);
  });

  test("single item normalizes to 1.0", () => {
    const scores = new Map([["a", 42]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(1.0);
  });
});
