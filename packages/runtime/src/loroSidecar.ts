/**
 * Doc handle types — backend-agnostic shape consumed by the runtime
 * client, the doc resolver, and the autosave layer.
 *
 * History note: this module used to dynamically load `loro-crdt` and
 * implement a Loro-backed dispatcher. Phase 2 of core-0or migrated the
 * default backend to Yjs (see `yjsSidecar.ts`). The TYPES live on here
 * because the rest of the runtime (wasmBridge, workbookDocResolver,
 * SDK code) depends on the names — we kept the exported names stable
 * to avoid a sweeping rename.
 *
 * The runtime no longer dispatches Loro at all; the dispatcher
 * factory below is a thin throwing stub kept for source compatibility
 * with any consumer that still calls `createLoroDispatcher()`.
 * `format="loro"` workbooks fall through to the legacy IDB port
 * (color.wave's legacyLoroPort.js), which lazy-imports `loro-crdt`
 * outside the framework bundle.
 */

/**
 * One step in a path through nested containers. Each step navigates
 * Map.get(key) or List.get(index); the value at each step must be
 * another container (Map / List / Text) for the walk to continue.
 */
export type LoroPathStep =
  | { kind: "map"; key: string }
  | { kind: "list"; index: number };

/**
 * Path from doc root to a target container. `root` declares the
 * top-level container's kind + name. `steps` descend through nested
 * containers; an empty / omitted `steps` means the root is itself
 * the target.
 */
export interface LoroPath {
  root: { kind: "map" | "list" | "text"; name: string };
  steps?: LoroPathStep[];
}

/**
 * Structured op patch for container mutations. Cells + agent tools
 * emit these via the host's docMutate API; the active backend (Yjs)
 * walks the path, applies the op on the target container, and
 * commits a single op-log entry per call.
 *
 * Each op's kind asserts the FINAL container's type — `map_set`
 * requires the path to resolve to a Map, `list_push` to a List,
 * etc. Mismatch surfaces as a runtime error.
 */
export type DocOp =
  | { kind: "map_set"; target: LoroPath; key: string; value: unknown }
  | { kind: "map_delete"; target: LoroPath; key: string }
  | { kind: "list_push"; target: LoroPath; value: unknown }
  | { kind: "list_insert"; target: LoroPath; index: number; value: unknown }
  | { kind: "list_delete"; target: LoroPath; index: number; count: number }
  | { kind: "text_insert"; target: LoroPath; index: number; text: string }
  | { kind: "text_delete"; target: LoroPath; index: number; count: number };

/**
 * Convenience constructor for the common case: a top-level container
 * with no nested descent. `topLevel("map", "agentState")` is shorthand
 * for `{ root: { kind: "map", name: "agentState" } }`.
 */
export function topLevel(
  kind: "map" | "list" | "text",
  name: string,
): LoroPath {
  return { root: { kind, name } };
}

/**
 * Backend-agnostic CRDT doc handle. Both the Yjs sidecar (default,
 * Phase 2+) and any future legacy/Loro fallback wrap their doc with
 * this shape. `inner()` returns the backend's native doc instance
 * (Y.Doc today).
 */
export interface LoroDocHandle {
  /** Current state as a plain JS value (for cell consumption). */
  toJSON(): unknown;
  /** Export current state as backend-specific update bytes for save. */
  exportSnapshot(): Uint8Array;
  /**
   * Apply one or more structured ops as a single op-log entry.
   * Returns the new snapshot bytes after commit so the host can
   * re-encode and persist.
   */
  mutate(ops: DocOp[]): Uint8Array;
  /** Internal handle — exposed for advanced host integrations. */
  inner(): unknown;
}

export interface LoroDispatcher {
  load(opts: { id: string; bytes: Uint8Array; force?: boolean }): Promise<LoroDocHandle>;
  get(id: string): LoroDocHandle | undefined;
  dispose(): void;
}

/**
 * @deprecated Phase 2 dropped the Loro backend; `format="loro"` is
 * routed through color.wave's legacy IDB port. New workbooks must use
 * `format="yjs"`. This factory throws on use to surface the migration.
 */
export function createLoroDispatcher(): LoroDispatcher {
  return {
    async load() {
      throw new Error(
        "loro-crdt is no longer bundled with the runtime. Author new " +
        "<wb-doc> elements with format=\"yjs\". Existing Loro snapshots " +
        "in IndexedDB are ported on first boot via the host's " +
        "legacyLoroPort module.",
      );
    },
    get() { return undefined; },
    dispose() { /* no-op */ },
  };
}
