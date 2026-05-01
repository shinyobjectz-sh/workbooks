/**
 * Yjs CRDT sidecar — wraps `yjs` (pure JS, no WASM) for `<wb-doc>`
 * blocks declared with `format="yjs"`.
 *
 * The shape mirrors the previous loroSidecar so callers (resolver,
 * runtime client, autosave, SDK bootstrap) remain mostly unchanged:
 * each sidecar exposes a `LoroDocHandle`-like wrapper around a Y.Doc.
 *
 * Why Yjs as the new default:
 *   - tiny vs Loro's WASM (~3 MB) — pure JS, ~50 KB minified,
 *   - first-class y-indexeddb provider (no hand-rolled IDB layer),
 *   - mature broadcast/websocket/webrtc providers if/when sync lands.
 *
 * Update format: bytes coming in are produced by `Y.encodeStateAsUpdate(doc)`;
 * applied via `Y.applyUpdate(doc, bytes)`. Empty bytes = a fresh Y.Doc.
 */

import * as Y from "yjs";
import type { LoroDocHandle, DocOp, LoroPath } from "./loroSidecar";

export interface YjsDispatcher {
  /**
   * Load a doc from update bytes (Y.encodeStateAsUpdate output). Same
   * id loaded twice returns the cached handle unless `force` is set.
   * Bytes of length 0 produce a fresh empty Y.Doc.
   */
  load(opts: { id: string; bytes: Uint8Array; force?: boolean }): Promise<LoroDocHandle>;
  /** Get an already-loaded handle by id. */
  get(id: string): LoroDocHandle | undefined;
  /** Drop every cached handle. Call on unmount. */
  dispose(): void;
}

function walkPath(doc: Y.Doc, path: LoroPath): unknown {
  let cur: unknown;
  if (path.root.kind === "map") cur = doc.getMap(path.root.name);
  else if (path.root.kind === "list") cur = doc.getArray(path.root.name);
  else cur = doc.getText(path.root.name);

  const steps = path.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "map") {
      const m = cur as Y.Map<unknown>;
      cur = m.get(step.key);
    } else {
      const l = cur as Y.Array<unknown>;
      cur = l.get(step.index);
    }
    if (cur === null || typeof cur !== "object") {
      throw new Error(
        `docMutate: path step ${i} yielded a primitive — can't descend further`,
      );
    }
  }
  return cur;
}

function applyOp(doc: Y.Doc, op: DocOp): void {
  doc.transact(() => {
    const target = walkPath(doc, op.target);
    switch (op.kind) {
      case "map_set":
        (target as Y.Map<unknown>).set(op.key, op.value);
        return;
      case "map_delete":
        (target as Y.Map<unknown>).delete(op.key);
        return;
      case "list_push":
        (target as Y.Array<unknown>).push([op.value]);
        return;
      case "list_insert":
        (target as Y.Array<unknown>).insert(op.index, [op.value]);
        return;
      case "list_delete":
        (target as Y.Array<unknown>).delete(op.index, op.count);
        return;
      case "text_insert":
        (target as Y.Text).insert(op.index, op.text);
        return;
      case "text_delete":
        (target as Y.Text).delete(op.index, op.count);
        return;
    }
  });
}

function wrapHandle(doc: Y.Doc): LoroDocHandle & { doc: Y.Doc } {
  return {
    toJSON: () => doc.toJSON(),
    exportSnapshot: () => Y.encodeStateAsUpdate(doc),
    mutate(ops) {
      for (const op of ops) applyOp(doc, op);
      return Y.encodeStateAsUpdate(doc);
    },
    inner: () => doc as unknown as never,
    // Surface the Y.Doc directly so the SDK bootstrap can pick it up
    // without going through the legacy `inner()` LoroDoc cast.
    doc,
  };
}

export function createYjsDispatcher(): YjsDispatcher {
  const handles = new Map<string, LoroDocHandle & { doc: Y.Doc }>();

  return {
    async load({ id, bytes, force }) {
      const existing = handles.get(id);
      if (existing && !force) return existing;
      const doc = new Y.Doc();
      if (bytes && bytes.length > 0) {
        Y.applyUpdate(doc, bytes);
      }
      const handle = wrapHandle(doc);
      handles.set(id, handle);
      return handle;
    },
    get(id) {
      return handles.get(id);
    },
    dispose() {
      for (const h of handles.values()) {
        try { h.doc.destroy(); } catch { /* ignore */ }
      }
      handles.clear();
    },
  };
}
