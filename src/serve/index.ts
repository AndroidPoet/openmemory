// OpenMemory — Memory Server
// Wraps HotIndex with formatting and public API
// All reads go through in-memory index. Zero disk I/O on search.

import type { Database } from "bun:sqlite";
import { HotIndex } from "./hot-index.js";
import type { MemoryQuery, MemoryResult, ScoredFact, Fact, DecayConfig } from "../types/index.js";

export class MemoryServer {
  private index: HotIndex;

  constructor(db: Database, decayConfig: DecayConfig) {
    this.index = new HotIndex(db, decayConfig);
  }

  // Load all facts into RAM. Call once on startup.
  boot(): { facts: number; timeMs: number } {
    return this.index.load();
  }

  // Get the hot index for direct manipulation
  getIndex(): HotIndex {
    return this.index;
  }

  search(query: MemoryQuery): MemoryResult {
    const facts = this.index.search(
      query.query,
      query.namespace || "default",
      query.limit || 10,
      query.minConfidence || 0,
    );

    return {
      facts,
      entities: [],
      summary: this.summarize(facts),
    };
  }

  aboutEntity(entityName: string, namespace: string = "default"): ScoredFact[] {
    return this.index.aboutEntity(entityName, namespace);
  }

  formatContext(facts: ScoredFact[], format: "markdown" | "json" | "text" = "markdown"): string {
    if (facts.length === 0) return "";

    switch (format) {
      case "json":
        return JSON.stringify(facts.map((f) => ({
          fact: `${f.subject} ${f.predicate} ${f.object}`,
          confidence: f.confidence,
          strength: f.strength,
        })), null, 2);

      case "text":
        return facts.map((f) => `- ${f.subject} ${f.predicate} ${f.object}`).join("\n");

      case "markdown":
      default:
        const lines = [`## Memory Context (${facts.length} facts)\n`];
        for (const f of facts) {
          const stars = "●".repeat(Math.ceil(f.confidence * 5));
          lines.push(`- **${f.subject}** ${f.predicate} **${f.object}** ${stars}`);
        }
        return lines.join("\n");
    }
  }

  getStats() {
    return this.index.getStats();
  }

  private summarize(facts: ScoredFact[]): string {
    if (facts.length === 0) return "No relevant memories found.";
    const top = facts.slice(0, 3).map((f) => `${f.subject} ${f.predicate} ${f.object}`);
    return `Found ${facts.length} relevant facts. Top: ${top.join("; ")}`;
  }
}
