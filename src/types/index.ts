// OpenMemory — Core Types
// The data model is built around FACTS, not blobs.
// Every piece of knowledge is an atomic fact with typed relationships.

export interface Fact {
  id: string;
  subject: string;       // "Ranbir", "project/memorybox", "TypeScript"
  predicate: string;     // "prefers", "uses", "works_on", "dislikes"
  object: string;        // "dark mode", "SQLite", "sycophantic responses"
  confidence: number;    // 0.0 - 1.0 (how certain we are)
  source: string;        // "conversation", "explicit", "inferred"
  namespace: string;     // isolation boundary (per-user, per-project)
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  strength: number;      // 0.0 - 1.0 (decays over time, boosts on access)
  supersededBy: string | null; // ID of fact that replaced this one
}

export interface Entity {
  id: string;
  name: string;          // canonical name
  type: EntityType;
  aliases: string[];     // other names for this entity
  namespace: string;
  createdAt: string;
  factCount: number;
}

export type EntityType =
  | "person"
  | "project"
  | "technology"
  | "preference"
  | "concept"
  | "organization"
  | "file"
  | "other";

export interface Relation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;          // "prefers", "uses", "works_on", etc.
  factId: string;        // the fact this relation was derived from
  weight: number;        // strength of relationship
}

// What the LLM extraction returns
export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  entityTypes: {
    subject: EntityType;
    object: EntityType;
  };
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  summary: string;       // one-line summary of what was learned
}

// Contradiction detection
export interface Contradiction {
  existingFact: Fact;
  newFact: ExtractedFact;
  type: "direct" | "temporal" | "partial";
  resolution: "supersede" | "merge" | "keep_both";
}

// Search & retrieval
export interface MemoryQuery {
  query: string;
  namespace?: string;
  limit?: number;
  entityFilter?: string[];
  minConfidence?: number;
  minStrength?: number;
  includeSuperseded?: boolean;
}

export interface MemoryResult {
  facts: ScoredFact[];
  entities: Entity[];
  summary: string;
}

export interface ScoredFact extends Fact {
  score: number;         // combined relevance score
  relevance: number;     // semantic similarity to query
}

// Decay configuration
export interface DecayConfig {
  halfLifeDays: number;       // strength halves every N days
  accessBoost: number;        // strength boost per access (0-1)
  minStrength: number;        // below this, fact is archived
  supersededPenalty: number;  // immediate strength reduction when superseded
}

// API types
export interface SaveInput {
  content: string;            // raw text to extract facts from
  namespace?: string;
  source?: string;
}

export interface SearchInput {
  query: string;
  namespace?: string;
  limit?: number;
  minConfidence?: number;
}

export interface ContextInput {
  query: string;
  namespace?: string;
  maxFacts?: number;
  format?: "markdown" | "json" | "text";
}

// Config
export interface OpenMemoryConfig {
  dbPath: string;
  embeddingDimensions: number;
  extractionProvider: "claude" | "ollama" | "local";
  extractionModel: string;
  apiKey?: string;
  ollamaUrl?: string;
  anthropicApiKey?: string;
  port: number;
  decay: DecayConfig;
}
