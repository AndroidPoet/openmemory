// OpenMemory — Database Layer
// bun:sqlite + sqlite-vec for local vector search
// Schema designed around facts & entities, not flat memories

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { OpenMemoryConfig } from "../types/index.js";

let db: Database | null = null;

export function getDb(config: OpenMemoryConfig): Database {
  if (db) return db;

  const dbDir = dirname(config.dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Load sqlite-vec extension
  try {
    const sqliteVec = require("sqlite-vec");
    const extPath = sqliteVec.getLoadablePath();
    db.loadExtension(extPath);
  } catch {
    // sqlite-vec may not load in all environments
    // We'll use a fallback table if vec0 isn't available
    console.warn("sqlite-vec not available, vector search will use brute-force fallback");
  }

  initSchema(db, config.embeddingDimensions);

  return db;
}

function initSchema(db: Database, dimensions: number): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      aliases TEXT NOT NULL DEFAULT '[]',
      namespace TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fact_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)");
  db.run("CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)");
  db.run("CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace)");

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
      superseded_by TEXT,
      subject_entity_id TEXT,
      object_entity_id TEXT,
      FOREIGN KEY (subject_entity_id) REFERENCES entities(id),
      FOREIGN KEY (object_entity_id) REFERENCES entities(id),
      FOREIGN KEY (superseded_by) REFERENCES facts(id)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_facts_namespace ON facts(namespace)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_strength ON facts(strength)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_superseded ON facts(superseded_by)");

  db.run(`
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      type TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      FOREIGN KEY (from_entity_id) REFERENCES entities(id),
      FOREIGN KEY (to_entity_id) REFERENCES entities(id),
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type)");

  // Vector embeddings — try sqlite-vec first, fallback to regular table
  try {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
      fact_id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    )`);
  } catch {
    // Fallback: store embeddings as blobs in a regular table
    db.run(`
      CREATE TABLE IF NOT EXISTS vec_facts (
        fact_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
