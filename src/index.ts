#!/usr/bin/env bun
// OpenMemory — Universal AI Memory Engine

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/index.js";
import { createApi } from "./api/index.js";
import { startMcpServer } from "./mcp/index.js";

const config = loadConfig();
const command = process.argv[2];

if (command === "mcp") {
  const db = getDb(config);
  await startMcpServer(db, config);
} else {
  const db = getDb(config);
  const { app } = createApi(db, config);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`
  ┌──────────────────────────────────────┐
  │          OpenMemory v0.1.0           │
  │     Universal AI Memory Engine       │
  ├──────────────────────────────────────┤
  │  API:  http://localhost:${info.port}        │
  └──────────────────────────────────────┘
    `);
  });

  process.on("SIGINT", () => { closeDb(); process.exit(0); });
}
