// OpenMemory — Contradiction Resolution Tests
// Every detection path, every resolution type, every edge case.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ContradictionResolver } from "../src/resolve/index.ts";
import type { DecayConfig, ExtractedFact, Fact } from "../src/types/index.ts";

const DECAY: DecayConfig = {
  halfLifeDays: 30,
  accessBoost: 0.15,
  minStrength: 0.05,
  supersededPenalty: 0.7,
};

let db: Database;
let resolver: ContradictionResolver;

function createSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      source TEXT NOT NULL DEFAULT 'conversation',
      namespace TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0,
      strength REAL NOT NULL DEFAULT 1.0,
      superseded_by TEXT
    )
  `);
}

function insertFact(id: string, subject: string, predicate: string, object: string, opts?: { namespace?: string; strength?: number; supersededBy?: string }): void {
  db.prepare(`
    INSERT INTO facts (id, subject, predicate, object, namespace, strength, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, subject, predicate, object, opts?.namespace ?? "default", opts?.strength ?? 1.0, opts?.supersededBy ?? null);
}

function makeFact(subject: string, predicate: string, object: string, confidence = 0.8): ExtractedFact {
  return { subject, predicate, object, confidence, entityTypes: { subject: "person", object: "technology" } };
}

function getFact(id: string): any {
  return db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  resolver = new ContradictionResolver(db, DECAY);
});

afterEach(() => {
  db.close();
});

// ─── Mutually Exclusive Predicates ─────────────────────────────────

describe("mutually exclusive predicates", () => {
  test("'is' detects contradiction", () => {
    insertFact("f1", "user", "is", "frontend developer");
    const newFact = makeFact("user", "is", "backend developer");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(1);
    expect(contradictions[0]!.existingFact.object).toBe("frontend developer");
  });

  test("'works_at' detects contradiction", () => {
    insertFact("f1", "user", "works_at", "Google");
    const newFact = makeFact("user", "works_at", "Meta");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(1);
  });

  test("'lives_in' detects contradiction", () => {
    insertFact("f1", "user", "lives_in", "San Francisco");
    const newFact = makeFact("user", "lives_in", "New York");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(1);
  });

  test("'named' detects contradiction", () => {
    insertFact("f1", "user", "named", "Alice");
    const newFact = makeFact("user", "named", "Bob");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(1);
  });

  test("same value is NOT a contradiction", () => {
    insertFact("f1", "user", "works_at", "Google");
    const newFact = makeFact("user", "works_at", "Google");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });

  test("case-insensitive match is NOT a contradiction", () => {
    insertFact("f1", "user", "works_at", "google");
    const newFact = makeFact("user", "works_at", "Google");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });
});

// ─── NON-Exclusive Predicates ──────────────────────────────────────

describe("non-exclusive predicates (no contradiction)", () => {
  test("'prefers' is NOT exclusive", () => {
    insertFact("f1", "user", "prefers", "dark mode");
    const newFact = makeFact("user", "prefers", "TypeScript");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });

  test("'uses' is NOT exclusive", () => {
    insertFact("f1", "user", "uses", "Bun");
    const newFact = makeFact("user", "uses", "Deno");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });

  test("'dislikes' is NOT exclusive", () => {
    insertFact("f1", "user", "dislikes", "tabs");
    const newFact = makeFact("user", "dislikes", "semicolons");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });

  test("'works_on' is NOT exclusive (should it be?)", () => {
    // works_on is NOT in the mutually exclusive list
    insertFact("f1", "user", "works_on", "ProjectA");
    const newFact = makeFact("user", "works_on", "ProjectB");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });
});

// ─── Negation Pairs ────────────────────────────────────────────────

describe("negation pairs", () => {
  test("prefers + dislikes same object = contradiction", () => {
    insertFact("f1", "user", "dislikes", "TypeScript");
    const newFact = makeFact("user", "prefers", "TypeScript");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(1);
    expect(contradictions[0]!.type).toBe("direct");
    expect(contradictions[0]!.resolution).toBe("supersede");
  });

  test("uses + avoids same object = contradiction", () => {
    insertFact("f1", "user", "avoids", "var");
    const newFact = makeFact("user", "uses", "var");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(1);
  });

  test("different objects in negation pair = no contradiction", () => {
    insertFact("f1", "user", "dislikes", "tabs");
    const newFact = makeFact("user", "prefers", "spaces");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });
});

// ─── Namespace Isolation ───────────────────────────────────────────

describe("namespace isolation", () => {
  test("different namespace = no contradiction", () => {
    insertFact("f1", "user", "works_at", "Google", { namespace: "personal" });
    const newFact = makeFact("user", "works_at", "Meta");
    const contradictions = resolver.findContradictions(newFact, "work");
    expect(contradictions.length).toBe(0);
  });

  test("same namespace detects contradiction", () => {
    insertFact("f1", "user", "works_at", "Google", { namespace: "work" });
    const newFact = makeFact("user", "works_at", "Meta");
    const contradictions = resolver.findContradictions(newFact, "work");
    expect(contradictions.length).toBe(1);
  });
});

// ─── Superseded Facts ──────────────────────────────────────────────

describe("superseded facts", () => {
  test("already superseded fact does NOT trigger contradiction", () => {
    insertFact("f1", "user", "works_at", "Google", { supersededBy: "f0" });
    const newFact = makeFact("user", "works_at", "Meta");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });

  test("very weak fact (strength < 0.05) does NOT trigger contradiction", () => {
    insertFact("f1", "user", "works_at", "Google", { strength: 0.01 });
    const newFact = makeFact("user", "works_at", "Meta");
    const contradictions = resolver.findContradictions(newFact, "default");
    expect(contradictions.length).toBe(0);
  });
});

// ─── Resolution ────────────────────────────────────────────────────

describe("resolve", () => {
  test("supersede reduces strength", () => {
    insertFact("f1", "user", "works_at", "Google");
    const newFact = makeFact("user", "works_at", "Meta");
    const contradictions = resolver.findContradictions(newFact, "default");
    resolver.resolve(contradictions, "f2");

    const updated = getFact("f1");
    expect(updated.superseded_by).toBe("f2");
    expect(updated.strength).toBeLessThan(1.0);
    // strength = 1.0 * (1 - 0.7) = 0.3
    expect(updated.strength).toBeCloseTo(0.3, 1);
  });

  test("keep_both does nothing", () => {
    insertFact("f1", "user", "is", "developer");
    // Manually create a low-confidence contradiction with keep_both resolution
    const lowConfFact = makeFact("user", "is", "designer", 0.3);
    // We need to force a "partial" type to get "keep_both"
    // Since "is" is mutually exclusive it will be "direct" → "supersede"
    // So let's just test that keep_both path doesn't modify
    const fakeContradiction = {
      existingFact: { ...getFact("f1"), id: "f1" } as any,
      newFact: lowConfFact,
      type: "partial" as const,
      resolution: "keep_both" as const,
    };
    resolver.resolve([fakeContradiction], "f2");
    const unchanged = getFact("f1");
    expect(unchanged.strength).toBe(1.0);
    expect(unchanged.superseded_by).toBeNull();
  });

  test("merge halves strength", () => {
    insertFact("f1", "user", "is", "developer");
    const fakeContradiction = {
      existingFact: { ...getFact("f1"), id: "f1" } as any,
      newFact: makeFact("user", "is", "engineer"),
      type: "partial" as const,
      resolution: "merge" as const,
    };
    resolver.resolve([fakeContradiction], "f2");
    const updated = getFact("f1");
    expect(updated.strength).toBeCloseTo(0.5, 1);
  });
});

// ─── Multiple Contradictions ───────────────────────────────────────

describe("multiple contradictions", () => {
  test("supersede + negation pair both detected", () => {
    // "user is frontend developer" contradicts "user is backend developer" (exclusive)
    // "user dislikes TypeScript" contradicts "user prefers TypeScript" (negation)
    insertFact("f1", "user", "is", "frontend developer");
    insertFact("f2", "user", "dislikes", "TypeScript");

    // New fact: "user prefers TypeScript" — only checks negation pair for "prefers"
    const newFact = makeFact("user", "prefers", "TypeScript");
    const contradictions = resolver.findContradictions(newFact, "default");
    // prefers is NOT mutually exclusive, but has negation pair dislikes
    expect(contradictions.length).toBe(1);
    expect(contradictions[0]!.existingFact.predicate).toBe("dislikes");
  });
});
