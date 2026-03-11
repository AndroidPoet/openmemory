// OpenMemory — Smart Forgetting
// Facts decay over time. Accessed facts stay strong. Irrelevant ones fade.

import type { Database } from "bun:sqlite";
import type { DecayConfig } from "../types/index.js";

export class DecayEngine {
  constructor(
    private db: Database,
    private config: DecayConfig,
  ) {}

  applyDecay(): { decayed: number; archived: number } {
    const now = Date.now();
    let decayed = 0;
    let archived = 0;

    const facts = this.db.prepare(
      "SELECT id, strength, last_accessed_at, access_count FROM facts WHERE superseded_by IS NULL AND strength > ?",
    ).all(this.config.minStrength) as any[];

    const updateStmt = this.db.prepare(
      "UPDATE facts SET strength = ?, updated_at = datetime('now') WHERE id = ?",
    );

    const tx = this.db.transaction(() => {
      for (const fact of facts) {
        const daysSinceAccess = (now - new Date(fact.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24);
        const decayFactor = Math.pow(2, -daysSinceAccess / this.config.halfLifeDays);
        const accessResistance = Math.min(fact.access_count * 0.02, 0.5);
        const adjustedDecay = decayFactor + (1 - decayFactor) * accessResistance;
        const newStrength = fact.strength * adjustedDecay;

        if (newStrength < this.config.minStrength) {
          updateStmt.run(0, fact.id);
          archived++;
        } else if (newStrength < fact.strength - 0.001) {
          updateStmt.run(newStrength, fact.id);
          decayed++;
        }
      }
    });

    tx();
    return { decayed, archived };
  }

  boostOnAccess(factId: string): void {
    this.db.prepare(`
      UPDATE facts SET strength = MIN(1.0, strength + ?), access_count = access_count + 1, last_accessed_at = datetime('now')
      WHERE id = ?
    `).run(this.config.accessBoost, factId);
  }

  revive(factId: string): void {
    this.db.prepare(
      "UPDATE facts SET strength = 1.0, last_accessed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).run(factId);
  }
}
