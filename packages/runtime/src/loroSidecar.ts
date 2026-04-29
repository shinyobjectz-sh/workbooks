/**
 * Loro CRDT sidecar — lazy-loaded around `loro-crdt` (Rust+WASM).
 *
 * `<wb-doc format="loro">` blocks resolve through this dispatcher:
 * decoded base64 bytes → `LoroDoc.import()` → JSON projection
 * available to cells via `reads=`. First ship is read-only;
 * mutation API (mirror of appendMemory's host-driven shape) lands
 * in a follow-up.
 *
 * Why lazy-load: Loro's WASM binary is ~3 MB, 6× the SQLite baseline.
 * Workbooks that don't use <wb-doc> never pay the cost. Same pattern
 * as @sqlite.org/sqlite-wasm — declared as an optional peer dep, the
 * dispatcher surfaces a clear error if the package is missing.
 */

/** Subset of the loro-crdt JS API we depend on. */
interface LoroDoc {
  import(bytes: Uint8Array): void;
  toJSON(): unknown;
  /** Export the current state as bytes for re-saving. */
  export(mode: { mode: "snapshot" } | { mode: "shallow-snapshot"; frontiers: unknown } | { mode: "updates"; from: unknown }): Uint8Array;
}
interface LoroModule {
  LoroDoc: new () => LoroDoc;
}

let loroPromise: Promise<LoroModule> | null = null;

async function loadLoro(): Promise<LoroModule> {
  if (!loroPromise) {
    loroPromise = (async () => {
      // Dynamic import via variable specifier so TS doesn't try to
      // resolve the optional peer dep at compile time.
      const specifier = "loro-crdt";
      let mod: LoroModule;
      try {
        mod = (await import(/* @vite-ignore */ specifier)) as unknown as LoroModule;
      } catch {
        throw new Error(
          "wb-doc cells require loro-crdt — install it as a peer dep " +
            "or pre-bundle it with your workbook host",
        );
      }
      return mod;
    })();
  }
  return loroPromise;
}

export interface LoroDocHandle {
  /** Current state as a plain JS value (for cell consumption). */
  toJSON(): unknown;
  /** Export current state as Loro snapshot bytes for re-saving. */
  exportSnapshot(): Uint8Array;
  /** Internal handle — exposed for the future mutation API. */
  inner(): LoroDoc;
}

export interface LoroDispatcher {
  /**
   * Load a doc from snapshot bytes. Same id loaded twice (e.g. across
   * remounts) returns the cached handle unless `force` is set.
   */
  load(opts: {
    id: string;
    bytes: Uint8Array;
    force?: boolean;
  }): Promise<LoroDocHandle>;
  /** Get an already-loaded handle by id. */
  get(id: string): LoroDocHandle | undefined;
  /** Drop every cached handle. Call on unmount. */
  dispose(): void;
}

export function createLoroDispatcher(): LoroDispatcher {
  const handles = new Map<string, LoroDocHandle>();

  function wrapHandle(doc: LoroDoc): LoroDocHandle {
    return {
      toJSON: () => doc.toJSON(),
      exportSnapshot: () => doc.export({ mode: "snapshot" }),
      inner: () => doc,
    };
  }

  return {
    async load({ id, bytes, force }) {
      const existing = handles.get(id);
      if (existing && !force) return existing;
      const loro = await loadLoro();
      const doc = new loro.LoroDoc();
      doc.import(bytes);
      const handle = wrapHandle(doc);
      handles.set(id, handle);
      return handle;
    },
    get(id) {
      return handles.get(id);
    },
    dispose() {
      handles.clear();
    },
  };
}
