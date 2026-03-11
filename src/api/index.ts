// OpenMemory — REST API

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
import type { OpenMemoryConfig } from "../types/index.js";
import { extractFacts } from "../extract/index.js";
import { embed } from "../extract/embedding.js";
import { KnowledgeGraph } from "../graph/index.js";
import { ContradictionResolver } from "../resolve/index.js";
import { DecayEngine } from "../decay/index.js";
import { MemoryServer } from "../serve/index.js";

export function createApi(db: Database, config: OpenMemoryConfig): { app: Hono; memory: MemoryServer } {
  const app = new Hono();
  const graph = new KnowledgeGraph(db);
  const resolver = new ContradictionResolver(db, config.decay);
  const decay = new DecayEngine(db, config.decay);
  const memory = new MemoryServer(db, config.decay);

  // Boot the in-memory index
  const bootResult = memory.boot();
  console.log(`  Hot index loaded: ${bootResult.facts} facts in ${bootResult.timeMs}ms`);

  app.use("*", cors());

  app.use("/api/*", async (c, next) => {
    if (config.apiKey) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${config.apiKey}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });

  // Health + index stats
  app.get("/health", (c) => {
    const indexStats = memory.getStats();
    return c.json({ status: "ok", version: "0.1.0", ...graph.getStats(), index: indexStats });
  });

  // Add memory — extract → store → update hot index
  app.post("/api/v1/add", async (c) => {
    const start = performance.now();
    const body = await c.req.json();
    const { content, namespace = "default", source = "api" } = body;
    if (!content) return c.json({ error: "content is required" }, 400);

    const extraction = await extractFacts(content, config);
    const stored = [];
    const hotIndex = memory.getIndex();

    for (const fact of extraction.facts) {
      const contradictions = resolver.findContradictions(fact, namespace);
      const embedding = embed(`${fact.subject} ${fact.predicate} ${fact.object}`);
      const storedFact = graph.storeFact(fact, namespace, source, embedding);

      // Update hot index immediately
      hotIndex.add(storedFact, embedding);

      if (contradictions.length > 0) {
        resolver.resolve(contradictions, storedFact.id);
        // Remove superseded facts from hot index
        for (const c of contradictions) {
          if (c.resolution === "supersede") {
            hotIndex.supersede(c.existingFact.id, storedFact.id);
          }
        }
      }

      stored.push({
        id: storedFact.id,
        fact: `${fact.subject} ${fact.predicate} ${fact.object}`,
        confidence: fact.confidence,
        contradictions: contradictions.map((c) => ({
          existing: `${c.existingFact.subject} ${c.existingFact.predicate} ${c.existingFact.object}`,
          resolution: c.resolution,
        })),
      });
    }

    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    return c.json({ stored: stored.length, facts: stored, summary: extraction.summary, timeMs: elapsed });
  });

  // Search — pure in-memory, no disk
  app.post("/api/v1/search", async (c) => {
    const start = performance.now();
    const body = await c.req.json();
    const result = memory.search(body);
    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    return c.json({ ...result, timeMs: elapsed });
  });

  // Context
  app.post("/api/v1/context", async (c) => {
    const start = performance.now();
    const body = await c.req.json();
    const result = memory.search({ query: body.query, namespace: body.namespace, limit: body.maxFacts || 10 });
    const formatted = memory.formatContext(result.facts, body.format || "markdown");
    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    return c.json({ context: formatted, factCount: result.facts.length, summary: result.summary, timeMs: elapsed });
  });

  // Entity lookup — instant from index
  app.get("/api/v1/entity/:name", (c) => {
    const start = performance.now();
    const name = c.req.param("name");
    const namespace = c.req.query("namespace") || "default";
    const facts = memory.aboutEntity(name, namespace);
    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    if (facts.length === 0) return c.json({ error: "Entity not found" }, 404);
    return c.json({ entity: name, facts, timeMs: elapsed });
  });

  // Graph
  app.get("/api/v1/graph", (c) => {
    const namespace = c.req.query("namespace") || "default";
    return c.json({ ...graph.getGraphData(namespace), stats: graph.getStats(namespace) });
  });

  // Stats
  app.get("/api/v1/stats", (c) => {
    return c.json({ ...graph.getStats(c.req.query("namespace") || undefined), index: memory.getStats() });
  });

  // Entities
  app.get("/api/v1/entities", (c) => {
    return c.json(graph.getAllEntities(c.req.query("namespace") || "default"));
  });

  // Decay
  app.post("/api/v1/decay", (c) => {
    return c.json(decay.applyDecay());
  });

  return { app, memory };
}
