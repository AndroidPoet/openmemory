// OpenMemory — Configuration
// Reads from env vars and provides sensible defaults

import { config as loadEnv } from "dotenv";
import { join } from "path";
import { homedir } from "os";
import type { OpenMemoryConfig } from "./types/index.js";

const DATA_DIR = join(homedir(), ".openmemory");

export function loadConfig(): OpenMemoryConfig {
  // Load from ~/.openmemory/.env if exists
  loadEnv({ path: join(DATA_DIR, ".env") });
  // Also load from cwd
  loadEnv();

  return {
    dbPath: process.env.OPENMEMORY_DB_PATH || join(DATA_DIR, "data", "openmemory.db"),
    embeddingDimensions: 768,
    extractionProvider: (process.env.OPENMEMORY_EXTRACTION_PROVIDER as OpenMemoryConfig["extractionProvider"]) || "local",
    extractionModel: process.env.OPENMEMORY_EXTRACTION_MODEL || "claude-sonnet-4-20250514",
    apiKey: process.env.OPENMEMORY_API_KEY,
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    port: parseInt(process.env.PORT || "3838", 10),
    decay: {
      halfLifeDays: 30,
      accessBoost: 0.15,
      minStrength: 0.05,
      supersededPenalty: 0.7,
    },
  };
}
