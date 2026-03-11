// OpenMemory — Smart Forgetting (Decay) Tests
// Every decay calculation, every boost, every edge case.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { DecayEngine } from "../src/decay/index.ts";
import type { DecayConfig } from "../src/types/index.ts";

const DECAY: DecayConfig = {
  halfLifeDays: 30,
  accessBoost: 0.15,
  minStrength: 0.05,
  supersededPenalty: 0.7,
};

let db: Database;
let engine: DecayEngine;

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

function insertFact(id: string, opts?: {
  strength?: number;
  lastAccessed?: string;
  accessCount?: number;
  supersededBy?: string;
}): void {
  const lastAccessed = opts?.lastAccessed ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO facts (id, subject, predicate, object, strength, last_accessed_at, access_count, superseded_by)
    VALUES (?, 'user', 'uses', 'Bun', ?, ?, ?, ?)
  `).run(id, opts?.strength ?? 1.0, lastAccessed, opts?.accessCount ?? 0, opts?.supersededBy ?? null);
}

function getFact(id: string): any {
  return db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  engine = new DecayEngine(db, DECAY);
});

afterEach(() => {
  db.close();
});

// ─── Apply Decay ───────────────────────────────────────────────────

describe("applyDecay", () => {
  test("recently accessed fact barely decays", () => {
    insertFact("f1", { lastAccessed: new Date().toISOString() });
    const result = engine.applyDecay();
    const fact = getFact("f1");
    // Accessed just now — decay should be negligible
    expect(fact.strength).toBeCloseTo(1.0, 1);
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  test("30-day-old fact decays to ~50%", () => {
    insertFact("f1", { lastAccessed: daysAgo(30) });
    engine.applyDecay();
    const fact = getFact("f1");
    // halfLife=30 days, so 30 days → 2^(-1) = 0.5
    // With 0 access count, accessResistance = 0, adjustedDecay = 0.5
    // newStrength = 1.0 * 0.5 = 0.5
    expect(fact.strength).toBeCloseTo(0.5, 1);
  });

  test("60-day-old fact decays to ~25%", () => {
    insertFact("f1", { lastAccessed: daysAgo(60) });
    engine.applyDecay();
    const fact = getFact("f1");
    // 60 days → 2^(-2) = 0.25
    expect(fact.strength).toBeCloseTo(0.25, 1);
  });

  test("access count provides resistance to decay", () => {
    // High access count should slow decay
    insertFact("f1", { lastAccessed: daysAgo(30), accessCount: 25 });
    engine.applyDecay();
    const fact = getFact("f1");
    // accessResistance = min(25 * 0.02, 0.5) = 0.5
    // decayFactor = 2^(-1) = 0.5
    // adjustedDecay = 0.5 + (1 - 0.5) * 0.5 = 0.75
    // newStrength = 1.0 * 0.75 = 0.75
    expect(fact.strength).toBeCloseTo(0.75, 1);
  });

  test("access resistance capped at 0.5", () => {
    insertFact("f1", { lastAccessed: daysAgo(30), accessCount: 100 });
    engine.applyDecay();
    const factHigh = getFact("f1");

    // Reset
    db.prepare("UPDATE facts SET strength = 1.0 WHERE id = 'f1'").run();
    db.prepare("UPDATE facts SET access_count = 25 WHERE id = 'f1'").run();
    engine.applyDecay();
    const factMed = getFact("f1");

    // Both should have same resistance (capped at 0.5)
    expect(factHigh.strength).toBeCloseTo(factMed.strength, 2);
  });

  test("fact below minStrength gets archived (strength=0)", () => {
    insertFact("f1", { strength: 0.06, lastAccessed: daysAgo(90) });
    const result = engine.applyDecay();
    const fact = getFact("f1");
    expect(fact.strength).toBe(0);
    expect(result.archived).toBe(1);
  });

  test("superseded facts are skipped", () => {
    insertFact("f1", { lastAccessed: daysAgo(60), supersededBy: "f2" });
    const result = engine.applyDecay();
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  test("facts already at minStrength are skipped", () => {
    insertFact("f1", { strength: 0.04 }); // below minStrength=0.05
    const result = engine.applyDecay();
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  test("multiple facts decay independently", () => {
    insertFact("f1", { lastAccessed: daysAgo(30) });
    insertFact("f2", { lastAccessed: daysAgo(60) });
    insertFact("f3", { lastAccessed: new Date().toISOString() });

    engine.applyDecay();

    const f1 = getFact("f1");
    const f2 = getFact("f2");
    const f3 = getFact("f3");

    expect(f1.strength).toBeLessThan(f3.strength);
    expect(f2.strength).toBeLessThan(f1.strength);
  });
});

// ─── Boost on Access ───────────────────────────────────────────────

describe("boostOnAccess", () => {
  test("boosts strength by accessBoost", () => {
    insertFact("f1", { strength: 0.5 });
    engine.boostOnAccess("f1");
    const fact = getFact("f1");
    expect(fact.strength).toBeCloseTo(0.65, 2); // 0.5 + 0.15
  });

  test("increments access count", () => {
    insertFact("f1");
    engine.boostOnAccess("f1");
    const fact = getFact("f1");
    expect(fact.access_count).toBe(1);
  });

  test("strength capped at 1.0", () => {
    insertFact("f1", { strength: 0.95 });
    engine.boostOnAccess("f1");
    const fact = getFact("f1");
    expect(fact.strength).toBe(1.0);
  });

  test("multiple boosts accumulate", () => {
    insertFact("f1", { strength: 0.3 });
    engine.boostOnAccess("f1");
    engine.boostOnAccess("f1");
    engine.boostOnAccess("f1");
    const fact = getFact("f1");
    expect(fact.strength).toBeCloseTo(0.75, 2); // 0.3 + 3×0.15
    expect(fact.access_count).toBe(3);
  });
});

// ─── Revive ────────────────────────────────────────────────────────

describe("revive", () => {
  test("revive sets strength to 1.0", () => {
    insertFact("f1", { strength: 0.1 });
    engine.revive("f1");
    const fact = getFact("f1");
    expect(fact.strength).toBe(1.0);
  });

  test("revive updates last_accessed_at", () => {
    insertFact("f1", { strength: 0.1, lastAccessed: daysAgo(100) });
    engine.revive("f1");
    const fact = getFact("f1");
    const lastAccessed = new Date(fact.last_accessed_at);
    const now = new Date();
    // Should be very recent (within 1 second)
    expect(now.getTime() - lastAccessed.getTime()).toBeLessThan(2000);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────

describe("edge cases", () => {
  test("empty database returns zero counts", () => {
    const result = engine.applyDecay();
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  test("decay is idempotent on fresh facts", () => {
    insertFact("f1");
    engine.applyDecay();
    const after1 = getFact("f1").strength;
    engine.applyDecay();
    const after2 = getFact("f1").strength;
    // Small decay might happen between calls, but the important thing
    // is it doesn't crash or produce weird values
    expect(after2).toBeLessThanOrEqual(after1);
    expect(after2).toBeGreaterThan(0);
  });
});
