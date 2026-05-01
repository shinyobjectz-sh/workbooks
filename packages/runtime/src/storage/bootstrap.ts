/**
 * Internal Yjs doc bootstrap for the wb.* storage SDK.
 *
 * Resolves a raw `Y.Doc` registered by the workbook runtime via the
 * `<wb-doc id="..." format="yjs">` element. Authors don't see this —
 * they interact with `wb.text`, `wb.collection`, `wb.value`. The
 * bootstrap is what keeps those primitives framework-agnostic: each
 * primitive awaits a doc handle here, then operates on it through
 * Yjs's container APIs (Y.Text / Y.Array / Y.Map).
 *
 * Design rule: every mutation MUST run inside `doc.transact(() => …)`
 * so it lands as one logical step. Yjs emits `updateV2` events
 * automatically at the end of each transaction; the host's autosave
 * layer (substrate's bindYjsAutoEmit, in colorwave's case) listens
 * on those events and persists. The SDK never reaches past the doc
 * to schedule its own persistence.
 *
 * Default doc id: when an author calls `wb.text("composition")` without
 * specifying a doc, the caller must register at least one `<wb-doc>`
 * AND pass an explicit doc id, OR the runtime must expose
 * `__wbRuntime.listDocIds`. Single-doc workbooks (today's common case)
 * register one doc; the SDK probes a small set of conventional ids
 * before failing. Multi-doc workbooks pass `{ doc: "explicit-id" }`.
 *
 * Phase 2 swap: this file used to expose Loro types (LoroDoc,
 * LoroText, LoroList, LoroMap). The runtime now hosts yjs docs (the
 * substrate work needs Yjs's incremental update format), so we
 * re-export Y.Text-shaped / Y.Array-shaped / Y.Map-shaped interfaces
 * that the storage primitives consume.
 */

// Type-only mirror of the yjs API surface we depend on. We don't
// import yjs directly here — the host loads it via __wb_yjs and the
// runtime hands us a raw Y.Doc through __wbRuntime.getDocHandle.
//
// These interfaces describe the duck-typed shape the storage layer
// uses. They're a strict subset of yjs's real types; any extra Yjs
// methods are still callable at runtime via the cast in resolveDoc.

export interface YObserver {
  (ev: unknown, transaction?: unknown): void;
}
export interface YText {
  insert(index: number, text: string): void;
  delete(index: number, length: number): void;
  toString(): string;
  observe(cb: YObserver): void;
  unobserve?(cb: YObserver): void;
}
export interface YArray {
  push(items: unknown[]): void;
  insert(index: number, items: unknown[]): void;
  delete(index: number, length: number): void;
  get(index: number): unknown;
  toArray(): unknown[];
  readonly length: number;
  observe(cb: YObserver): void;
}
export interface YMap {
  set(key: string, value: unknown): void;
  delete(key: string): void;
  get(key: string): unknown;
  has(key: string): boolean;
  observe(cb: YObserver): void;
}

/** The yjs Doc methods we touch. The "any" inside transact comes
 *  from yjs's own typing — we keep it generic so consumers can
 *  return values from atomic blocks. */
export interface YDoc {
  getText(name: string): YText;
  getArray(name: string): YArray;
  getMap(name: string): YMap;
  transact<T>(fn: () => T, origin?: unknown): T;
  on(event: "updateV2" | "update" | "afterTransaction", cb: (...args: unknown[]) => void): void;
  off(event: "updateV2" | "update" | "afterTransaction", cb: (...args: unknown[]) => void): void;
}

interface YDocHandle {
  /** The wrapped Y.Doc. Yjs handles also expose `.doc` directly,
   *  matching the Loro shape of `.inner()` returning the engine's
   *  native doc type. */
  inner?(): YDoc;
  doc?: YDoc;
}
interface RuntimeApi {
  getDocHandle?: (id: string) => YDocHandle | undefined;
  /** Optional — runtime may expose registered ids; not relied on. */
  listDocIds?: () => string[];
}

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

// Cache resolved docs by id so repeated wb.text("composition") calls
// from across the codebase share one Y.Doc reference.
const docCache = new Map<string, Promise<YDoc>>();

function getRuntime(): RuntimeApi | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { __wbRuntime?: RuntimeApi };
  return w.__wbRuntime ?? null;
}

/** Try to find any already-registered doc id via runtime introspection.
 *  Returns the first id, or null if listDocIds isn't exposed. */
function findFirstDocId(rt: RuntimeApi): string | null {
  if (typeof rt.listDocIds === "function") {
    try {
      const ids = rt.listDocIds();
      if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === "string") {
        return ids[0];
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** Pull the raw Y.Doc out of a runtime handle. Yjs sidecar wraps it
 *  the same way Loro does — `.inner()` is the canonical accessor —
 *  but we accept `.doc` too because color.wave's substrate backend
 *  also peeks at `handle.doc` directly. */
function unwrap(handle: YDocHandle | undefined): YDoc | null {
  if (!handle) return null;
  if (typeof handle.inner === "function") {
    try {
      const inner = handle.inner();
      if (inner) return inner;
    } catch { /* fall through */ }
  }
  if (handle.doc) return handle.doc;
  return null;
}

/**
 * Resolve a `Y.Doc` for the given doc id. Pass `null` to resolve
 * "the default doc" — the first one registered by the runtime
 * (introspected via listDocIds when available).
 *
 * Idempotent — once resolved, subsequent calls reuse the cached doc.
 * Polls `window.__wbRuntime.getDocHandle` so callers that fire BEFORE
 * `mountHtmlWorkbook` finishes don't drop their requests on the floor.
 */
export function resolveDoc(docId: string | null = null): Promise<YDoc> {
  const cacheKey = docId ?? "__default__";
  const cached = docCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const rt = getRuntime();
      if (rt && typeof rt.getDocHandle === "function") {
        const id = docId ?? findFirstDocId(rt);
        if (id != null) {
          const handle = rt.getDocHandle(id);
          const doc = unwrap(handle);
          if (doc) return doc;
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    docCache.delete(cacheKey);
    throw new Error(
      `wb.* storage: timed out (${POLL_TIMEOUT_MS}ms) waiting for ` +
      `<wb-doc${docId ? ` id="${docId}"` : ""}> to register. Make sure ` +
      `your HTML contains a <wb-workbook><wb-doc format="yjs" /></wb-workbook> ` +
      `and that mountHtmlWorkbook(...) has been called.`,
    );
  })();

  promise.catch(() => { docCache.delete(cacheKey); });
  docCache.set(cacheKey, promise);
  return promise;
}

/**
 * Test-only: synchronously inject a doc handle. Used by unit tests
 * that don't run the full mount path.
 */
export function __setTestDoc(id: string | null, doc: YDoc): void {
  const cacheKey = id ?? "__default__";
  docCache.set(cacheKey, Promise.resolve(doc));
}

/** Test-only: clear the doc cache. */
export function __clearTestDocs(): void {
  docCache.clear();
}
