#!/usr/bin/env node
// Local dev server for the workbook-shell. Serves public/ over HTTP at
// :5174 so OPFS / launchQueue / install prompts work (these need a real
// origin, not file://).
//
// Run: node scripts/serve.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const PORT = process.env.PORT ? Number(process.env.PORT) : 5174;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url ?? "/").split("?")[0];
  if (path === "/" || path === "") path = "/index.html";
  if (path === "/launch") path = "/index.html"; // file_handlers action
  const file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const mime = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Service-Worker-Allowed": "/",
    "Cache-Control": "no-cache",
  });
  res.end(await readFile(file));
});

server.listen(PORT, () => {
  console.log(`workbook-shell dev: http://localhost:${PORT}/`);
  console.log("Install via Chrome's URL-bar 'Install Workbooks' button.");
});
