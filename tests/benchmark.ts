// OpenMemory — Performance Benchmarks
// Run: bun run tests/benchmark.ts

import { HotIndex } from "../src/serve/hot-index.ts";
import { embed } from "../src/extract/embedding.ts";
import { extractLocal } from "../src/extract/index.ts";
import { BM25Index } from "../src/serve/bm25.ts";
import { reciprocalRankFusion, type RankedList } from "../src/serve/fusion.ts";
import { Database } from "bun:sqlite";
import type { Fact, DecayConfig } from "../src/types/index.ts";

const DECAY: DecayConfig = {
  halfLifeDays: 30,
  accessBoost: 0.15,
  minStrength: 0.05,
  supersededPenalty: 0.7,
};

// ─── Utilities ─────────────────────────────────────────────────────

function bench(name: string, fn: () => void, iterations: number = 1000): void {
  // Warmup
  for (let i = 0; i < 10; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const perOp = (elapsed / iterations * 1000).toFixed(1); // microseconds
  const opsPerSec = Math.round(iterations / (elapsed / 1000));
  console.log(`  ${name}: ${perOp}µs/op (${opsPerSec.toLocaleString()} ops/sec)`);
}

function makeFact(id: string, subject: string, predicate: string, object: string): Fact {
  return {
    id, subject, predicate, object,
    confidence: 0.8, source: "bench", namespace: "default",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(), accessCount: 0,
    strength: 1.0, supersededBy: null,
  };
}

function createSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT,
    confidence REAL DEFAULT 0.8, source TEXT DEFAULT 'bench',
    namespace TEXT DEFAULT 'default',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    last_accessed_at TEXT DEFAULT (datetime('now')), access_count INTEGER DEFAULT 0,
    strength REAL DEFAULT 1.0, superseded_by TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS vec_facts (
    fact_id TEXT PRIMARY KEY, embedding BLOB NOT NULL
  )`);
}

// ─── Extraction Benchmarks ─────────────────────────────────────────

console.log("\n=== Extraction Engine ===");

const sentences = [
  "My name is Ranbir",
  "I prefer TypeScript over JavaScript",
  "I use SQLite for databases",
  "My runtime is Bun",
  "Testing is done with Vitest",
  "We deploy on Cloudflare Workers",
  "The project uses Zod for validation",
  "Bun is a JavaScript runtime",
];

bench("extractLocal (single sentence)", () => {
  extractLocal("I prefer TypeScript over JavaScript");
});

bench("extractLocal (8 sentences)", () => {
  extractLocal(sentences.join(". "));
});

bench("extractLocal (long paragraph)", () => {
  extractLocal(
    "I prefer TypeScript over JavaScript. My runtime is Bun. " +
    "I use SQLite for databases. Testing is done with Vitest. " +
    "We deploy on Cloudflare Workers. The project uses Zod. " +
    "My editor is VS Code. I work at a startup. " +
    "I like dark mode. The API depends on authentication.",
  );
});

// ─── Embedding Benchmarks ──────────────────────────────────────────

console.log("\n=== Embedding Engine ===");

bench("embed (short text)", () => {
  embed("TypeScript runtime");
});

bench("embed (medium text)", () => {
  embed("user prefers TypeScript over JavaScript for web development");
});

bench("embed (long text)", () => {
  embed("The OpenMemory project uses Bun as its runtime with TypeScript for type safety and SQLite for persistence with Hono for the REST API layer");
});

import { similarity } from "../src/extract/embedding.ts";
const a = embed("TypeScript runtime");
const b = embed("JavaScript engine");

bench("similarity (cosine)", () => {
  similarity(a, b);
}, 10000);

// ─── BM25 Benchmarks ──────────────────────────────────────────────

console.log("\n=== BM25 Index ===");

const bm25 = new BM25Index();
const terms = ["user", "prefers", "typescript", "javascript", "bun", "runtime", "sqlite", "database"];

// Build corpus
for (let i = 0; i < 1000; i++) {
  const tokens: string[] = [];
  for (let j = 0; j < 3; j++) {
    tokens.push(terms[Math.floor(Math.random() * terms.length)]!);
  }
  bm25.add(`d${i}`, tokens);
}

bench("bm25.score (1000 docs, 2 terms)", () => {
  bm25.score(["typescript", "runtime"]);
});

bench("bm25.score (1000 docs, 4 terms)", () => {
  bm25.score(["typescript", "runtime", "user", "prefers"]);
});

bench("bm25.add", () => {
  bm25.add(`add-${Math.random()}`, ["test", "term", "here"]);
});

// ─── RRF Benchmarks ───────────────────────────────────────────────

console.log("\n=== Reciprocal Rank Fusion ===");

const rrfLists: RankedList[] = [
  { name: "bm25", items: Array.from({ length: 100 }, (_, i) => `f${i}`), weight: 2.0 },
  { name: "vector", items: Array.from({ length: 100 }, (_, i) => `f${99 - i}`), weight: 1.2 },
  { name: "entity", items: Array.from({ length: 50 }, (_, i) => `f${i * 2}`), weight: 0.7 },
  { name: "temporal", items: Array.from({ length: 100 }, (_, i) => `f${i}`), weight: 0.3 },
];

bench("reciprocalRankFusion (4 rankers, 100 items)", () => {
  reciprocalRankFusion(rrfLists);
});

// ─── Hot Index (Full Pipeline) ─────────────────────────────────────

console.log("\n=== Hot Index (Full Search Pipeline) ===");

const db = new Database(":memory:");
createSchema(db);
const hotIndex = new HotIndex(db, DECAY);

// Populate with realistic facts
const factData = [
  ["user", "prefers", "TypeScript"],
  ["user", "uses", "Bun"],
  ["user", "uses", "SQLite"],
  ["user", "prefers", "dark mode"],
  ["user", "works_at", "startup"],
  ["user", "named", "Ranbir"],
  ["project", "uses", "Hono"],
  ["project", "uses", "Zod"],
  ["project", "deploys_on", "Cloudflare Workers"],
  ["Testing", "uses", "Vitest"],
  ["Bun", "is", "JavaScript runtime"],
  ["TypeScript", "is", "programming language"],
  ["user", "prefers", "functional programming"],
  ["user", "dislikes", "spaghetti code"],
  ["user", "uses", "VS Code"],
  ["API", "depends_on", "authentication"],
  ["Styling", "uses", "TailwindCSS"],
  ["user", "prefers", "composition over inheritance"],
  ["user", "works_on", "OpenMemory"],
  ["OpenMemory", "is", "AI memory engine"],
];

for (let i = 0; i < factData.length; i++) {
  const [subj, pred, obj] = factData[i]!;
  const fact = makeFact(`f${i}`, subj!, pred!, obj!);
  hotIndex.add(fact, embed(`${subj} ${pred} ${obj}`));
}

bench("search (exact keyword)", () => {
  hotIndex.search("TypeScript");
});

bench("search (2 keywords)", () => {
  hotIndex.search("dark mode");
});

bench("search (natural question)", () => {
  hotIndex.search("What runtime does the user prefer?");
});

bench("search (broad query)", () => {
  hotIndex.search("Tell me about the user");
});

bench("aboutEntity", () => {
  hotIndex.aboutEntity("user");
});

// ─── Scaling Test ──────────────────────────────────────────────────

console.log("\n=== Scaling ===");

const scaleDb = new Database(":memory:");
createSchema(scaleDb);
const scaleIndex = new HotIndex(scaleDb, DECAY);

// Add 500 facts
const subjects = ["user", "project", "api", "frontend", "backend", "database", "cache", "queue"];
const predicates = ["uses", "prefers", "depends_on", "deploys_on", "is"];
const objects = ["TypeScript", "Bun", "React", "PostgreSQL", "Redis", "Kafka", "Docker", "K8s", "Nginx", "GraphQL"];

for (let i = 0; i < 500; i++) {
  const s = subjects[i % subjects.length]!;
  const p = predicates[i % predicates.length]!;
  const o = objects[i % objects.length]!;
  const fact = makeFact(`scale-${i}`, s, p, `${o}-${i}`);
  scaleIndex.add(fact, embed(`${s} ${p} ${o}`));
}

bench("search (500 facts)", () => {
  scaleIndex.search("TypeScript runtime");
});

console.log(`\n  Index stats: ${JSON.stringify(scaleIndex.getStats(), null, 0)}`);

// ─── Memory Estimate ──────────────────────────────────────────────

console.log("\n=== Memory ===");
const stats20 = hotIndex.getStats();
const stats500 = scaleIndex.getStats();
console.log(`  20 facts:  ~${(stats20.memoryBytes / 1024).toFixed(1)} KB`);
console.log(`  500 facts: ~${(stats500.memoryBytes / 1024).toFixed(1)} KB`);
console.log(`  Per fact:  ~${(stats500.memoryBytes / 500).toFixed(0)} bytes`);

db.close();
scaleDb.close();

console.log("\n✓ All benchmarks complete.\n");
