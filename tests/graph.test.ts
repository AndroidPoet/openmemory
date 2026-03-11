// OpenMemory — Knowledge Graph Tests
// Entity CRUD, fact storage, relations, graph queries.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeGraph } from "../src/graph/index.ts";
import type { ExtractedFact } from "../src/types/index.ts";
import { embed } from "../src/extract/embedding.ts";

let db: Database;
let graph: KnowledgeGraph;

function createSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other',
    aliases TEXT NOT NULL DEFAULT '[]', namespace TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), fact_count INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8, source TEXT NOT NULL DEFAULT 'conversation',
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')), access_count INTEGER NOT NULL DEFAULT 0,
    strength REAL NOT NULL DEFAULT 1.0, superseded_by TEXT,
    subject_entity_id TEXT, object_entity_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
    type TEXT NOT NULL, fact_id TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS vec_facts (
    fact_id TEXT PRIMARY KEY, embedding BLOB NOT NULL
  )`);
}

function makeFact(subject: string, predicate: string, object: string, confidence = 0.8): ExtractedFact {
  return {
    subject, predicate, object, confidence,
    entityTypes: { subject: "person", object: "technology" },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  graph = new KnowledgeGraph(db);
});

afterEach(() => {
  db.close();
});

// ─── Entity Management ─────────────────────────────────────────────

describe("findEntity", () => {
  test("returns null for non-existent entity", () => {
    expect(graph.findEntity("Bun", "default")).toBeNull();
  });

  test("finds entity by exact name (case-insensitive)", () => {
    graph.getOrCreateEntity("Bun", "technology", "default");
    const found = graph.findEntity("bun", "default");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Bun");
  });

  test("namespace isolation", () => {
    graph.getOrCreateEntity("Bun", "technology", "ns1");
    expect(graph.findEntity("Bun", "ns2")).toBeNull();
  });
});

describe("getOrCreateEntity", () => {
  test("creates new entity", () => {
    const entity = graph.getOrCreateEntity("TypeScript", "technology", "default");
    expect(entity.name).toBe("TypeScript");
    expect(entity.type).toBe("technology");
    expect(entity.aliases).toEqual([]);
  });

  test("returns existing entity", () => {
    const e1 = graph.getOrCreateEntity("Bun", "technology", "default");
    const e2 = graph.getOrCreateEntity("Bun", "technology", "default");
    expect(e1.id).toBe(e2.id);
  });

  test("upgrades type from 'other' to specific", () => {
    const e1 = graph.getOrCreateEntity("Bun", "other", "default");
    expect(e1.type).toBe("other");
    const e2 = graph.getOrCreateEntity("Bun", "technology", "default");
    expect(e2.type).toBe("technology");
    expect(e2.id).toBe(e1.id);
  });

  test("does NOT downgrade type from specific to 'other'", () => {
    graph.getOrCreateEntity("Bun", "technology", "default");
    const e2 = graph.getOrCreateEntity("Bun", "other", "default");
    expect(e2.type).toBe("technology");
  });
});

// ─── Fact Storage ──────────────────────────────────────────────────

describe("storeFact", () => {
  test("stores fact and creates entities", () => {
    const extracted = makeFact("user", "uses", "Bun");
    const embedding = embed("user uses Bun");
    const fact = graph.storeFact(extracted, "default", "conversation", embedding);

    expect(fact.id).toBeDefined();
    expect(fact.subject).toBe("user");
    expect(fact.predicate).toBe("uses");
    expect(fact.object).toBe("Bun");
    expect(fact.confidence).toBe(0.8);
    expect(fact.strength).toBe(1.0);
  });

  test("creates subject and object entities", () => {
    const extracted = makeFact("user", "prefers", "TypeScript");
    graph.storeFact(extracted, "default", "conversation", embed("user prefers TypeScript"));

    expect(graph.findEntity("user", "default")).not.toBeNull();
    expect(graph.findEntity("TypeScript", "default")).not.toBeNull();
  });

  test("creates relation between entities", () => {
    const extracted = makeFact("user", "prefers", "TypeScript");
    graph.storeFact(extracted, "default", "conversation", embed("user prefers TypeScript"));

    const user = graph.findEntity("user", "default")!;
    const related = graph.getRelatedEntities(user.id);
    expect(related.length).toBe(1);
    expect(related[0]!.entity.name).toBe("TypeScript");
    expect(related[0]!.relation).toBe("prefers");
  });

  test("increments fact count on entities", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed("user uses Bun"));
    graph.storeFact(makeFact("user", "prefers", "TS"), "default", "test", embed("user prefers TS"));

    const user = graph.findEntity("user", "default")!;
    expect(user.factCount).toBe(2);
  });

  test("stores embedding in vec_facts", () => {
    const embedding = embed("user uses Bun");
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embedding);

    const row = db.prepare("SELECT COUNT(*) as c FROM vec_facts").get() as any;
    expect(row.c).toBe(1);
  });
});

// ─── Queries ───────────────────────────────────────────────────────

describe("getFactsAbout", () => {
  test("returns facts about an entity", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed("user uses Bun"));
    graph.storeFact(makeFact("user", "prefers", "TS"), "default", "test", embed("user prefers TS"));
    graph.storeFact(makeFact("Bun", "is", "runtime"), "default", "test", embed("Bun is runtime"));

    const facts = graph.getFactsAbout("user", "default");
    expect(facts.length).toBe(2);
  });

  test("includes facts where entity is object", () => {
    graph.storeFact(makeFact("project", "uses", "Bun"), "default", "test", embed("project uses Bun"));
    const facts = graph.getFactsAbout("Bun", "default");
    expect(facts.length).toBe(1);
  });

  test("excludes superseded facts", () => {
    const fact = graph.storeFact(makeFact("user", "works_at", "Google"), "default", "test", embed(""));
    db.prepare("UPDATE facts SET superseded_by = 'f2' WHERE id = ?").run(fact.id);

    const facts = graph.getFactsAbout("user", "default");
    expect(facts.length).toBe(0);
  });

  test("excludes very weak facts", () => {
    const fact = graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    db.prepare("UPDATE facts SET strength = 0.01 WHERE id = ?").run(fact.id);

    const facts = graph.getFactsAbout("user", "default");
    expect(facts.length).toBe(0);
  });

  test("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      graph.storeFact(makeFact("user", "uses", `tool${i}`), "default", "test", embed(""));
    }
    const facts = graph.getFactsAbout("user", "default", 3);
    expect(facts.length).toBe(3);
  });
});

describe("getRelatedEntities", () => {
  test("finds connected entities via relations", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    graph.storeFact(makeFact("user", "prefers", "TypeScript"), "default", "test", embed(""));

    const user = graph.findEntity("user", "default")!;
    const related = graph.getRelatedEntities(user.id);
    expect(related.length).toBe(2);
  });

  test("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      graph.storeFact(makeFact("user", "uses", `tool${i}`), "default", "test", embed(""));
    }
    const user = graph.findEntity("user", "default")!;
    const related = graph.getRelatedEntities(user.id, 3);
    expect(related.length).toBe(3);
  });

  test("excludes superseded relations", () => {
    const fact = graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    db.prepare("UPDATE facts SET superseded_by = 'f2' WHERE id = ?").run(fact.id);

    const user = graph.findEntity("user", "default")!;
    const related = graph.getRelatedEntities(user.id);
    expect(related.length).toBe(0);
  });
});

describe("getAllEntities", () => {
  test("returns all entities in namespace", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    graph.storeFact(makeFact("project", "uses", "React"), "default", "test", embed(""));

    const entities = graph.getAllEntities("default");
    expect(entities.length).toBe(4); // user, Bun, project, React
  });

  test("sorted by fact count descending", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    graph.storeFact(makeFact("user", "prefers", "TS"), "default", "test", embed(""));

    const entities = graph.getAllEntities("default");
    // "user" has factCount=2, others have 1
    expect(entities[0]!.name).toBe("user");
  });
});

describe("getGraphData", () => {
  test("returns entities and relations", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    const data = graph.getGraphData("default");
    expect(data.entities.length).toBe(2);
    expect(data.relations.length).toBe(1);
    expect(data.relations[0]!.type).toBe("uses");
  });
});

describe("getStats", () => {
  test("returns correct counts", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "default", "test", embed(""));
    graph.storeFact(makeFact("user", "prefers", "TS"), "default", "test", embed(""));

    const stats = graph.getStats("default");
    expect(stats.entities).toBe(3); // user, Bun, TS
    expect(stats.facts).toBe(2);
    expect(stats.activeFacts).toBe(2);
    expect(stats.relations).toBe(2);
  });

  test("global stats without namespace", () => {
    graph.storeFact(makeFact("user", "uses", "Bun"), "ns1", "test", embed(""));
    graph.storeFact(makeFact("user", "uses", "Deno"), "ns2", "test", embed(""));

    const stats = graph.getStats();
    expect(stats.facts).toBe(2);
  });
});
