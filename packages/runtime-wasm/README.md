# workbook-runtime (Rust)

Rust execution runtime for workbooks — compiled to WebAssembly and
shipped as the workbook's client-side compute layer.

## What it does

A workbook page loads two bundles:

1. **`@workbook/runtime`** (Svelte UI, ~250 KB) — renders blocks, mounts the document
2. **`workbook-runtime`** (this crate, see "Bundle sizes" below) — executes cells

The WASM bundle dispatches cell execution by language:

| Cell language | Backend | Default? | Phase |
|---|---|---|---|
| `rhai` | Rhai engine | yes | P2.2 (eval works today) |
| `chart` | Plotters | yes | P2.3 |
| `polars` | Polars LazyFrame + SQL | feature `polars-frames` | P2.5 |
| `sqlite` | rusqlite (bundled) | feature `sqlite` | P2.5 |
| `duckdb` | DuckDB-WASM (lazy chunk) | feature `duckdb` | P3+ |
| `candle-inference` | Candle | feature `candle` | P4.1 |
| `linfa-train` | Linfa | feature `linfa` | P4.4 |
| `wasm-fn` | Curated function registry | — | P7 |

Polars covers most analytical (OLAP) workloads via lazy execution + a SQL
frontend, at a fraction of DuckDB's bundle size. SQLite covers small
structured state. Workbooks that need DuckDB-specific features opt in
via the `duckdb` feature; the chunk is lazy-loaded on first use.

## Build

From `packages/runtime-wasm/`:

```bash
wasm-pack build --target web --release
# output: pkg/workbook_runtime.{js,wasm,d.ts} + package.json
```

`wasm-opt -Oz` + brotli compression run automatically.

### Build matrix

| Features | wasm raw | gzip | brotli | Notes |
|---|---:|---:|---:|---|
| `default` (charts + rhai-glue) | 1.1 MB | 357 KB | **274 KB** | Baseline; usable today |
| `default + sqlite` | TBD | TBD | TBD | Bundled SQLite C source |
| `default + polars-frames` | TBD | TBD | TBD | Lazy frames + CSV/JSON/SQL |
| `default + duckdb` | TBD | TBD | TBD | Bundled DuckDB C++ — 10–15 MB target |

Numbers above are P2.2 baseline. Polars + SQLite + DuckDB additions need
a wasm32 C toolchain (`clang --target=wasm32-wasi`); they compile with
default features off until that's set up. See `docs/RUST_RUNTIME.md`.

## Tree-shaking

Each cell language is a Cargo feature. Workbooks declare the slices they
need in `manifest.runtime.features`; bundles built for those workbooks
only include the requested features. See `Cargo.toml > [features]`.

## Demo (smoke test)

```bash
wasm-pack build --target web --release
python3 -m http.server 8000
# open http://localhost:8000/examples/hello-cell/
```

The hello-cell example loads the WASM, calls `runRhai("40 + 2")`, and
displays the output.

## Architecture

```
+------------------+     wasm-bindgen     +-------------------+
| Svelte UI        |--------------------->| workbook-runtime  |
| (Workbook.svelte)|                      |  (this crate)     |
+------------------+                      +-------------------+
                                                    |
                                                    v
                          +-----------------------------+
                          | Polars  Rhai   Plotters     |
                          | SQLite  DuckDB Candle/Linfa |
                          +-----------------------------+
```

## Reference

- `../../proto/workbook/runtime/v1/runtime.proto` — Connect-RPC service contract
- `../../proto/workbook/v1/workbook.proto` — Workbook + Cell types
- `../../docs/SPEC.md` — full spec
- `../../docs/RUST_RUNTIME.md` — pivot rationale + tool migration map
