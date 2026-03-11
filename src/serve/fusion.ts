// OpenMemory — Reciprocal Rank Fusion (RRF)
// The secret sauce of modern search engines.
//
// Problem: We have multiple ranking signals (BM25, vector, entity, recency).
// Each is good at different things. How do we combine them?
//
// Naive approach: weighted average. But this is fragile — weights are arbitrary,
// scores from different rankers aren't on the same scale.
//
// RRF approach: Each ranker produces a RANKED LIST. We fuse the ranks,
// not the scores. A fact ranked #1 by BM25 and #3 by vector similarity
// gets a higher fused score than a fact ranked #2 by both.
//
// Formula: RRF(d) = Σ 1 / (k + rank_i(d))
// where k is a constant (typically 60) that prevents top-ranked docs
// from dominating too heavily.

const RRF_K = 60;

export interface RankedList {
  name: string;          // ranker name (for debugging)
  items: string[];       // fact IDs in ranked order (best first)
  weight: number;        // how much this ranker's vote counts
}

export interface FusedResult {
  id: string;
  score: number;
  ranks: Record<string, number>;  // rankerName → rank position
}

// Fuse multiple ranked lists into a single ranking
export function reciprocalRankFusion(lists: RankedList[]): FusedResult[] {
  const scores = new Map<string, { score: number; ranks: Record<string, number> }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.items.length; rank++) {
      const id = list.items[rank]!;
      let entry = scores.get(id);
      if (!entry) {
        entry = { score: 0, ranks: {} };
        scores.set(id, entry);
      }

      // RRF score contribution: weight / (k + rank + 1)
      // +1 because rank is 0-indexed
      entry.score += list.weight / (RRF_K + rank + 1);
      entry.ranks[list.name] = rank + 1; // 1-indexed for display
    }
  }

  // Sort by fused score
  const results: FusedResult[] = [];
  for (const [id, entry] of scores) {
    results.push({ id, score: entry.score, ranks: entry.ranks });
  }
  results.sort((a, b) => b.score - a.score);

  return results;
}

// Normalize scores from a ranker to [0, 1] for debugging/display
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const s of scores.values()) {
    if (s > max) max = s;
  }
  if (max === 0) return scores;

  const normalized = new Map<string, number>();
  for (const [id, s] of scores) {
    normalized.set(id, s / max);
  }
  return normalized;
}
