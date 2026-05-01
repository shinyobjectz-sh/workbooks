/**
 * `wb.app()` — the persistent app-state primitive for Svelte 5 workbooks.
 *
 *   <script>
 *     const app = wb.app({
 *       count:    0,
 *       theme:    "dark",
 *       todos:    [] as Todo[],
 *       layout:   { chatWidth: 500 },
 *     });
 *   </script>
 *
 *   <button onclick={() => app.count++}>{app.count}</button>
 *   <input bind:value={app.theme} />
 *   {#each app.todos as todo}<li>{todo.text}</li>{/each}
 *
 * Backed by a single Y.Map under a stable root key. Each top-level
 * field is JSON-encoded into the map. Mutations propagate to Y.Doc
 * → substrate WAL → `.workbook.html` file. Reload restores the same
 * state.
 *
 * # Lazy by default
 *
 * The Proxy returned here defers Y.Doc binding to the first read or
 * write, so it's safe to call wb.app() at module load (e.g. in a
 * singleton like `export const layout = new LayoutStore()`) even when
 * the bundler flattens dynamic imports and the runtime mount hasn't
 * finished. By the time any component renders, the doc is bound.
 *
 * # Tradeoff vs SyncedStore
 *
 * Earlier drafts used SyncedStore for fine-grained nested CRDT (so a
 * concurrent edit to `app.todos[3].text` from two tabs would merge
 * cleanly per-character). SyncedStore disallows primitives at the
 * doc root and disallows seeded values in the root initializer,
 * which makes "just give me persistent app state from a plain object"
 * impossible without significant API contortion.
 *
 * This implementation trades that fine-grained nested merge for an
 * API that just works on plain JS shapes. Each top-level field is
 * JSON-encoded as a single Y.Map value:
 *
 *   - **primitives** (number, string, bool, null) → fully fine; LWW
 *     per field at the root level
 *   - **arrays / objects** → JSON-encoded; whole-value LWW per field
 *
 * For arrays of records that need per-element CRDT merge (e.g.
 * concurrent pushes from peers), pair `wb.app` with `wb.list<T>(id)`
 * for that one collection. For long strings with concurrent edits,
 * pair with `wb.text(id)`. Everything else is happy as a JSON value.
 */

import { resolveDocSync } from "../storage/bootstrap";
import { Y } from "@syncedstore/core";

export interface AppOptions {
  /** Doc id this app belongs to. Defaults to the first registered doc. */
  doc?: string;
  /** Override the root Y.Map key (default `__wb_app`). Useful if you
   *  want multiple independent wb.app() roots in one workbook. */
  rootKey?: string;
}

/**
 * Stable wire-format key. Renaming would invalidate every saved
 * workbook's wb.app state. Locked in v0.
 */
const DEFAULT_ROOT_KEY = "__wb_app";

export function app<T extends Record<string, any>>(
  shape: T,
  opts: AppOptions = {},
): T {
  let map: Y.Map<unknown> | null = null;
  let doc: Y.Doc | null = null;
  let reactor: Reactor | null = null;
  const rootKey = opts.rootKey ?? DEFAULT_ROOT_KEY;

  const ensure = () => {
    if (map) return;
    doc = resolveDocSync(opts.doc ?? null);
    if (!doc) {
      throw new Error(
        "wb.app() accessed before the workbook Y.Doc was bound. " +
        "Either wrap your component tree in <WorkbookReady>, or make " +
        "sure mountHtmlWorkbook(...) has run before any read/write.",
      );
    }
    map = doc.getMap(rootKey);

    // Seed defaults — only on keys that don't already exist (existing
    // user state always wins). Wrapped in transact so the seed lands
    // as one substrate op rather than N.
    doc.transact(() => {
      for (const [key, value] of Object.entries(shape)) {
        if (!map!.has(key) && value !== undefined) {
          map!.set(key, JSON.stringify(value));
        }
      }
    });

    reactor = new Reactor();
    map.observe(() => reactor!.bump());
  };

  /** Decode a Y.Map value to its JS form. JSON parse with graceful
   *  fallback so values written outside this SDK still work. */
  const read = (key: string): unknown => {
    const raw = map!.get(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  };

  /** Encode + write under one transact so observers fire once per write. */
  const write = (key: string, value: unknown): void => {
    doc!.transact(() => { map!.set(key, JSON.stringify(value)); });
  };

  return new Proxy({} as any, {
    get(_target, prop) {
      ensure();
      reactor!.read(); // register Svelte dependency
      if (typeof prop === "symbol") return undefined;
      return read(prop);
    },
    set(_target, prop, value) {
      ensure();
      if (typeof prop === "symbol") return false;
      write(prop, value);
      return true;
    },
    has(_target, prop) {
      ensure();
      if (typeof prop === "symbol") return false;
      return map!.has(prop);
    },
    deleteProperty(_target, prop) {
      ensure();
      if (typeof prop === "symbol") return false;
      doc!.transact(() => { map!.delete(prop); });
      return true;
    },
    ownKeys(_target) {
      ensure();
      reactor!.read();
      return [...map!.keys()];
    },
    getOwnPropertyDescriptor(_target, prop) {
      ensure();
      if (typeof prop === "symbol" || !map!.has(prop)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: read(prop),
      };
    },
  }) as T;
}

/**
 * Tiny class wrapping a single $state.raw counter. Class form is
 * required because $state.raw can only appear in class fields,
 * <script> blocks, or .svelte.{js,ts} files (this file qualifies).
 */
class Reactor {
  #version = $state.raw(0);

  read(): void {
    void this.#version;
  }

  bump(): void {
    this.#version++;
  }
}

/** Direct access to the underlying Y.Doc — useful for hooking
 *  Y.UndoManager outside the SDK's `undo()` helper, or for
 *  encoding state for an export. */
export function docOf<T>(_app: T, opts: AppOptions = {}): Y.Doc | null {
  return resolveDocSync(opts.doc ?? null);
}
