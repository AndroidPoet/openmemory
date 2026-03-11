// OpenMemory — Hot Index Integration Tests
// Full search pipeline, adaptive weighting, entity ranking, edge cases.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { HotIndex } from "../src/serve/hot-index.ts";
import { embed } from "../src/extract/embedding.ts";
import type { Fact, DecayConfig } from "../src/types/index.ts";

const DECAY: DecayConfig = {
  halfLifeDays: 30,
  accessBoost: 0.15,
  minStrength: 0.05,
  supersededPenalty: 0.7,
};

let db: Database;
let index: HotIndex;

function createSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8, source TEXT NOT NULL DEFAULT 'conversation',
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')), access_count INTEGER NOT NULL DEFAULT 0,
    strength REAL NOT NULL DEFAULT 1.0, superseded_by TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS vec_facts (
    fact_id TEXT PRIMARY KEY, embedding BLOB NOT NULL
  )`);
}

function makeFact(id: string, subject: string, predicate: string, object: string, opts?: {
  confidence?: number; namespace?: string; strength?: number;
}): Fact {
  return {
    id, subject, predicate, object,
    confidence: opts?.confidence ?? 0.8,
    source: "test",
    namespace: opts?.namespace ?? "default",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    strength: opts?.strength ?? 1.0,
    supersededBy: null,
  };
}

function addFact(id: string, subject: string, predicate: string, object: string, opts?: {
  confidence?: number; namespace?: string; strength?: number;
}): Fact {
  const fact = makeFact(id, subject, predicate, object, opts);
  const text = `${subject} ${predicate} ${object}`;
  const embedding = embed(text);
  index.add(fact, embedding);
  return fact;
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  index = new HotIndex(db, DECAY);
});

afterEach(() => {
  db.close();
});

// ─── Add / Remove ──────────────────────────────────────────────────

describe("add / remove", () => {
  test("add fact updates stats", () => {
    addFact("f1", "user", "uses", "Bun");
    const stats = index.getStats();
    expect(stats.factsInMemory).toBe(1);
    expect(stats.uniqueEntities).toBeGreaterThan(0);
  });

  test("remove fact updates stats", () => {
    addFact("f1", "user", "uses", "Bun");
    index.remove("f1");
    const stats = index.getStats();
    expect(stats.factsInMemory).toBe(0);
  });

  test("remove non-existent is no-op", () => {
    index.remove("nonexistent");
    expect(index.getStats().factsInMemory).toBe(0);
  });

  test("supersede removes old fact", () => {
    addFact("f1", "user", "works_at", "Google");
    addFact("f2", "user", "works_at", "Meta");
    index.supersede("f1", "f2");
    expect(index.getStats().factsInMemory).toBe(1);
  });
});

// ─── Search: Basic ─────────────────────────────────────────────────

describe("search basics", () => {
  test("empty index returns empty", () => {
    const results = index.search("anything");
    expect(results.length).toBe(0);
  });

  test("finds exact match", () => {
    addFact("f1", "user", "prefers", "TypeScript");
    const results = index.search("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.object).toBe("TypeScript");
  });

  test("finds partial match", () => {
    addFact("f1", "user", "prefers", "dark mode");
    addFact("f2", "user", "uses", "Bun");
    const results = index.search("dark mode");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe("f1");
  });

  test("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      addFact(`f${i}`, "user", "uses", `tool${i}`);
    }
    const results = index.search("tool", "default", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("empty query returns by strength", () => {
    addFact("f1", "user", "uses", "Bun");
    addFact("f2", "user", "uses", "Deno", { strength: 0.5 });
    // Query with only stop words → no meaningful tokens
    const results = index.search("the is a");
    expect(results.length).toBe(2);
  });
});

// ─── Namespace Isolation ───────────────────────────────────────────

describe("namespace isolation", () => {
  test("search only returns facts from specified namespace", () => {
    addFact("f1", "user", "uses", "Bun", { namespace: "ns1" });
    addFact("f2", "user", "uses", "Deno", { namespace: "ns2" });

    const results = index.search("runtime", "ns1");
    // Should not contain f2
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("f2");
  });

  test("unknown namespace returns empty", () => {
    addFact("f1", "user", "uses", "Bun");
    const results = index.search("Bun", "nonexistent");
    expect(results.length).toBe(0);
  });
});

// ─── Relevance Ranking ─────────────────────────────────────────────

describe("relevance ranking", () => {
  test("exact keyword match ranks higher than tangential", () => {
    addFact("f1", "user", "prefers", "TypeScript");
    addFact("f2", "user", "uses", "Bun");
    addFact("f3", "project", "deploys_on", "Vercel");

    const results = index.search("TypeScript");
    expect(results[0]!.id).toBe("f1");
  });

  test("multi-keyword query finds intersection", () => {
    addFact("f1", "user", "prefers", "TypeScript");
    addFact("f2", "user", "uses", "Bun");
    addFact("f3", "Testing", "uses", "Vitest");

    const results = index.search("user TypeScript");
    // f1 matches both "user" and "typescript"
    expect(results[0]!.id).toBe("f1");
  });

  test("semantically similar query finds relevant fact", () => {
    addFact("f1", "user", "prefers", "dark mode");
    addFact("f2", "user", "uses", "PostgreSQL");

    const results = index.search("what theme does the user like");
    // "dark mode" should rank higher than "PostgreSQL" for this query
    // even though BM25 might not match exactly, vector similarity should help
    const darkMode = results.find((r) => r.id === "f1");
    expect(darkMode).toBeDefined();
  });
});

// ─── Entity Lookup ─────────────────────────────────────────────────

describe("aboutEntity", () => {
  test("returns facts about entity", () => {
    addFact("f1", "user", "uses", "Bun");
    addFact("f2", "user", "prefers", "TypeScript");
    addFact("f3", "project", "uses", "React");

    const results = index.aboutEntity("user");
    expect(results.length).toBe(2);
  });

  test("case-insensitive lookup", () => {
    addFact("f1", "TypeScript", "is", "language");
    const results = index.aboutEntity("typescript");
    expect(results.length).toBe(1);
  });

  test("unknown entity returns empty", () => {
    const results = index.aboutEntity("unknown_entity");
    expect(results.length).toBe(0);
  });

  test("respects namespace", () => {
    addFact("f1", "user", "uses", "Bun", { namespace: "ns1" });
    addFact("f2", "user", "uses", "Deno", { namespace: "ns2" });

    const results = index.aboutEntity("user", "ns1");
    expect(results.length).toBe(1);
    expect(results[0]!.object).toBe("Bun");
  });

  test("sorted by score (strength × confidence)", () => {
    addFact("f1", "user", "uses", "Bun", { confidence: 0.5 });
    addFact("f2", "user", "prefers", "TypeScript", { confidence: 0.9 });

    const results = index.aboutEntity("user");
    expect(results[0]!.id).toBe("f2"); // higher confidence
  });
});

// ─── Stats ─────────────────────────────────────────────────────────

describe("getStats", () => {
  test("empty index stats", () => {
    const stats = index.getStats();
    expect(stats.factsInMemory).toBe(0);
    expect(stats.uniqueEntities).toBe(0);
    expect(stats.namespaces).toEqual([]);
    expect(stats.memoryBytes).toBe(0);
  });

  test("populated index stats", () => {
    addFact("f1", "user", "uses", "Bun");
    addFact("f2", "user", "prefers", "TypeScript");

    const stats = index.getStats();
    expect(stats.factsInMemory).toBe(2);
    expect(stats.uniqueEntities).toBeGreaterThan(0);
    expect(stats.bm25Terms).toBeGreaterThan(0);
    expect(stats.namespaces).toContain("default");
    expect(stats.memoryBytes).toBeGreaterThan(0);
  });
});

// ─── Load from DB ──────────────────────────────────────────────────

describe("load", () => {
  test("loads facts from database", () => {
    // Insert directly into DB
    const fact = makeFact("f1", "user", "uses", "Bun");
    const embedding = embed("user uses Bun");

    db.prepare(`INSERT INTO facts (id, subject, predicate, object, confidence, source, namespace, strength)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fact.id, fact.subject, fact.predicate, fact.object,
      fact.confidence, fact.source, fact.namespace, fact.strength,
    );
    db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)").run(
      fact.id, new Uint8Array(embedding.buffer),
    );

    const result = index.load();
    expect(result.facts).toBe(1);
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
  });

  test("skips superseded facts", () => {
    const embedding = new Uint8Array(embed("test").buffer);

    db.prepare(`INSERT INTO facts (id, subject, predicate, object, confidence, source, namespace, strength, superseded_by)
      VALUES ('f1', 'user', 'uses', 'Bun', 0.8, 'test', 'default', 1.0, 'f2')`).run();
    db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES ('f1', ?)").run(embedding);

    db.prepare(`INSERT INTO facts (id, subject, predicate, object, confidence, source, namespace, strength)
      VALUES ('f2', 'user', 'uses', 'Deno', 0.8, 'test', 'default', 1.0)`).run();
    db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES ('f2', ?)").run(embedding);

    const result = index.load();
    expect(result.facts).toBe(1); // only f2 loaded
  });

  test("skips weak facts", () => {
    const embedding = new Uint8Array(embed("test").buffer);

    db.prepare(`INSERT INTO facts (id, subject, predicate, object, confidence, source, namespace, strength)
      VALUES ('f1', 'user', 'uses', 'Bun', 0.8, 'test', 'default', 0.01)`).run();
    db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES ('f1', ?)").run(embedding);

    const result = index.load();
    expect(result.facts).toBe(0);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────

describe("edge cases", () => {
  test("search with only stop words falls back to strength", () => {
    addFact("f1", "user", "uses", "Bun", { strength: 1.0 });
    addFact("f2", "user", "uses", "Deno", { strength: 0.5 });

    const results = index.search("the and is", "default", 10);
    // Should return all facts sorted by strength
    expect(results.length).toBe(2);
    expect(results[0]!.strength).toBeGreaterThanOrEqual(results[1]!.strength);
  });

  test("handles special characters in query", () => {
    addFact("f1", "user", "uses", "C++");
    const results = index.search("C++ programming");
    // Should not crash
    expect(results).toBeDefined();
  });

  test("handles very long query", () => {
    addFact("f1", "user", "uses", "Bun");
    const longQuery = "What is the runtime that the user prefers to use for their JavaScript and TypeScript projects these days";
    const results = index.search(longQuery);
    expect(results).toBeDefined();
  });

  test("minConfidence filters low-confidence facts", () => {
    addFact("f1", "user", "uses", "Bun", { confidence: 0.3 });
    addFact("f2", "user", "prefers", "TypeScript", { confidence: 0.9 });

    const results = index.search("user", "default", 10, 0.5);
    // f1 (confidence=0.3) should be filtered from vector ranking
    const ids = results.map((r) => r.id);
    // f2 should still be present
    expect(ids).toContain("f2");
  });

  test("results include score and relevance", () => {
    addFact("f1", "user", "prefers", "TypeScript");
    const results = index.search("TypeScript");
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.relevance).toBeDefined();
  });
});
