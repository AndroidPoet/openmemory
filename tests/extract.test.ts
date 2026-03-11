// OpenMemory — Extraction Engine Tests
// Every extractor, every pattern, every edge case.

import { describe, test, expect } from "bun:test";
import { extractLocal } from "../src/extract/index.ts";
import { embed, similarity } from "../src/extract/embedding.ts";

// ─── Helper ─────────────────────────────────────────────────────────

function extract(text: string) {
  return extractLocal(text).facts;
}

function firstFact(text: string) {
  const facts = extract(text);
  expect(facts.length).toBeGreaterThan(0);
  return facts[0]!;
}

function expectFact(text: string, subject: string, predicate: string, objectContains: string) {
  const facts = extract(text);
  const match = facts.find(
    (f) =>
      f.subject.toLowerCase() === subject.toLowerCase() &&
      f.predicate.toLowerCase() === predicate.toLowerCase() &&
      f.object.toLowerCase().includes(objectContains.toLowerCase()),
  );
  expect(match).toBeDefined();
  return match!;
}

function expectNoFacts(text: string) {
  expect(extract(text).length).toBe(0);
}

// ─── 1. Identity Extractor ──────────────────────────────────────────

describe("extractIdentity", () => {
  test("my name is X", () => {
    expectFact("My name is Ranbir", "user", "named", "Ranbir");
  });

  test("I'm X (contraction)", () => {
    expectFact("I'm Ranbir", "user", "named", "Ranbir");
  });

  test("I am a software engineer", () => {
    expectFact("I am a software engineer", "user", "is", "software engineer");
  });

  test("I work at a startup", () => {
    expectFact("I work at a startup", "user", "works_at", "startup");
  });

  test("I work for Google", () => {
    expectFact("I work for Google", "user", "works_at", "Google");
  });

  test("I work on OpenMemory project", () => {
    expectFact("I work on OpenMemory project", "user", "works_on", "OpenMemory");
  });

  test("call me X", () => {
    expectFact("Call me Ranbir", "user", "named", "Ranbir");
  });
});

// ─── 2. Preference Extractor ────────────────────────────────────────

describe("extractPreference", () => {
  test("I prefer X over Y", () => {
    const f = expectFact("I prefer TypeScript over JavaScript", "user", "prefers", "TypeScript");
    expect(f.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test("I like X", () => {
    expectFact("I like dark mode in my editor", "user", "prefers", "dark mode");
  });

  test("I love X", () => {
    expectFact("I love functional programming", "user", "prefers", "functional programming");
  });

  test("I enjoy X", () => {
    expectFact("I enjoy writing tests", "user", "prefers", "writing tests");
  });

  test("I favor X", () => {
    expectFact("I favor composition over inheritance", "user", "prefers", "composition");
  });

  test("I hate X", () => {
    expectFact("I hate spaghetti code", "user", "dislikes", "spaghetti code");
  });

  test("I dislike X", () => {
    expectFact("I dislike sycophantic responses from AI", "user", "dislikes", "sycophantic");
  });

  test("I don't like X", () => {
    expectFact("I don't like tabs for indentation", "user", "dislikes", "tabs");
  });

  test("I avoid X", () => {
    expectFact("I avoid using var in JavaScript", "user", "dislikes", "var");
  });

  test("I can't stand X", () => {
    expectFact("I can't stand slow builds", "user", "dislikes", "slow builds");
  });

  test("I switched to X", () => {
    expectFact("I switched to Deno as my runtime", "user", "uses", "Deno");
  });

  test("I moved to X", () => {
    expectFact("I moved to Bun from Node", "user", "uses", "Bun");
  });

  test("I always use X", () => {
    expectFact("I always use Prettier for formatting", "user", "prefers", "Prettier");
  });

  test("I usually prefer X", () => {
    expectFact("I usually prefer dark themes", "user", "prefers", "dark themes");
  });

  test("My favorite X is Y", () => {
    expectFact("My favorite framework is Hono for REST APIs", "user", "prefers", "Hono");
  });

  test("My preferred X is Y", () => {
    expectFact("My preferred editor is VS Code", "user", "prefers", "VS Code");
  });

  test("My go-to X is Y", () => {
    expectFact("My go-to database is SQLite", "user", "prefers", "SQLite");
  });
});

// ─── 3. Usage Extractor ─────────────────────────────────────────────

describe("extractUsage", () => {
  test("I use X for Y (two facts)", () => {
    const facts = extract("I use SQLite for databases");
    expect(facts.length).toBe(2);
    expectFact("I use SQLite for databases", "user", "uses", "SQLite");
    expectFact("I use SQLite for databases", "SQLite", "used_for", "databases");
  });

  test("I use X as Y", () => {
    expectFact("I use Bun as my runtime", "user", "uses", "Bun");
  });

  test("I use X (simple)", () => {
    expectFact("I use VS Code", "user", "uses", "VS Code");
  });
});

// ─── 4. Possessive Extractor ────────────────────────────────────────

describe("extractPossessive", () => {
  test("My runtime is X", () => {
    expectFact("My runtime is Bun", "user", "uses", "Bun");
  });

  test("My editor is X", () => {
    expectFact("My editor is Neovim", "user", "uses", "Neovim");
  });

  test("My language is X", () => {
    expectFact("My language is TypeScript", "user", "uses", "TypeScript");
  });

  test("My database is X", () => {
    expectFact("My database is PostgreSQL", "user", "uses", "PostgreSQL");
  });

  test("My role is X", () => {
    expectFact("My role is tech lead", "user", "is", "tech lead");
  });

  test("My job is X", () => {
    expectFact("My job is software engineering", "user", "is", "software engineering");
  });
});

// ─── 5. Passive Extractor ───────────────────────────────────────────

describe("extractPassive", () => {
  test("X is done with Y", () => {
    expectFact("Testing is done with Vitest", "Testing", "uses", "Vitest");
  });

  test("X is built with Y", () => {
    expectFact("The app is built with React", "app", "uses", "React");
  });

  test("X is handled by Y", () => {
    expectFact("Styling is handled by TailwindCSS", "Styling", "uses", "TailwindCSS");
  });

  test("X is used for the Y", () => {
    // First regex in extractPassive matches "is used for" → predicate "uses"
    expectFact("React is used for the frontend", "React", "uses", "frontend");
  });
});

// ─── 6. Infrastructure Extractor ────────────────────────────────────

describe("extractInfra", () => {
  test("We deploy on X", () => {
    expectFact("We deploy on Cloudflare Workers", "project", "deploys_on", "Cloudflare Workers");
  });

  test("I host on X", () => {
    expectFact("I host on Vercel", "project", "deploys_on", "Vercel");
  });

  test("Deployed on X (past tense)", () => {
    expectFact("Deployed on AWS Lambda", "project", "deploys_on", "AWS Lambda");
  });

  test("We run on X", () => {
    expectFact("We run on Kubernetes", "project", "deploys_on", "Kubernetes");
  });
});

// ─── 7. Active Verb Extractor ───────────────────────────────────────

describe("extractActiveVerb", () => {
  test("X uses Y", () => {
    expectFact("The project uses Zod for validation", "project", "uses", "Zod");
  });

  test("X handles Y", () => {
    expectFact("TailwindCSS handles styling", "TailwindCSS", "uses", "styling");
  });

  test("X depends on Y", () => {
    expectFact("The API depends on authentication", "API", "depends_on", "authentication");
  });

  test("X requires Y", () => {
    expectFact("The build requires Node 18", "build", "depends_on", "Node 18");
  });

  test("skip overly long subjects", () => {
    const facts = extract(
      "This is a very long subject that exceeds forty characters and should be skipped uses something",
    );
    // Should not extract from activeVerb (subject too long), may extract from copula
    const activeVerb = facts.find((f) => f.predicate === "uses" && f.subject.length > 40);
    expect(activeVerb).toBeUndefined();
  });
});

// ─── 8. Copula Extractor (lowest priority) ──────────────────────────

describe("extractCopula", () => {
  test("X is a Y", () => {
    expectFact("Bun is a JavaScript runtime", "Bun", "is", "JavaScript runtime");
  });

  test("skip noise subjects (it, this, that)", () => {
    expectNoFacts("It is a good day");
    expectNoFacts("This is fine");
    expectNoFacts("That is correct");
  });

  test("skip very short subjects", () => {
    // Single char subjects should be filtered
    const facts = extract("A is B");
    const copula = facts.find((f) => f.predicate === "is" && f.subject.length <= 1);
    expect(copula).toBeUndefined();
  });
});

// ─── Pipeline Behavior ──────────────────────────────────────────────

describe("extraction pipeline", () => {
  test("first match wins (specificity order)", () => {
    // "I prefer X" matches preference (priority 2) before copula (priority 8)
    const facts = extract("I prefer TypeScript");
    expect(facts.length).toBe(1);
    expect(facts[0]!.predicate).toBe("prefers");
  });

  test("multi-sentence extraction", () => {
    const facts = extract(
      "I prefer TypeScript. My runtime is Bun. I use SQLite for databases.",
    );
    expect(facts.length).toBeGreaterThanOrEqual(3);
  });

  test("deduplication (case-insensitive)", () => {
    const facts = extract("I use Bun. I USE BUN.");
    const bunFacts = facts.filter(
      (f) => f.object.toLowerCase().includes("bun") && f.predicate === "uses",
    );
    // Should deduplicate to 1
    expect(bunFacts.length).toBeLessThanOrEqual(1);
  });

  test("empty input returns no facts", () => {
    expectNoFacts("");
  });

  test("gibberish returns no facts", () => {
    expectNoFacts("asdf jkl");
  });

  test("short sentences (< 6 chars) skipped", () => {
    expectNoFacts("Hi");
    expectNoFacts("OK");
  });

  test("sentence splitting on . ! ? newlines", () => {
    const facts = extract("I use Bun! I prefer TypeScript? My name is Ranbir\nI work at a startup");
    expect(facts.length).toBeGreaterThanOrEqual(3);
  });

  test("confidence levels are correct", () => {
    // Preference with "over" = 0.85 (highest)
    const pref = firstFact("I prefer TypeScript over JavaScript");
    expect(pref.confidence).toBe(0.85);

    // Simple preference = 0.8
    const like = firstFact("I like dark mode");
    expect(like.confidence).toBe(0.8);

    // Possessive = 0.75
    const poss = firstFact("My runtime is Bun");
    expect(poss.confidence).toBe(0.75);

    // Active verb = 0.6
    const active = firstFact("The project uses Zod");
    expect(active.confidence).toBe(0.6);

    // Copula = 0.5
    const copula = firstFact("Bun is a JavaScript runtime");
    expect(copula.confidence).toBe(0.5);
  });

  test("entity types are inferred correctly", () => {
    const f1 = firstFact("I prefer TypeScript");
    expect(f1.entityTypes.subject).toBe("person");

    const f2 = firstFact("The project uses React");
    expect(f2.entityTypes.object).toBe("technology");
  });

  test("clean() strips articles and trailing periods", () => {
    const f = firstFact("I use the PostgreSQL database.");
    // "the" should be stripped, "." should be stripped
    expect(f.object).not.toMatch(/^the\s/i);
    expect(f.object).not.toMatch(/\.$/);
  });
});

// ─── Embedding Tests ────────────────────────────────────────────────

describe("embedding", () => {
  test("returns 768-dim Float32Array", () => {
    const vec = embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
  });

  test("is L2 normalized", () => {
    const vec = embed("test normalization");
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
    expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.001);
  });

  test("empty string returns zero vector", () => {
    const vec = embed("");
    const sum = vec.reduce((a, b) => a + b, 0);
    expect(sum).toBe(0);
  });

  test("similar texts have high similarity", () => {
    const a = embed("I prefer TypeScript");
    const b = embed("I like TypeScript");
    expect(similarity(a, b)).toBeGreaterThan(0.4);
  });

  test("unrelated texts have low similarity", () => {
    const a = embed("I prefer TypeScript");
    const b = embed("The weather is nice today");
    expect(similarity(a, b)).toBeLessThan(0.3);
  });

  test("identical texts have similarity 1.0", () => {
    const a = embed("exact same text");
    const b = embed("exact same text");
    expect(Math.abs(similarity(a, b) - 1.0)).toBeLessThan(0.001);
  });

  test("stop words are filtered", () => {
    // "the" and "is" are stop words — these should produce similar embeddings
    const a = embed("TypeScript runtime");
    const b = embed("the TypeScript is a runtime");
    expect(similarity(a, b)).toBeGreaterThan(0.7);
  });

  test("order matters (bigrams differ)", () => {
    const a = embed("dark mode");
    const b = embed("mode dark");
    // Same unigrams but different bigrams
    const sim = similarity(a, b);
    expect(sim).toBeGreaterThan(0.3); // unigrams overlap
    expect(sim).toBeLessThan(1.0);    // bigrams differ
  });
});
