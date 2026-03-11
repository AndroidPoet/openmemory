<div align="center">

```
   ___                   __  __
  / _ \ _ __   ___ _ __ |  \/  | ___ _ __ ___   ___  _ __ _   _
 | | | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
 | |_| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \___/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
       |_|                                                  |___/
```

**The open source memory layer for AI.**

One memory. Every AI tool. Yours forever.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](https://bun.sh)

</div>

---

## The Problem

Every AI tool you use starts with zero context. Claude doesn't know what you told ChatGPT. Cursor doesn't know your preferences from Claude Code. Your AI has amnesia.

**OpenMemory fixes this.** It's a universal memory engine that any AI tool plugs into — one brain, shared everywhere.

## How It Works

```
You: "I prefer TypeScript over JavaScript"
                    ↓
            ┌── Extract ──┐
            │  user        │
            │  prefers     │   ← Atomic fact (no blobs)
            │  TypeScript  │
            └──────────────┘
                    ↓
        ┌── Contradiction? ──┐
        │  Same subject +    │
        │  predicate exists? │   ← "user prefers JavaScript" → superseded
        └────────────────────┘
                    ↓
         ┌── Knowledge Graph ──┐
         │  user ──prefers──▶ TypeScript  │
         │       ──uses────▶ Bun          │   ← Entities + relations
         │       ──named───▶ Ranbir       │
         └────────────────────────────────┘
                    ↓
          ┌── Smart Decay ──┐
          │  Accessed = strong  │
          │  Forgotten = fades  │   ← No bloat, stays sharp
          └─────────────────────┘
```

## Features

- **Facts, not blobs** — Stores atomic knowledge triples (subject → predicate → object), not paragraphs
- **Contradiction resolution** — "I switched to Deno" automatically supersedes "I use Bun"
- **Smart forgetting** — Unused facts decay. Accessed facts stay strong. Memory stays sharp
- **Knowledge graph** — Entities and relationships, not flat storage
- **BM25 + Vector + RRF** — 4-signal retrieval fusion for sub-millisecond search
- **Zero AI dependency** — Grammar-based extraction works offline, no API keys needed
- **MCP server** — Plug into Claude Code, Cursor, Windsurf, any MCP client
- **REST API** — Any app can read/write memories
- **100% local** — All data stays on your machine. SQLite. No cloud

## Quick Start

```bash
git clone https://github.com/AndroidPoet/openmemory.git
cd openmemory
bun install
bun run dev
```

Server starts at `http://localhost:3838`.

## Usage

### Add memories (extracts facts automatically)

```bash
curl -X POST http://localhost:3838/api/v1/add \
  -H "Content-Type: application/json" \
  -d '{"content": "I prefer TypeScript. My runtime is Bun. I work on OpenMemory."}'
```

```json
{
  "stored": 3,
  "facts": [
    { "fact": "user prefers TypeScript", "confidence": 0.85 },
    { "fact": "user uses Bun", "confidence": 0.75 },
    { "fact": "user works_on OpenMemory", "confidence": 0.8 }
  ]
}
```

### Search memories

```bash
curl -X POST http://localhost:3838/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "What runtime does the user prefer?"}'
```

### Get AI context

```bash
curl -X POST http://localhost:3838/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{"query": "Tell me about the user", "format": "markdown"}'
```

### MCP Server (Claude Code, Cursor, etc.)

```bash
bun run mcp
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "bun",
      "args": ["run", "/path/to/openmemory/src/index.ts", "mcp"]
    }
  }
}
```

Then just talk naturally:

> "Remember that I prefer dark mode"
> "What do you know about my project?"
> "What's my name?"

## Architecture

```
src/
├── extract/          Fact extraction (grammar-based, zero AI)
│   ├── index.ts      8 specialized extractors, ordered by specificity
│   └── embedding.ts  Local TF-IDF embeddings (768-dim)
├── graph/            Knowledge graph (entities + relations)
├── resolve/          Contradiction detection + resolution
├── decay/            Smart forgetting (exponential decay + access boost)
├── serve/            Context retrieval + ranking
│   ├── hot-index.ts  In-memory index (sub-ms search)
│   ├── bm25.ts       Okapi BM25 ranking
│   └── fusion.ts     Reciprocal Rank Fusion
├── api/              REST API (Hono)
├── mcp/              MCP server (6 tools)
└── db/               SQLite + sqlite-vec
```

## Search Pipeline

Every query runs through 4 independent rankers, fused via RRF:

| Ranker | What it does | Signal |
|--------|-------------|--------|
| **BM25** | Term frequency + inverse document frequency | Exact keyword matches |
| **Vector** | Cosine similarity on TF-IDF embeddings | Semantic meaning |
| **Entity Graph** | Graph traversal from query entities | Structural relationships |
| **Temporal** | Strength × recency decay | What's fresh and strong |

Results are fused using [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) — each ranker votes independently, ranks are combined. No single signal dominates.

**Adaptive weighting**: When BM25 finds strong keyword matches, it gets 2x weight. When keywords miss, vector similarity takes over.

## MCP Tools

| Tool | Description |
|------|-------------|
| `remember` | Extract and store facts from natural language |
| `recall` | Search memories semantically |
| `get_memory_context` | Get formatted context for AI injection |
| `about` | Everything known about an entity |
| `forget` | Forget a specific fact |
| `memory_stats` | System statistics |

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + stats |
| `/api/v1/add` | POST | Add memories (auto-extracts facts) |
| `/api/v1/search` | POST | Semantic search |
| `/api/v1/context` | POST | Formatted AI context |
| `/api/v1/entity/:name` | GET | Entity lookup |
| `/api/v1/graph` | GET | Knowledge graph |
| `/api/v1/entities` | GET | List all entities |
| `/api/v1/stats` | GET | Statistics |
| `/api/v1/decay` | POST | Trigger memory decay |

## Performance

```
Search latency:  0.3 - 0.8ms (in-memory, zero disk I/O)
Boot time:       < 1ms (loads all facts into RAM)
Memory usage:    ~3.6KB per fact
Extraction:      < 0.1ms per sentence (no AI, pure grammar)
```

## How It's Different

| | OpenMemory | SuperMemory | Mem0 |
|---|---|---|---|
| **Cost** | Free (local) | Paid API | Paid API |
| **Data** | 100% on your machine | Cloud | Cloud |
| **Extraction** | Grammar-based (no AI) | LLM-based | LLM-based |
| **Search** | BM25 + Vector + RRF | Vector only | Vector only |
| **Contradictions** | Auto-resolved | Manual | Manual |
| **Smart decay** | Exponential + access boost | Basic | Basic |
| **Speed** | Sub-millisecond | Network latency | Network latency |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Language**: TypeScript
- **Database**: SQLite (bun:sqlite)
- **API**: [Hono](https://hono.dev)
- **MCP**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Search**: BM25 + TF-IDF vectors + Reciprocal Rank Fusion

## Configuration

Create `~/.openmemory/.env`:

```env
# Optional: API key for REST server auth
OPENMEMORY_API_KEY=your-secret-key

# Optional: Use Claude for smarter extraction
OPENMEMORY_EXTRACTION_PROVIDER=local  # local | claude | ollama
ANTHROPIC_API_KEY=sk-ant-...          # only if using claude

# Server
PORT=3838
```

## Roadmap

- [ ] Web dashboard (knowledge graph visualization)
- [ ] SDK packages (npm, pip)
- [ ] Conversation stream listener (auto-extract from live chats)
- [ ] Import/export (JSON, Markdown)
- [ ] Multi-user support
- [ ] Ollama embeddings (upgrade from TF-IDF)

## Contributing

PRs welcome. The codebase is small (~1500 lines) and readable.

```bash
bun install
bun run dev        # REST API on :3838
bun run mcp        # MCP server
```

## License

MIT

---

<div align="center">

**One memory. Every AI tool. Zero cloud.**

Built by [Ranbir Singh](https://github.com/AndroidPoet)

</div>
