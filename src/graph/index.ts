// OpenMemory — Knowledge Graph
// Manages entities and their relationships
// Facts are stored as triples; entities are nodes; relations are edges

import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import type { Entity, EntityType, ExtractedFact, Fact, Relation } from "../types/index.js";

export class KnowledgeGraph {
  constructor(private db: Database) {}

  // ─── Entity Management ─────────────────────────────────────────────

  findEntity(name: string, namespace: string): Entity | null {
    const exact = this.db
      .prepare("SELECT * FROM entities WHERE LOWER(name) = LOWER(?) AND namespace = ?")
      .get(name, namespace) as any;
    if (exact) return this.rowToEntity(exact);

    const alias = this.db
      .prepare("SELECT * FROM entities WHERE namespace = ? AND LOWER(aliases) LIKE ?")
      .get(namespace, `%${name.toLowerCase()}%`) as any;
    if (alias) return this.rowToEntity(alias);

    return null;
  }

  getOrCreateEntity(name: string, type: EntityType, namespace: string): Entity {
    const existing = this.findEntity(name, namespace);
    if (existing) {
      if (existing.type === "other" && type !== "other") {
        this.db.prepare("UPDATE entities SET type = ? WHERE id = ?").run(type, existing.id);
        existing.type = type;
      }
      return existing;
    }

    const id = nanoid();
    this.db.prepare(
      "INSERT INTO entities (id, name, type, aliases, namespace) VALUES (?, ?, ?, '[]', ?)",
    ).run(id, name, type, namespace);

    return {
      id, name, type, aliases: [], namespace,
      createdAt: new Date().toISOString(),
      factCount: 0,
    };
  }

  // ─── Fact Storage ──────────────────────────────────────────────────

  storeFact(
    extracted: ExtractedFact,
    namespace: string,
    source: string,
    embedding: Float32Array,
  ): Fact {
    const id = nanoid();

    const subjectEntity = this.getOrCreateEntity(
      extracted.subject, extracted.entityTypes.subject, namespace,
    );
    const objectEntity = this.getOrCreateEntity(
      extracted.object, extracted.entityTypes.object, namespace,
    );

    this.db.prepare(`
      INSERT INTO facts (id, subject, predicate, object, confidence, source, namespace, subject_entity_id, object_entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, extracted.subject, extracted.predicate, extracted.object, extracted.confidence, source, namespace, subjectEntity.id, objectEntity.id);

    // Store embedding
    this.db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)").run(
      id,
      new Uint8Array(embedding.buffer),
    );

    // Create relation
    const relationId = nanoid();
    this.db.prepare(
      "INSERT INTO relations (id, from_entity_id, to_entity_id, type, fact_id, weight) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(relationId, subjectEntity.id, objectEntity.id, extracted.predicate, id, extracted.confidence);

    // Update fact counts
    this.db.prepare("UPDATE entities SET fact_count = fact_count + 1 WHERE id IN (?, ?)").run(subjectEntity.id, objectEntity.id);

    return {
      id,
      subject: extracted.subject,
      predicate: extracted.predicate,
      object: extracted.object,
      confidence: extracted.confidence,
      source, namespace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      strength: 1.0,
      supersededBy: null,
    };
  }

  // ─── Queries ───────────────────────────────────────────────────────

  getFactsAbout(entityName: string, namespace: string, limit: number = 20): Fact[] {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE namespace = ? AND (LOWER(subject) = LOWER(?) OR LOWER(object) = LOWER(?))
        AND superseded_by IS NULL AND strength > 0.05
      ORDER BY strength DESC, confidence DESC
      LIMIT ?
    `).all(namespace, entityName, entityName, limit) as any[];
    return rows.map(this.rowToFact);
  }

  getRelatedEntities(entityId: string, limit: number = 10): Array<{ entity: Entity; relation: string; weight: number }> {
    const rows = this.db.prepare(`
      SELECT e.*, r.type as rel_type, r.weight as rel_weight FROM relations r
      JOIN entities e ON (e.id = r.to_entity_id AND r.from_entity_id = ?)
         OR (e.id = r.from_entity_id AND r.to_entity_id = ?)
      JOIN facts f ON f.id = r.fact_id AND f.superseded_by IS NULL
      ORDER BY r.weight DESC
      LIMIT ?
    `).all(entityId, entityId, limit) as any[];
    return rows.map((r) => ({ entity: this.rowToEntity(r), relation: r.rel_type, weight: r.rel_weight }));
  }

  getAllEntities(namespace: string): Entity[] {
    const rows = this.db.prepare(
      "SELECT * FROM entities WHERE namespace = ? ORDER BY fact_count DESC",
    ).all(namespace) as any[];
    return rows.map(this.rowToEntity);
  }

  getGraphData(namespace: string) {
    const entities = this.getAllEntities(namespace);
    const relations = this.db.prepare(`
      SELECT r.from_entity_id, r.to_entity_id, r.type, r.weight
      FROM relations r
      JOIN facts f ON f.id = r.fact_id AND f.superseded_by IS NULL AND f.namespace = ?
      ORDER BY r.weight DESC
    `).all(namespace) as any[];

    return {
      entities,
      relations: relations.map((r: any) => ({
        from: r.from_entity_id, to: r.to_entity_id, type: r.type, weight: r.weight,
      })),
    };
  }

  getStats(namespace?: string) {
    const ns = namespace || null;
    const entities = ns
      ? (this.db.prepare("SELECT COUNT(*) as c FROM entities WHERE namespace = ?").get(ns) as any).c
      : (this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as any).c;
    const facts = ns
      ? (this.db.prepare("SELECT COUNT(*) as c FROM facts WHERE namespace = ?").get(ns) as any).c
      : (this.db.prepare("SELECT COUNT(*) as c FROM facts").get() as any).c;
    const activeFacts = ns
      ? (this.db.prepare("SELECT COUNT(*) as c FROM facts WHERE namespace = ? AND superseded_by IS NULL AND strength > 0.05").get(ns) as any).c
      : (this.db.prepare("SELECT COUNT(*) as c FROM facts WHERE superseded_by IS NULL AND strength > 0.05").get() as any).c;
    const relations = (this.db.prepare("SELECT COUNT(*) as c FROM relations").get() as any).c;

    return { entities, facts, relations, activeFacts };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private rowToEntity(row: any): Entity {
    return {
      id: row.id, name: row.name, type: row.type as EntityType,
      aliases: JSON.parse(row.aliases || "[]"),
      namespace: row.namespace, createdAt: row.created_at, factCount: row.fact_count,
    };
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
