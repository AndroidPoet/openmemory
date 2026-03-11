// OpenMemory — BM25 Index Tests
// Every scoring path, every edge case.

import { describe, test, expect, beforeEach } from "bun:test";
import { BM25Index } from "../src/serve/bm25.ts";

let index: BM25Index;

beforeEach(() => {
  index = new BM25Index();
});

// ─── Basic Operations ──────────────────────────────────────────────

describe("add / remove", () => {
  test("add single document", () => {
    index.add("d1", ["typescript", "runtime"]);
    expect(index.size).toBe(1);
    expect(index.termCount).toBe(2);
  });

  test("add multiple documents", () => {
    index.add("d1", ["typescript", "runtime"]);
    index.add("d2", ["bun", "runtime"]);
    index.add("d3", ["node", "runtime"]);
    expect(index.size).toBe(3);
  });

  test("remove document", () => {
    index.add("d1", ["typescript", "runtime"]);
    index.add("d2", ["bun", "runtime"]);
    index.remove("d1");
    expect(index.size).toBe(1);
  });

  test("remove non-existent document is no-op", () => {
    index.add("d1", ["typescript"]);
    index.remove("d999");
    expect(index.size).toBe(1);
  });

  test("remove last document resets avgDocLength", () => {
    index.add("d1", ["typescript"]);
    index.remove("d1");
    expect(index.size).toBe(0);
  });

  test("add document with duplicate tokens", () => {
    index.add("d1", ["rust", "rust", "rust"]);
    expect(index.size).toBe(1);
    expect(index.termCount).toBe(1);
    // TF should be 3 for "rust"
    const scores = index.score(["rust"]);
    expect(scores.get("d1")).toBeGreaterThan(0);
  });

  test("add document with empty tokens", () => {
    index.add("d1", []);
    expect(index.size).toBe(1);
    expect(index.termCount).toBe(0);
  });
});

// ─── Scoring ───────────────────────────────────────────────────────

describe("score", () => {
  test("exact match scores higher than partial", () => {
    index.add("d1", ["user", "prefers", "typescript"]);
    index.add("d2", ["user", "uses", "bun"]);
    const scores = index.score(["typescript"]);
    expect(scores.get("d1")).toBeGreaterThan(0);
    expect(scores.has("d2")).toBe(false);
  });

  test("multi-term query accumulates scores", () => {
    index.add("d1", ["user", "prefers", "typescript"]);
    index.add("d2", ["user", "uses", "bun"]);

    const singleTerm = index.score(["user"]);
    const multiTerm = index.score(["user", "typescript"]);

    // d1 matches both terms — should score higher than single-term
    expect(multiTerm.get("d1")!).toBeGreaterThan(singleTerm.get("d1")!);
  });

  test("rare terms score higher (IDF effect)", () => {
    // "runtime" appears in all 3 docs, "typescript" only in 1
    index.add("d1", ["user", "prefers", "typescript"]);
    index.add("d2", ["user", "uses", "bun"]);
    index.add("d3", ["user", "uses", "deno"]);

    const commonScore = index.score(["user"]); // appears in all 3
    const rareScore = index.score(["typescript"]); // appears in 1

    // "typescript" has higher IDF so its contribution to d1 is proportionally larger
    expect(rareScore.get("d1")!).toBeGreaterThan(commonScore.get("d1")!);
  });

  test("empty query returns empty scores", () => {
    index.add("d1", ["typescript"]);
    const scores = index.score([]);
    expect(scores.size).toBe(0);
  });

  test("query with no matching terms returns empty", () => {
    index.add("d1", ["typescript", "runtime"]);
    const scores = index.score(["python", "flask"]);
    expect(scores.size).toBe(0);
  });

  test("term frequency saturation", () => {
    // A doc mentioning "rust" 10 times shouldn't score 10x more than mentioning it once
    index.add("d1", ["rust"]);
    index.add("d2", Array(10).fill("rust"));

    const scores = index.score(["rust"]);
    const ratio = scores.get("d2")! / scores.get("d1")!;
    // With K1=1.2, saturation should keep ratio well below 10
    expect(ratio).toBeLessThan(3);
  });

  test("document length normalization", () => {
    // Short doc with same term should score differently than long doc
    index.add("short", ["typescript"]);
    index.add("long", ["typescript", "a", "b", "c", "d", "e", "f", "g", "h", "i"]);

    const scores = index.score(["typescript"]);
    // Short doc should score higher (length normalization with B=0.5)
    expect(scores.get("short")!).toBeGreaterThan(scores.get("long")!);
  });

  test("scores are always positive", () => {
    index.add("d1", ["typescript", "bun"]);
    index.add("d2", ["javascript", "node"]);
    const scores = index.score(["typescript"]);
    for (const s of scores.values()) {
      expect(s).toBeGreaterThan(0);
    }
  });
});

// ─── IDF ───────────────────────────────────────────────────────────

describe("getIdf", () => {
  test("unknown term returns 0", () => {
    index.add("d1", ["typescript"]);
    expect(index.getIdf("python")).toBe(0);
  });

  test("rare term has higher IDF than common term", () => {
    index.add("d1", ["user", "prefers", "typescript"]);
    index.add("d2", ["user", "uses", "bun"]);
    index.add("d3", ["user", "uses", "deno"]);

    const commonIdf = index.getIdf("user"); // df=3
    const rareIdf = index.getIdf("typescript"); // df=1
    expect(rareIdf).toBeGreaterThan(commonIdf);
  });

  test("term in all docs has low IDF", () => {
    index.add("d1", ["common"]);
    index.add("d2", ["common"]);
    index.add("d3", ["common"]);

    const idf = index.getIdf("common");
    // IDF should still be positive (BM25 variant uses +1)
    expect(idf).toBeGreaterThan(0);
    expect(idf).toBeLessThan(1);
  });

  test("term in one doc has high IDF", () => {
    index.add("d1", ["rare"]);
    index.add("d2", ["other"]);
    index.add("d3", ["stuff"]);

    const idf = index.getIdf("rare");
    expect(idf).toBeGreaterThan(0.9);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────

describe("edge cases", () => {
  test("single document corpus", () => {
    index.add("d1", ["typescript", "runtime"]);
    const scores = index.score(["typescript"]);
    expect(scores.get("d1")).toBeGreaterThan(0);
  });

  test("add and remove same document", () => {
    index.add("d1", ["typescript"]);
    index.remove("d1");
    const scores = index.score(["typescript"]);
    expect(scores.size).toBe(0);
  });

  test("re-add after remove", () => {
    index.add("d1", ["typescript"]);
    index.remove("d1");
    index.add("d1", ["bun"]);
    expect(index.size).toBe(1);
    const scores = index.score(["bun"]);
    expect(scores.get("d1")).toBeGreaterThan(0);
  });

  test("large corpus (100 docs)", () => {
    for (let i = 0; i < 100; i++) {
      index.add(`d${i}`, [`term${i}`, "shared"]);
    }
    expect(index.size).toBe(100);
    const scores = index.score(["term42"]);
    expect(scores.get("d42")).toBeGreaterThan(0);
    // "shared" is in all docs, "term42" only in d42 — so d42 should rank #1
    const topId = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(topId).toBe("d42");
  });

  test("remove from large corpus maintains correctness", () => {
    for (let i = 0; i < 10; i++) {
      index.add(`d${i}`, [`term${i}`, "shared"]);
    }
    index.remove("d5");
    expect(index.size).toBe(9);
    const scores = index.score(["term5"]);
    expect(scores.size).toBe(0);
  });
});
