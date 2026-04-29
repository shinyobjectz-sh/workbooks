# Workbooks

A document format and runtime for **executable, portable analytical artifacts** —
notebooks, reports, dashboards, ML experiments, recurring monitors — all
expressed as a single canonical type: the **workbook**.

```
.workbook = an ordered tree of typed blocks + an embedded execution runtime
```

Render in a browser, run cells client-side via WASM, export as a single HTML
file that survives forever. No server, no kernel, no environment drift.

## What's in this repo

| Path | What |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | The format specification — block types, manifest schema, runtime tiers, wire protocols |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Lifecycle, persistence, observability, quotas |
| [`docs/RUST_RUNTIME.md`](docs/RUST_RUNTIME.md) | Rust/WASM execution architecture |
| [`packages/runtime/`](packages/runtime/) | `@workbook/runtime` — Svelte 5 UI runtime that renders the block tree |
| [`packages/runtime-wasm/`](packages/runtime-wasm/) | `workbook-runtime` Rust crate — WASM execution engine (DuckDB, Polars, Plotters, Candle) |
| [`proto/workbook/v1/`](proto/workbook/v1/) | Canonical Protobuf schema (typed manifest, blocks, cell I/O) |
| [`proto/workbook/runtime/v1/`](proto/workbook/runtime/v1/) | Runtime control plane (Connect-RPC) — same interface across browser, self-hosted, and managed tiers |

## Status

Early. The spec is stabilizing; the Rust runtime is scaffolding; the Svelte
runtime ships in production at [Signal](https://signal.ml). We're publishing
the format and reference implementations as Apache-2.0 so anyone can build
clients, exporters, or alternative runtimes.

## Quickstart (Svelte runtime)

```bash
pnpm add @workbook/runtime svelte
```

```svelte
<script>
  import { Workbook, defaultBlockRegistry } from "@workbook/runtime";

  const workbook = {
    manifest: { /* … */ },
    blocks: [
      { kind: "heading", level: 1, text: "Hello" },
      { kind: "paragraph", text: "This is a workbook." },
    ],
  };
</script>

<Workbook {workbook} registry={defaultBlockRegistry} />
```

See `docs/SPEC.md` for the full block catalog and manifest format.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome.

## License

[Apache-2.0](LICENSE) — Copyright 2026 Zaius Labs.
