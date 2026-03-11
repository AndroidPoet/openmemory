// OpenMemory — MCP Server
// Universal memory for any MCP-compatible AI tool

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { OpenMemoryConfig } from "../types/index.js";
import { extractFacts } from "../extract/index.js";
import { embed } from "../extract/embedding.js";
import { KnowledgeGraph } from "../graph/index.js";
import { ContradictionResolver } from "../resolve/index.js";
import { MemoryServer } from "../serve/index.js";

export async function startMcpServer(db: Database, config: OpenMemoryConfig): Promise<void> {
  const graph = new KnowledgeGraph(db);
  const resolver = new ContradictionResolver(db, config.decay);
  const memory = new MemoryServer(db, config.decay);

  // Boot hot index
  const bootResult = memory.boot();
  console.error(`OpenMemory MCP: ${bootResult.facts} facts loaded in ${bootResult.timeMs}ms`);

  const server = new McpServer({ name: "openmemory", version: "0.1.0" });

  server.tool(
    "remember",
    "Learn and remember information. Extracts atomic facts and stores them in the knowledge graph.",
    {
      content: z.string().describe("The information to remember"),
      namespace: z.string().optional().describe("Memory namespace"),
      source: z.string().optional().describe("Source: conversation, explicit, inferred"),
    },
    async ({ content, namespace = "default", source = "conversation" }) => {
      const extraction = await extractFacts(content, config);
      const stored = [];
      const hotIndex = memory.getIndex();

      for (const fact of extraction.facts) {
        const contradictions = resolver.findContradictions(fact, namespace);
        const embedding = embed(`${fact.subject} ${fact.predicate} ${fact.object}`);
        const storedFact = graph.storeFact(fact, namespace, source, embedding);
        hotIndex.add(storedFact, embedding);

        if (contradictions.length > 0) {
          resolver.resolve(contradictions, storedFact.id);
          for (const c of contradictions) {
            if (c.resolution === "supersede") hotIndex.supersede(c.existingFact.id, storedFact.id);
          }
        }
        stored.push(`${fact.subject} ${fact.predicate} ${fact.object} (${Math.round(fact.confidence * 100)}%)`);
      }

      const text = stored.length > 0
        ? `Remembered ${stored.length} fact(s):\n${stored.map((s) => `  - ${s}`).join("\n")}`
        : "Could not extract facts. Try being more specific.";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "recall",
    "Search memory for relevant information.",
    {
      query: z.string().describe("What to search for"),
      namespace: z.string().optional(),
      limit: z.number().optional().describe("Max results (default: 10)"),
    },
    async ({ query, namespace, limit }) => {
      const start = performance.now();
      const result = memory.search({ query, namespace, limit });
      const elapsed = Math.round((performance.now() - start) * 100) / 100;

      if (result.facts.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
      }
      const lines = result.facts.map((f) =>
        `- ${f.subject} ${f.predicate} ${f.object} [${Math.round(f.score * 100)}%]`,
      );
      return { content: [{ type: "text" as const, text: `Found ${result.facts.length} memories (${elapsed}ms):\n${lines.join("\n")}` }] };
    },
  );

  server.tool(
    "get_memory_context",
    "Get relevant memory context for the current conversation.",
    {
      query: z.string().describe("Current topic or question"),
      namespace: z.string().optional(),
      maxFacts: z.number().optional(),
    },
    async ({ query, namespace, maxFacts }) => {
      const result = memory.search({ query, namespace, limit: maxFacts || 10 });
      const context = memory.formatContext(result.facts, "text");
      return { content: [{ type: "text" as const, text: context || "No relevant context." }] };
    },
  );

  server.tool(
    "about",
    "Get everything known about a person, project, technology, or concept.",
    {
      entity: z.string().describe("Entity name"),
      namespace: z.string().optional(),
    },
    async ({ entity, namespace = "default" }) => {
      const facts = memory.aboutEntity(entity, namespace);
      if (facts.length === 0) return { content: [{ type: "text" as const, text: `Nothing known about "${entity}".` }] };
      const lines = facts.map((f) => `- ${f.subject} ${f.predicate} ${f.object}`);
      return { content: [{ type: "text" as const, text: `Known about "${entity}":\n${lines.join("\n")}` }] };
    },
  );

  server.tool(
    "forget",
    "Forget a specific fact by ID.",
    { factId: z.string() },
    async ({ factId }) => {
      db.prepare("UPDATE facts SET strength = 0, updated_at = datetime('now') WHERE id = ?").run(factId);
      memory.getIndex().remove(factId);
      return { content: [{ type: "text" as const, text: "Forgotten." }] };
    },
  );

  server.tool(
    "memory_stats",
    "Get memory system statistics.",
    {},
    async () => {
      const s = graph.getStats();
      const idx = memory.getStats();
      return { content: [{ type: "text" as const, text: `Entities: ${s.entities} | Facts: ${s.activeFacts}/${s.facts} | In-memory: ${idx.factsInMemory} | Keywords: ${idx.uniqueKeywords} | Memory: ${Math.round(idx.memoryBytes / 1024)}KB` }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
