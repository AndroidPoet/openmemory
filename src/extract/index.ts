// OpenMemory — Fact Extraction Engine v2
// Grammar-based extraction. No AI needed.
//
// Strategy: Don't try to match a handful of regex patterns.
// Instead, parse each sentence with multiple extraction strategies,
// pick the best result, normalize subjects and predicates.
//
// Extraction pipeline:
//   1. Split into sentences
//   2. For each sentence, try all extractors (ordered by specificity)
//   3. Normalize: "My X is Y" → user uses Y, "I" → user, etc.
//   4. Deduplicate
//   5. Return clean triples

import type { ExtractedFact, ExtractionResult, OpenMemoryConfig } from "../types/index.js";

// ─── Extractor functions ────────────────────────────────────────────
// Each returns extracted facts or empty array. Ordered by specificity.

type Extractor = (sentence: string) => ExtractedFact[];

// 1. Identity: "My name is X", "I am a Y", "I work at Z"
const extractIdentity: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  if ((m = s.match(/(?:my name is|i'm|i am called|call me)\s+(\w+)/i))) {
    facts.push(fact("user", "named", m[1]!, 0.9, "person", "person"));
  }
  if ((m = s.match(/i\s+(?:am|work)\s+(?:a|an)\s+(.+)/i))) {
    facts.push(fact("user", "is", clean(m[1]!), 0.8, "person", "concept"));
  }
  if ((m = s.match(/i\s+work\s+(?:at|for)\s+(.+)/i))) {
    facts.push(fact("user", "works_at", clean(m[1]!), 0.8, "person", "organization"));
  }
  if ((m = s.match(/i\s+work\s+on\s+(.+)/i))) {
    facts.push(fact("user", "works_on", clean(m[1]!), 0.8, "person", "project"));
  }

  return facts;
};

// 2. Preference: "I like X", "I prefer X over Y", "I hate X"
const extractPreference: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  // "I prefer X over Y" → user prefers X (and implicitly dislikes Y)
  if ((m = s.match(/i\s+prefer\s+(.+?)\s+over\s+(.+)/i))) {
    facts.push(fact("user", "prefers", clean(m[1]!), 0.85, "person", "preference"));
    return facts; // specific match, don't try more
  }

  // "I like/prefer/love/enjoy/favor X"
  if ((m = s.match(/i\s+(?:like|prefer|love|enjoy|favor)\s+(.+)/i))) {
    facts.push(fact("user", "prefers", clean(m[1]!), 0.8, "person", "preference"));
    return facts;
  }

  // "I don't like/hate/dislike/avoid X"
  if ((m = s.match(/i\s+(?:don't like|do not like|hate|dislike|avoid|can't stand)\s+(.+)/i))) {
    facts.push(fact("user", "dislikes", clean(m[1]!), 0.8, "person", "preference"));
    return facts;
  }

  // "I switched/moved/migrated to X"
  if ((m = s.match(/i\s+(?:switched|moved|migrated|changed|transitioned)\s+to\s+(.+)/i))) {
    facts.push(fact("user", "uses", clean(m[1]!), 0.8, "person", "technology"));
    return facts;
  }

  // "I always/usually use X"
  if ((m = s.match(/i\s+(?:always|usually|typically|normally|often)\s+(?:use|prefer|go with)\s+(.+)/i))) {
    facts.push(fact("user", "prefers", clean(m[1]!), 0.75, "person", "preference"));
    return facts;
  }

  // "My favorite X is Y" → user prefers Y
  if ((m = s.match(/my\s+(?:favorite|preferred|go-to)\s+\w+\s+is\s+(.+)/i))) {
    facts.push(fact("user", "prefers", clean(m[1]!), 0.8, "person", "preference"));
    return facts;
  }

  return facts;
};

// 3. "I use X" / "I use X for Y"
const extractUsage: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  if ((m = s.match(/i\s+use\s+(.+?)\s+(?:for|as|to)\s+(.+)/i))) {
    facts.push(fact("user", "uses", clean(m[1]!), 0.8, "person", "technology"));
    facts.push(fact(clean(m[1]!), "used_for", clean(m[2]!), 0.7, "technology", "concept"));
    return facts;
  }

  if ((m = s.match(/i\s+use\s+(.+)/i))) {
    facts.push(fact("user", "uses", clean(m[1]!), 0.8, "person", "technology"));
    return facts;
  }

  return facts;
};

// 4. "My X is Y" → user's X is Y (possessive pattern)
const extractPossessive: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  // "My runtime is Bun" → user uses Bun (as runtime)
  if ((m = s.match(/my\s+(\w+(?:\s+\w+)?)\s+is\s+(.+)/i))) {
    const attr = m[1]!.toLowerCase();
    const value = clean(m[2]!);

    // Map common possessives to predicates
    const possessiveMap: Record<string, string> = {
      name: "named", runtime: "uses", language: "uses", editor: "uses",
      framework: "uses", database: "uses", os: "uses", browser: "uses",
      role: "is", job: "is", title: "is",
    };

    const predicate = possessiveMap[attr] || "has";
    facts.push(fact("user", predicate, value, 0.75, "person", inferType(value)));
  }

  return facts;
};

// 5. Passive: "X is used for Y", "X is done with Y", "X is handled by Y"
const extractPassive: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  if ((m = s.match(/(.+?)\s+is\s+(?:used|done|built|written|made|handled|managed)\s+(?:for|with|by|in|using)\s+(.+)/i))) {
    facts.push(fact(clean(m[1]!), "uses", clean(m[2]!), 0.7, inferType(m[1]!), inferType(m[2]!)));
    return facts;
  }

  // "X is used for the Y"
  if ((m = s.match(/(.+?)\s+is\s+used\s+(?:for|as)\s+(?:the\s+)?(.+)/i))) {
    facts.push(fact(clean(m[1]!), "used_for", clean(m[2]!), 0.7, "technology", "concept"));
    return facts;
  }

  return facts;
};

// 6. Active verb: "X uses Y", "X handles Y", "X runs Y"
const extractActiveVerb: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  // "X uses/runs/handles/manages/supports Y"
  if ((m = s.match(/(.+?)\s+(?:uses?|runs?|handles?|manages?|supports?|provides?)\s+(.+)/i))) {
    const subj = clean(m[1]!);
    const obj = clean(m[2]!);
    if (subj.length < 40 && obj.length < 80) {
      facts.push(fact(subj, "uses", obj, 0.6, inferType(subj), inferType(obj)));
    }
    return facts;
  }

  // "X depends on Y" / "X requires Y"
  if ((m = s.match(/(.+?)\s+(?:depends?\s+on|requires?|needs?)\s+(.+)/i))) {
    facts.push(fact(clean(m[1]!), "depends_on", clean(m[2]!), 0.6, inferType(m[1]!), inferType(m[2]!)));
    return facts;
  }

  return facts;
};

// 7. Deploy/host: "We deploy on X", "Hosted on X", "Runs on X"
const extractInfra: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  if ((m = s.match(/(?:we|i|it)?\s*(?:deploy|host|run|serve)\s+(?:on|to|via|with|using)\s+(.+)/i))) {
    facts.push(fact("project", "deploys_on", clean(m[1]!), 0.7, "project", "technology"));
    return facts;
  }

  if ((m = s.match(/(?:deployed|hosted|running|served)\s+(?:on|via|with)\s+(.+)/i))) {
    facts.push(fact("project", "deploys_on", clean(m[1]!), 0.7, "project", "technology"));
    return facts;
  }

  return facts;
};

// 8. "X is Y" (simple copula — lowest priority, catches everything else)
const extractCopula: Extractor = (s) => {
  const facts: ExtractedFact[] = [];
  let m;

  if ((m = s.match(/^(.+?)\s+(?:is|are)\s+(?:a|an|the)?\s*(.+)/i))) {
    const subj = clean(m[1]!);
    const obj = clean(m[2]!);
    if (subj.length > 1 && subj.length < 40 && obj.length > 1 && obj.length < 80) {
      // Skip if subject starts with common noise words
      if (/^(it|this|that|there|here)$/i.test(subj)) return facts;
      facts.push(fact(subj, "is", obj, 0.5, inferType(subj), inferType(obj)));
    }
  }

  return facts;
};

// ─── Extraction pipeline ────────────────────────────────────────────

const EXTRACTORS: Extractor[] = [
  extractIdentity,
  extractPreference,
  extractUsage,
  extractPossessive,
  extractPassive,
  extractInfra,
  extractActiveVerb,
  extractCopula,
];

function extractLocal(content: string): ExtractionResult {
  const sentences = content
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  const allFacts: ExtractedFact[] = [];

  for (const sentence of sentences) {
    // Try each extractor in order of specificity.
    // Use the FIRST one that returns results (most specific wins).
    for (const extractor of EXTRACTORS) {
      const results = extractor(sentence);
      if (results.length > 0) {
        allFacts.push(...results);
        break; // don't try less-specific extractors
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = allFacts.filter((f) => {
    const key = `${f.subject}|${f.predicate}|${f.object}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    facts: unique,
    summary: unique.length > 0
      ? `Extracted ${unique.length} fact(s)`
      : "No facts could be extracted",
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function fact(
  subject: string, predicate: string, object: string,
  confidence: number,
  subjType: ExtractedFact["entityTypes"]["subject"],
  objType: ExtractedFact["entityTypes"]["object"],
): ExtractedFact {
  return {
    subject, predicate, object, confidence,
    entityTypes: { subject: subjType, object: objType },
  };
}

function clean(s: string): string {
  return s.trim().replace(/\.$/, "").replace(/^(a|an|the)\s+/i, "").trim();
}

function inferType(text: string): "person" | "project" | "technology" | "preference" | "concept" | "organization" | "other" {
  const lower = text.toLowerCase().trim();
  if (/^(user|i|me|my)$/.test(lower)) return "person";
  if (/typescript|javascript|python|react|vue|svelte|go|rust|swift|kotlin|node|bun|deno|sqlite|postgres|hono|tailwind|trpc|vitest|jest|zod|redis|docker|cloudflare/i.test(lower)) return "technology";
  if (/company|inc|corp|llc|team|org|startup/i.test(lower)) return "organization";
  if (/project|app|repo|library|package/i.test(lower)) return "project";
  if (/prefer|like|style|mode|theme|setting/i.test(lower)) return "preference";
  return "concept";
}

// ─── Claude API Extraction ──────────────────────────────────────────

async function extractWithClaude(content: string, config: OpenMemoryConfig): Promise<ExtractionResult> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY required for Claude extraction");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.extractionModel,
      max_tokens: 1024,
      system: `You are a fact extraction engine. Given text, extract atomic facts as subject-predicate-object triples.

Rules:
- Each fact should be ONE atomic piece of knowledge
- Subject and object should be short (1-5 words)
- Predicate should be a verb phrase (prefers, uses, works_on, is, has, dislikes, etc.)
- Assign confidence 0.0-1.0 based on how explicit the fact is
- Classify entity types: person, project, technology, preference, concept, organization, file, other
- Extract ALL facts, even implicit ones
- If the user states a preference, the subject is "user"

Respond ONLY with valid JSON:
{
  "facts": [{ "subject": "", "predicate": "", "object": "", "confidence": 0.0, "entityTypes": { "subject": "", "object": "" } }],
  "summary": "one line summary"
}`,
      messages: [{ role: "user", content: `Extract facts from:\n\n${content}` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} ${err}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content[0]?.text || "{}";

  try {
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(jsonStr) as ExtractionResult;
  } catch {
    return extractLocal(content);
  }
}

// ─── Ollama Extraction ──────────────────────────────────────────────

async function extractWithOllama(content: string, config: OpenMemoryConfig): Promise<ExtractionResult> {
  const response = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.extractionModel,
      prompt: `Extract atomic facts as JSON from this text. Each fact: { subject, predicate, object, confidence (0-1), entityTypes: { subject, object } }. Entity types: person, project, technology, preference, concept, organization, other. Return: { "facts": [...], "summary": "..." }\n\nText: ${content}`,
      stream: false,
      format: "json",
    }),
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);

  const data = await response.json() as { response: string };
  try {
    return JSON.parse(data.response) as ExtractionResult;
  } catch {
    return extractLocal(content);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export async function extractFacts(
  content: string,
  config: OpenMemoryConfig,
): Promise<ExtractionResult> {
  switch (config.extractionProvider) {
    case "claude": return extractWithClaude(content, config);
    case "ollama": return extractWithOllama(content, config);
    case "local":
    default: return extractLocal(content);
  }
}

export { extractLocal };
