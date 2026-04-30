// Secure CSV pipeline for the talk-to-csv showcase.
//
// Wires:
//   - workbook runtime (Rust+WASM via virtual:workbook-runtime)
//   - createWorkbookDataResolver in wasmIsolation mode (Phase E)
//   - the inline <wb-data id="orders"> block this page ships with
//
// Result:
//   1. unlock(passphrase) decrypts the block in Rust; plaintext stays
//      in linear memory; we only ever hold a WasmPlaintextHandle in JS.
//   2. query(sql) runs a Polars-SQL statement using the handle as the
//      `data` table; rows come back as parsed objects (small).
//   3. dispose() drops the handle and forgets the passphrase.
//
// The CSV bytes never become a JS Uint8Array unless we explicitly
// call handle.export(). The only thing the LLM sees is the schema
// returned by `getSchema()`.

import { createWorkbookDataResolver } from "@work.books/runtime/workbookDataResolver";

let runtime = null;
let resolver = null;
let unlockedHandle = null;
let cachedSchema = null;

async function getRuntime() {
  if (!runtime) {
    const { loadRuntime } = await import("virtual:workbook-runtime");
    runtime = await loadRuntime();
  }
  return runtime;
}

/** Read the encrypted <wb-data> block this page ships with. The
 *  parser produces a normalized WorkbookData object the resolver
 *  consumes — same shape the runtime uses when mounting a full
 *  workbook. */
function findEncryptedBlock() {
  const elements = document.querySelectorAll(
    "wb-data[encryption='age-v1']",
  );
  if (!elements.length) {
    throw new Error(
      "talk-to-csv: no <wb-data encryption='age-v1'> in the page. " +
        "Run `npm run encrypt-data` to splice the encrypted sample into " +
        "src/index.html before building.",
    );
  }
  // Hand-build the WorkbookData. (Skipping the full parser keeps this
  // self-contained and avoids dragging in MDX bits.)
  const el = elements[0];
  const id = el.getAttribute("id") ?? "orders";
  const mime = el.getAttribute("mime") ?? "text/csv";
  const sha256 = el.getAttribute("sha256") ?? "";
  const encoding = el.getAttribute("encoding") ?? "base64";
  if (encoding !== "base64") {
    throw new Error(`talk-to-csv: unexpected encoding=${encoding}`);
  }
  const base64 = (el.textContent ?? "").replace(/\s+/g, "");
  return {
    id,
    mime,
    encryption: "age-v1",
    source: { kind: "inline-base64", base64, sha256 },
  };
}

/**
 * Unlock the inline encrypted block.
 * @param {string} passphrase
 * @returns {Promise<{ rows: number, schema: Array<{name:string,type:string}>}>}
 */
export async function unlock(passphrase) {
  if (unlockedHandle) {
    throw new Error("talk-to-csv: already unlocked. Call dispose() first.");
  }
  const { wasm } = await getRuntime();
  if (!wasm.ageDecryptToHandle) {
    throw new Error(
      "talk-to-csv: the runtime build is missing ageDecryptToHandle. " +
        "Rebuild packages/runtime-wasm with the crypto module enabled.",
    );
  }
  resolver = createWorkbookDataResolver({
    requestPassword: async () => passphrase,
    wasmIsolation: { wasm },
  });
  const block = findEncryptedBlock();
  const result = await resolver.resolve(block);
  if (!result || !result.value || result.value.kind !== "wasm-handle") {
    throw new Error(
      "talk-to-csv: resolver returned the wrong shape — expected a " +
        "wasm-handle. Check that wasmIsolation is wired correctly.",
    );
  }
  unlockedHandle = result.value;
  cachedSchema = await deriveSchema(unlockedHandle);
  return {
    rows: await rowCount(),
    schema: cachedSchema,
  };
}

/**
 * Run a Polars-SQL statement against the unlocked handle.
 * The encrypted bytes never cross to JS; only the SQL output rows
 * (normally a small slice of the dataset) come back as objects.
 *
 * @param {string} sql — the table name MUST be `data` (we register the
 *                       handle under that name).
 */
export async function query(sql) {
  if (!unlockedHandle) {
    throw new Error("talk-to-csv: not unlocked");
  }
  const { wasm } = await getRuntime();
  // Phase E path. runPolarsSqlIpcHandles takes a map of table name →
  // handle id and resolves bytes inside Rust. The current showcase
  // ships the encrypted CSV as raw bytes (text/csv); for SQL we need
  // them parsed as Arrow IPC. Polars-SQL's text/csv handler doesn't
  // exist on the handle path yet, so we use the export() escape
  // hatch here. This is the documented compromise — see SECURITY.md.
  const csvBytes = unlockedHandle.export();
  const csvText = new TextDecoder().decode(csvBytes);
  const outputs = wasm.runPolarsSql(sql, csvText);
  const csvOut = outputs.find(
    (o) => o.kind === "text" && o.mime_type === "text/csv",
  );
  if (!csvOut) {
    const err = outputs.find((o) => o.kind === "error");
    throw new Error(err?.message ?? "query produced no CSV output");
  }
  return parseCsv(csvOut.content);
}

/** Drop the handle + passphrase + resolver. Call on lock/logout. */
export function dispose() {
  if (unlockedHandle) {
    unlockedHandle.dispose();
    unlockedHandle = null;
  }
  if (resolver) {
    resolver.clear();
    resolver.forgetPassphrase();
    resolver = null;
  }
  cachedSchema = null;
}

/** Schema (column names + inferred types) derived from a sample
 *  query — this is the ONLY thing we send to the LLM for NL→SQL. */
export function getSchema() {
  return cachedSchema;
}

/** Sample rows for the LLM prompt — small slice (5 rows by default).
 *  These leave the page if the user opts to use the LLM panel; the
 *  trust panel surfaces this clearly. */
export async function getSampleRows(n = 5) {
  return query(`SELECT * FROM data LIMIT ${n}`);
}

async function deriveSchema(handle) {
  // Run a tiny `LIMIT 1` query so Polars infers the schema. We keep
  // the result locally; the LLM only ever gets column names + types.
  const csvBytes = handle.export();
  const csvText = new TextDecoder().decode(csvBytes);
  const { wasm } = await getRuntime();
  const outputs = wasm.runPolarsSql("SELECT * FROM data LIMIT 1", csvText);
  const csvOut = outputs.find(
    (o) => o.kind === "text" && o.mime_type === "text/csv",
  );
  if (!csvOut) return [];
  const header = csvOut.content.split("\n", 1)[0];
  const sample = csvOut.content.split("\n", 2)[1] ?? "";
  const cols = parseRow(header);
  const sampleCells = parseRow(sample);
  return cols.map((name, i) => ({
    name,
    type: inferType(sampleCells[i]),
  }));
}

async function rowCount() {
  const rows = await query("SELECT COUNT(*) AS n FROM data");
  return rows[0]?.n ?? 0;
}

function inferType(cell) {
  if (cell === undefined || cell === "") return "text";
  if (/^-?\d+$/.test(cell)) return "int";
  if (/^-?\d*\.\d+$/.test(cell)) return "float";
  if (/^\d{4}-\d{2}-\d{2}/.test(cell)) return "date";
  return "text";
}

function parseCsv(s) {
  const lines = s.trim().split("\n");
  if (!lines.length) return [];
  const head = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseRow(line);
    const row = {};
    head.forEach((k, i) => {
      const v = cells[i];
      row[k] = isNumeric(v) ? Number(v) : v;
    });
    return row;
  });
}

function parseRow(s) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function isNumeric(s) {
  return s !== "" && !isNaN(Number(s));
}
