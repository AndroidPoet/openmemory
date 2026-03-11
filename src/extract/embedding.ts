// OpenMemory — Local Embedding Engine
// TF-IDF feature hashing → 768-dim vectors
// Zero dependencies, zero API calls, works offline

const DIMENSIONS = 768;
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

function hash(str: string, seed: number = 0): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export function embed(text: string): Float32Array {
  const vec = new Float32Array(DIMENSIONS);
  const tokens = tokenize(text);

  // Unigrams (weight: 1.0)
  for (const token of tokens) {
    const idx = hash(token) % DIMENSIONS;
    vec[idx] += 1.0;
  }

  // Bigrams (weight: 0.5) — capture phrase-level meaning
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    const idx = hash(bigram, 1) % DIMENSIONS;
    vec[idx] += 0.5;
  }

  // Trigrams (weight: 0.3) — capture context
  for (let i = 0; i < tokens.length - 2; i++) {
    const trigram = `${tokens[i]}_${tokens[i + 1]}_${tokens[i + 2]}`;
    const idx = hash(trigram, 2) % DIMENSIONS;
    vec[idx] += 0.3;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIMENSIONS; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    dot += a[i] * b[i];
  }
  return dot; // cosine similarity (vectors are already normalized)
}
