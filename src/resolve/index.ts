// OpenMemory — Contradiction Resolution
// Detects when new facts contradict existing ones and resolves them

import type { Database } from "bun:sqlite";
import type { Contradiction, ExtractedFact, Fact, DecayConfig } from "../types/index.js";

export class ContradictionResolver {
  constructor(
    private db: Database,
    private decayConfig: DecayConfig,
  ) {}

  findContradictions(newFact: ExtractedFact, namespace: string): Contradiction[] {
    const contradictions: Contradiction[] = [];

    // Only check mutually exclusive predicates for contradictions.
    // "user prefers dark mode" and "user prefers TypeScript" are NOT contradictions.
    // "user works_at Google" and "user works_at Meta" ARE contradictions.
    if (this.areMutuallyExclusive(newFact.predicate)) {
      const samePredicate = this.db.prepare(`
        SELECT * FROM facts
        WHERE namespace = ? AND LOWER(subject) = LOWER(?) AND LOWER(predicate) = LOWER(?)
          AND superseded_by IS NULL AND strength > 0.05
      `).all(namespace, newFact.subject, newFact.predicate) as any[];

      for (const row of samePredicate) {
        const existing = this.rowToFact(row);
        if (existing.object.toLowerCase() !== newFact.object.toLowerCase()) {
          const type = this.classifyContradiction(existing, newFact);
          contradictions.push({
            existingFact: existing, newFact, type,
            resolution: this.determineResolution(existing, newFact, type),
          });
        }
      }
    }

    // Check negation pairs (prefers ↔ dislikes, etc.)
    const negationPairs: Record<string, string> = {
      prefers: "dislikes", likes: "dislikes", uses: "avoids", supports: "opposes",
    };
    const opposite = negationPairs[newFact.predicate.toLowerCase()];
    if (opposite) {
      const negated = this.db.prepare(`
        SELECT * FROM facts
        WHERE namespace = ? AND LOWER(subject) = LOWER(?) AND LOWER(predicate) = LOWER(?) AND LOWER(object) = LOWER(?)
          AND superseded_by IS NULL
      `).all(namespace, newFact.subject, opposite, newFact.object) as any[];

      for (const row of negated) {
        contradictions.push({
          existingFact: this.rowToFact(row), newFact,
          type: "direct", resolution: "supersede",
        });
      }
    }

    return contradictions;
  }

  resolve(contradictions: Contradiction[], newFactId: string): void {
    for (const c of contradictions) {
      switch (c.resolution) {
        case "supersede":
          this.db.prepare(
            "UPDATE facts SET superseded_by = ?, strength = strength * ?, updated_at = datetime('now') WHERE id = ?",
          ).run(newFactId, 1 - this.decayConfig.supersededPenalty, c.existingFact.id);
          break;
        case "merge":
          this.db.prepare(
            "UPDATE facts SET strength = strength * 0.5, updated_at = datetime('now') WHERE id = ?",
          ).run(c.existingFact.id);
          break;
        case "keep_both":
          break;
      }
    }
  }

  private classifyContradiction(existing: Fact, _newFact: ExtractedFact): "direct" | "temporal" | "partial" {
    if (this.areMutuallyExclusive(existing.predicate)) return "direct";
    if (["works_at", "lives_in", "is", "works_on"].includes(existing.predicate.toLowerCase())) return "temporal";
    return "partial";
  }

  private determineResolution(_existing: Fact, newFact: ExtractedFact, type: "direct" | "temporal" | "partial"): "supersede" | "merge" | "keep_both" {
    if (type === "direct" || type === "temporal") return "supersede";
    if (newFact.confidence < 0.5) return "keep_both";
    return "merge";
  }

  private areMutuallyExclusive(predicate: string): boolean {
    // Only predicates where you can have ONE value at a time.
    // "prefers" is NOT exclusive — you can prefer many things.
    // "uses" is NOT exclusive — you can use multiple tools.
    return ["is", "works_at", "lives_in", "named"].includes(predicate.toLowerCase());
  }

  private rowToFact(row: any): Fact {
    return {
      id: row.id, subject: row.subject, predicate: row.predicate, object: row.object,
      confidence: row.confidence, source: row.source, namespace: row.namespace,
      createdAt: row.created_at, updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at, accessCount: row.access_count,
      strength: row.strength, supersededBy: row.superseded_by,
    };
  }
}
