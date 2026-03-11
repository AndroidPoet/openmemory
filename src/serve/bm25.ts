// OpenMemory — BM25 Ranking
// Okapi BM25: the algorithm behind every serious search engine.
// Better than TF-IDF because it handles:
//   - Term frequency saturation (mentioning "TypeScript" 10x isn't 10x better than 1x)
//   - Document length normalization (short facts aren't penalized vs long ones)
//   - Inverse document frequency (rare terms matter more)

// BM25 parameters (tuned for short fact triples)
const K1 = 1.2;   // term frequency saturation (lower = faster saturation)
const B = 0.5;    // length normalization (0 = no normalization, 1 = full)

export class BM25Index {
  // term → { docId → termFrequency }
  private postings: Map<string, Map<string, number>> = new Map();
  // docId → document length (token count)
  private docLengths: Map<string, number> = new Map();
  // Total documents
  private docCount: number = 0;
  // Average document length
  private avgDocLength: number = 0;

  // Add a document to the index
  add(docId: string, tokens: string[]): void {
    this.docLengths.set(docId, tokens.length);
    this.docCount++;

    // Recompute average
    let total = 0;
    for (const len of this.docLengths.values()) total += len;
    this.avgDocLength = total / this.docCount;

    // Build term frequencies
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Update postings list
    for (const [term, freq] of tf) {
      let posting = this.postings.get(term);
      if (!posting) {
        posting = new Map();
        this.postings.set(term, posting);
      }
      posting.set(docId, freq);
    }
  }

  // Remove a document
  remove(docId: string): void {
    const docLen = this.docLengths.get(docId);
    if (docLen === undefined) return;

    this.docLengths.delete(docId);
    this.docCount--;

    // Recompute average
    if (this.docCount > 0) {
      let total = 0;
      for (const len of this.docLengths.values()) total += len;
      this.avgDocLength = total / this.docCount;
    } else {
      this.avgDocLength = 0;
    }

    // Remove from postings
    for (const [, posting] of this.postings) {
      posting.delete(docId);
    }
  }

  // Score documents against a query
  // Returns Map<docId, bm25Score> sorted by score desc
  score(queryTokens: string[]): Map<string, number> {
    const scores = new Map<string, number>();

    for (const term of queryTokens) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
      const df = posting.size;
      const idf = Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);

      for (const [docId, tf] of posting) {
        const docLen = this.docLengths.get(docId) || 0;

        // BM25 term score:
        // (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
        const numerator = tf * (K1 + 1);
        const denominator = tf + K1 * (1 - B + B * (docLen / this.avgDocLength));
        const termScore = idf * (numerator / denominator);

        scores.set(docId, (scores.get(docId) || 0) + termScore);
      }
    }

    return scores;
  }

  // Get IDF for a term (useful for query expansion weighting)
  getIdf(term: string): number {
    const posting = this.postings.get(term);
    if (!posting) return 0;
    const df = posting.size;
    return Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);
  }

  get size(): number {
    return this.docCount;
  }

  get termCount(): number {
    return this.postings.size;
  }
}
