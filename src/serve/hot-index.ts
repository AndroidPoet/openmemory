// OpenMemory — Hot Index v2
// In-memory index with BM25 + Vector + Entity Graph + Reciprocal Rank Fusion
//
// Search pipeline:
//   1. Tokenize query
//   2. Expand query via entity graph (runtime → Bun, Deno, Node)
//   3. Run 4 independent rankers in parallel:
//      a) BM25 (lexical relevance)
//      b) Vector similarity (semantic relevance)
//      c) Entity graph (structural relevance)
//      d) Recency × strength (temporal relevance)
//   4. Fuse ranks via RRF
//   5. Return top N

import type { Database } from "bun:sqlite";
import { embed, similarity } from "../extract/embedding.js";
import { BM25Index } from "./bm25.js";
import { reciprocalRankFusion, type RankedList } from "./fusion.js";
import type { Fact, ScoredFact, DecayConfig } from "../types/index.js";

interface IndexedFact {
  fact: Fact;
  embedding: Float32Array;
  tokens: string[];           // pre-tokenized for BM25
  tripleKey: string;
}

// ─── Tokenizer ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "it", "of", "in", "to", "and", "or", "for",
  "on", "at", "by", "with", "from", "as", "be", "was", "were", "been",
  "are", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "this", "that", "these",
  "those", "i", "you", "he", "she", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their", "what",
  "which", "who", "whom", "not", "no", "but", "if", "then", "than",
  "so", "just", "about", "up", "out", "into", "over", "after", "before",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

// ─── Hot Index ──────────────────────────────────────────────────────

export class HotIndex {
  // Core storage
  private facts: Map<string, IndexedFact> = new Map();

  // Rankers
  private bm25: BM25Index = new BM25Index();

  // Entity graph (in-memory): entity → Set<connected entity names>
  private entityGraph: Map<string, Set<string>> = new Map();

  // Entity → fact IDs (for entity-based retrieval)
  private entityIndex: Map<string, Set<string>> = new Map();

  // Namespace → fact IDs
  private namespaceIndex: Map<string, Set<string>> = new Map();

  // Predicate → fact IDs (for relation-type queries)
  private predicateIndex: Map<string, Set<string>> = new Map();

  private decayConfig: DecayConfig;

  constructor(
    private db: Database,
    decayConfig: DecayConfig,
  ) {
    this.decayConfig = decayConfig;
  }

  // ─── Bootstrap ────────────────────────────────────────────────────

  load(): { facts: number; timeMs: number } {
    const start = performance.now();

    const rows = this.db.prepare(`
      SELECT f.*, v.embedding FROM facts f
      JOIN vec_facts v ON v.fact_id = f.id
      WHERE f.superseded_by IS NULL AND f.strength > ?
    `).all(this.decayConfig.minStrength) as any[];

    for (const row of rows) {
      const fact = rowToFact(row);
      const emb = new Float32Array(new Uint8Array(row.embedding).buffer);
      this.indexFact(fact, emb);
    }

    return {
      facts: this.facts.size,
      timeMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  // ─── Search: 4-signal RRF fusion ─────────────────────────────────

  search(
    query: string,
    namespace: string = "default",
    limit: number = 10,
    minConfidence: number = 0,
  ): ScoredFact[] {
    const nsFacts = this.namespaceIndex.get(namespace);
    if (!nsFacts || nsFacts.size === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      // No meaningful tokens — return by strength
      return this.topByStrength(nsFacts, limit);
    }

    // ── Step 1: Query expansion (only for entity ranker, NOT BM25) ─
    const expandedTokens = this.expandQuery(queryTokens, namespace);

    // ── Step 2: Run 4 rankers ─────────────────────────────────────

    // Ranker A: BM25 — uses ORIGINAL tokens (expansion adds noise)
    const bm25Scores = this.bm25.score(queryTokens);
    const bm25Ranked = rankByScore(bm25Scores, nsFacts);

    // Ranker B: Vector similarity (semantic)
    const queryEmb = embed(query);
    const vectorScores = new Map<string, number>();
    for (const factId of nsFacts) {
      const indexed = this.facts.get(factId);
      if (!indexed || indexed.fact.confidence < minConfidence) continue;
      vectorScores.set(factId, similarity(queryEmb, indexed.embedding));
    }
    const vectorRanked = rankByScore(vectorScores, nsFacts);

    // Ranker C: Entity graph — uses EXPANDED tokens (finds related concepts)
    const entityScores = this.entityRank(expandedTokens, nsFacts);
    const entityRanked = rankByScore(entityScores, nsFacts);

    // Ranker D: Recency × strength (temporal)
    const temporalScores = new Map<string, number>();
    const now = Date.now();
    for (const factId of nsFacts) {
      const indexed = this.facts.get(factId);
      if (!indexed) continue;
      const days = (now - new Date(indexed.fact.lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
      const recency = Math.exp(-days / 30);
      temporalScores.set(factId, indexed.fact.strength * 0.6 + recency * 0.4);
    }
    const temporalRanked = rankByScore(temporalScores, nsFacts);

    // ── Step 3: Reciprocal Rank Fusion (adaptive weights) ─────────
    // When BM25 has strong hits, trust it more (exact keyword matches).
    // When BM25 finds little, lean on vector similarity (semantic).

    const bm25HasHits = bm25Ranked.length > 0;
    const bm25TopScore = bm25HasHits ? (bm25Scores.get(bm25Ranked[0]!) || 0) : 0;
    const bm25Strong = bm25TopScore > 1.0; // IDF-weighted score > 1.0 means strong match

    const rankedLists: RankedList[] = [
      { name: "bm25", items: bm25Ranked, weight: bm25Strong ? 2.0 : 1.0 },
      { name: "vector", items: vectorRanked, weight: bm25Strong ? 0.6 : 1.2 },
      { name: "entity", items: entityRanked, weight: 0.7 },
      { name: "temporal", items: temporalRanked, weight: 0.3 },
    ];

    const fused = reciprocalRankFusion(rankedLists);

    // ── Step 4: Build results ─────────────────────────────────────

    const results: ScoredFact[] = [];
    for (const item of fused.slice(0, limit)) {
      const indexed = this.facts.get(item.id);
      if (!indexed) continue;

      results.push({
        ...indexed.fact,
        score: item.score,
        relevance: vectorScores.get(item.id) || 0,
      });
    }

    // Async access boost
    this.boostAccessed(results.map((f) => f.id));

    return results;
  }

  // ─── Entity lookup ────────────────────────────────────────────────

  aboutEntity(entityName: string, namespace: string = "default"): ScoredFact[] {
    const key = entityName.toLowerCase();
    const entityFacts = this.entityIndex.get(key);
    if (!entityFacts) return [];

    const nsFacts = this.namespaceIndex.get(namespace);
    if (!nsFacts) return [];

    const results: ScoredFact[] = [];
    for (const factId of entityFacts) {
      if (!nsFacts.has(factId)) continue;
      const indexed = this.facts.get(factId);
      if (!indexed) continue;
      results.push({
        ...indexed.fact,
        score: indexed.fact.strength * indexed.fact.confidence,
        relevance: 1.0,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // ─── Query Expansion ──────────────────────────────────────────────
  // "runtime" → ["runtime", "bun", "deno", "node"]
  // Uses the entity graph to find connected terms

  private expandQuery(tokens: string[], namespace: string): string[] {
    const expanded = new Set(tokens);

    for (const token of tokens) {
      // Check if token matches any entity
      const connected = this.entityGraph.get(token);
      if (connected) {
        for (const related of connected) {
          // Only add if the related entity has facts in this namespace
          const relatedFacts = this.entityIndex.get(related);
          if (relatedFacts) {
            const nsFacts = this.namespaceIndex.get(namespace);
            if (nsFacts) {
              for (const fId of relatedFacts) {
                if (nsFacts.has(fId)) {
                  // Add related entity's tokens to expanded query
                  for (const t of tokenize(related)) {
                    expanded.add(t);
                  }
                  break; // one match is enough
                }
              }
            }
          }
        }
      }
    }

    return [...expanded];
  }

  // ─── Entity-based ranking ─────────────────────────────────────────
  // Score facts based on entity graph proximity to query entities

  private entityRank(queryTokens: string[], nsFacts: Set<string>): Map<string, number> {
    const scores = new Map<string, number>();

    // Find which entities the query mentions
    const queryEntities = new Set<string>();
    for (const token of queryTokens) {
      if (this.entityIndex.has(token)) {
        queryEntities.add(token);
      }
      // Also check if any entity name contains the token
      for (const [entityName] of this.entityIndex) {
        if (entityName.includes(token)) {
          queryEntities.add(entityName);
        }
      }
    }

    // Score facts: direct entity mention = 1.0, connected entity = 0.5
    for (const factId of nsFacts) {
      const indexed = this.facts.get(factId);
      if (!indexed) continue;

      const subj = indexed.fact.subject.toLowerCase();
      const obj = indexed.fact.object.toLowerCase();
      let score = 0;

      // Direct mention
      if (queryEntities.has(subj)) score += 1.0;
      if (queryEntities.has(obj)) score += 1.0;

      // Connected entity (1-hop in graph)
      for (const qe of queryEntities) {
        const connected = this.entityGraph.get(qe);
        if (connected) {
          if (connected.has(subj)) score += 0.5;
          if (connected.has(obj)) score += 0.5;
        }
      }

      if (score > 0) scores.set(factId, score);
    }

    return scores;
  }

  // ─── Write path ───────────────────────────────────────────────────

  add(fact: Fact, embedding: Float32Array): void {
    this.indexFact(fact, embedding);
  }

  remove(factId: string): void {
    const indexed = this.facts.get(factId);
    if (!indexed) return;

    // Remove from BM25
    this.bm25.remove(factId);

    // Remove from entity index
    for (const name of [indexed.fact.subject.toLowerCase(), indexed.fact.object.toLowerCase()]) {
      const set = this.entityIndex.get(name);
      if (set) {
        set.delete(factId);
        if (set.size === 0) this.entityIndex.delete(name);
      }
    }

    // Remove from predicate index
    const pred = indexed.fact.predicate.toLowerCase();
    const predSet = this.predicateIndex.get(pred);
    if (predSet) {
      predSet.delete(factId);
      if (predSet.size === 0) this.predicateIndex.delete(pred);
    }

    // Remove from namespace index
    const nsSet = this.namespaceIndex.get(indexed.fact.namespace);
    if (nsSet) nsSet.delete(factId);

    this.facts.delete(factId);
  }

  supersede(oldFactId: string, _newFactId: string): void {
    this.remove(oldFactId);
  }

  // ─── Stats ────────────────────────────────────────────────────────

  getStats() {
    return {
      factsInMemory: this.facts.size,
      bm25Terms: this.bm25.termCount,
      uniqueEntities: this.entityIndex.size,
      entityGraphEdges: this.countGraphEdges(),
      namespaces: [...this.namespaceIndex.keys()],
      memoryBytes: this.estimateMemory(),
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private indexFact(fact: Fact, embedding: Float32Array): void {
    const text = `${fact.subject} ${fact.predicate} ${fact.object}`;
    const tokens = tokenize(text);
    const tripleKey = `${fact.subject}|${fact.predicate}|${fact.object}`.toLowerCase();

    this.facts.set(fact.id, { fact, embedding, tokens, tripleKey });

    // BM25 index
    this.bm25.add(fact.id, tokens);

    // Entity index + graph
    const subj = fact.subject.toLowerCase();
    const obj = fact.object.toLowerCase();

    for (const name of [subj, obj]) {
      let set = this.entityIndex.get(name);
      if (!set) { set = new Set(); this.entityIndex.set(name, set); }
      set.add(fact.id);
    }

    // Entity graph: connect subject ↔ object
    this.addGraphEdge(subj, obj);

    // Also connect individual tokens to entity names
    // So "runtime" connects to "bun" if a fact says "user uses Bun as runtime"
    for (const token of tokens) {
      if (token !== subj && token !== obj) {
        this.addGraphEdge(token, subj);
        this.addGraphEdge(token, obj);
      }
    }

    // Predicate index
    const pred = fact.predicate.toLowerCase();
    let predSet = this.predicateIndex.get(pred);
    if (!predSet) { predSet = new Set(); this.predicateIndex.set(pred, predSet); }
    predSet.add(fact.id);

    // Namespace index
    let nsSet = this.namespaceIndex.get(fact.namespace);
    if (!nsSet) { nsSet = new Set(); this.namespaceIndex.set(fact.namespace, nsSet); }
    nsSet.add(fact.id);
  }

  private addGraphEdge(a: string, b: string): void {
    let setA = this.entityGraph.get(a);
    if (!setA) { setA = new Set(); this.entityGraph.set(a, setA); }
    setA.add(b);

    let setB = this.entityGraph.get(b);
    if (!setB) { setB = new Set(); this.entityGraph.set(b, setB); }
    setB.add(a);
  }

  private topByStrength(nsFacts: Set<string>, limit: number): ScoredFact[] {
    const results: ScoredFact[] = [];
    for (const factId of nsFacts) {
      const indexed = this.facts.get(factId);
      if (!indexed) continue;
      results.push({
        ...indexed.fact,
        score: indexed.fact.strength,
        relevance: 0,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private boostAccessed(factIds: string[]): void {
    for (const id of factIds) {
      const indexed = this.facts.get(id);
      if (indexed) {
        indexed.fact.accessCount++;
        indexed.fact.lastAccessedAt = new Date().toISOString();
        indexed.fact.strength = Math.min(1.0, indexed.fact.strength + this.decayConfig.accessBoost);
      }
    }

    // Async disk flush
    queueMicrotask(() => {
      const stmt = this.db.prepare(
        "UPDATE facts SET access_count = access_count + 1, last_accessed_at = datetime('now'), strength = MIN(1.0, strength + ?) WHERE id = ?",
      );
      const tx = this.db.transaction(() => {
        for (const id of factIds) stmt.run(this.decayConfig.accessBoost, id);
      });
      tx();
    });
  }

  private countGraphEdges(): number {
    let count = 0;
    for (const set of this.entityGraph.values()) count += set.size;
    return count / 2; // each edge counted twice
  }

  private estimateMemory(): number {
    let bytes = 0;
    bytes += this.facts.size * 768 * 4;    // embeddings
    bytes += this.facts.size * 500;         // fact objects
    bytes += this.bm25.termCount * 100;     // BM25 postings
    bytes += this.entityGraph.size * 80;    // graph
    return bytes;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function rankByScore(scores: Map<string, number>, allowedIds: Set<string>): string[] {
  const entries: [string, number][] = [];
  for (const [id, score] of scores) {
    if (allowedIds.has(id)) entries.push([id, score]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  return entries.map(([id]) => id);
}

function rowToFact(row: any): Fact {
  return {
    id: row.id, subject: row.subject, predicate: row.predicate, object: row.object,
    confidence: row.confidence, source: row.source, namespace: row.namespace,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at, accessCount: row.access_count,
    strength: row.strength, supersededBy: row.superseded_by,
  };
}
