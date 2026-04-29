/**
 * DuckDB sidecar (P3.1).
 *
 * Workbooks that explicitly need DuckDB-specific SQL features (advanced
 * window funcs, Iceberg / Delta / Postgres scanners, full DuckDB SQL
 * dialect) opt in via `cell.language === "duckdb"`. Most analytical
 * workbooks should use `polars` instead — Polars's lazy SQL frontend
 * covers ~90% of OLAP needs at <2 MB compressed instead of ~7 MB.
 *
 * The DuckDB engine is lazy-loaded the first time a duckdb cell runs;
 * workbooks that don't reference it never download the chunk. After
 * the first load the AsyncDuckDB instance is reused — `query()` opens
 * a connection per call and closes it eagerly.
 *
 * Implementation notes:
 *   - Uses @duckdb/duckdb-wasm's "JsDelivr" bundle selector to pick the
 *     right wasm binary for the current browser (mvp / eh / coi).
 *   - Seeded data: cell.params.csv → registers a `data` table, matching
 *     the convention used by runPolarsSql so users can test queries the
 *     same way.
 *   - Output: Arrow table → CSV string → CellOutput.text(mime=text/csv).
 *     Same shape as the Polars output so the demo's csvToTable() works
 *     unchanged.
 */

import type { CellOutput } from "./wasmBridge";

// Minimal type surface for @duckdb/duckdb-wasm — we type-cast at the
// boundary so consumers don't need to install the package's types if
// they don't use duckdb cells.
interface DuckDBModule {
  getJsDelivrBundles: () => unknown;
  selectBundle: (bundles: unknown) => Promise<{
    mainModule: string;
    mainWorker: string;
    pthreadWorker: string | null;
  }>;
  ConsoleLogger: new () => unknown;
  AsyncDuckDB: new (logger: unknown, worker: Worker) => {
    instantiate: (mainModule: string, pthreadWorker: string | null) => Promise<void>;
    connect: () => Promise<{
      query: (sql: string) => Promise<{ toArray: () => unknown[]; schema: { fields: { name: string }[] } }>;
      insertCSVFromPath?: (path: string, opts: unknown) => Promise<void>;
      close: () => Promise<void>;
    }>;
    registerFileText?: (name: string, content: string) => Promise<void>;
  };
}

let duckdbPromise: Promise<{
  db: Awaited<ReturnType<DuckDBModule["AsyncDuckDB"]["prototype"]["connect"]>> extends infer T
    ? unknown
    : unknown;
}> | null = null;

let dbInstance: InstanceType<DuckDBModule["AsyncDuckDB"]> | null = null;

async function ensureDuckdb(): Promise<InstanceType<DuckDBModule["AsyncDuckDB"]>> {
  if (dbInstance) return dbInstance;
  if (duckdbPromise) return (await duckdbPromise) as InstanceType<DuckDBModule["AsyncDuckDB"]>;

  duckdbPromise = (async () => {
    // Dynamic import — only fetched the first time a duckdb cell runs.
    const duckdb = (await import(
      /* @vite-ignore */ "@duckdb/duckdb-wasm"
    )) as unknown as DuckDBModule;

    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);

    const workerScript = `importScripts("${bundle.mainWorker}");`;
    const workerUrl = URL.createObjectURL(
      new Blob([workerScript], { type: "application/javascript" }),
    );
    const worker = new Worker(workerUrl);

    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    dbInstance = db;
    return { db };
  })();

  await duckdbPromise;
  if (!dbInstance) throw new Error("duckdb instance not initialized");
  return dbInstance;
}

/**
 * Run a DuckDB SQL cell. Mirrors the runPolarsSql shape so cells can move
 * between engines without changing their `params.csv` plumbing.
 */
export async function runDuckdbSql(sql: string, csv: string): Promise<CellOutput[]> {
  const db = await ensureDuckdb();

  // Register the seed CSV as table `data` if a CSV was provided.
  if (csv && (db as { registerFileText?: unknown }).registerFileText) {
    await (db as unknown as {
      registerFileText: (n: string, c: string) => Promise<void>;
    }).registerFileText("data.csv", csv);
  }

  const conn = await db.connect();
  try {
    if (csv) {
      try {
        // DuckDB-WASM's auto-detect CSV reader.
        await conn.query(
          "CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv_auto('data.csv', HEADER=TRUE)",
        );
      } catch (err) {
        return [{
          kind: "error",
          message: `duckdb csv load: ${err instanceof Error ? err.message : String(err)}`,
        }];
      }
    }

    const result = await conn.query(sql);
    const rows = result.toArray();
    const headers = result.schema.fields.map((f) => f.name);

    const csvOut = renderCsv(headers, rows);
    return [{
      kind: "text",
      content: csvOut,
      mime_type: "text/csv",
    }];
  } catch (err) {
    return [{
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }];
  } finally {
    await conn.close();
  }
}

function renderCsv(headers: string[], rows: unknown[]): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsv).join(","));
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    lines.push(headers.map((h) => escapeCsv(formatCell(r[h]))).join(","));
  }
  return lines.join("\n") + "\n";
}

function formatCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function escapeCsv(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
