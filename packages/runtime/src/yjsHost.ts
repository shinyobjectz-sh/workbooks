/**
 * Yjs host shim — single source of Y.* for the runtime bundle.
 *
 * The host app (e.g. color.wave's main.js) imports `yjs` once and
 * assigns it to `globalThis.__wb_yjs` before the runtime bundle
 * loads. The runtime imports Yjs through this file instead of from
 * "yjs" directly, so both sides share ONE module instance.
 *
 * Why: when esbuild bundles `yjs` into the runtime AND Vite bundles
 * `yjs` into the host app, you get two copies. `instanceof Y.Doc`
 * fails across the boundary, and Yjs itself prints
 * "Yjs was already imported. This breaks constructor checks…"
 * (see https://github.com/yjs/yjs/issues/438).
 *
 * Each export is paired with a type alias of the same name so that
 * `import * as Y from "./yjsHost"` produces a namespace usable in
 * both value and type positions (`new Y.Doc()` and `d: Y.Doc`).
 */

import type * as YjsTypes from "yjs";

const _Y = (globalThis as unknown as { __wb_yjs?: typeof YjsTypes }).__wb_yjs;

if (!_Y) {
  throw new Error(
    "workbook runtime: globalThis.__wb_yjs is not set. The host app must " +
      "assign `globalThis.__wb_yjs = await import('yjs')` BEFORE loading " +
      "the workbook runtime bundle. See yjsHost.ts for context.",
  );
}

export const Doc = _Y.Doc;
export type Doc = YjsTypes.Doc;

export const Map = _Y.Map;
export type Map<T> = YjsTypes.Map<T>;

export const Array = _Y.Array;
export type Array<T> = YjsTypes.Array<T>;

export const Text = _Y.Text;
export type Text = YjsTypes.Text;

export const XmlElement = _Y.XmlElement;
export type XmlElement = YjsTypes.XmlElement;

export const XmlFragment = _Y.XmlFragment;
export type XmlFragment = YjsTypes.XmlFragment;

export const XmlText = _Y.XmlText;
export type XmlText = YjsTypes.XmlText;

export const encodeStateAsUpdate = _Y.encodeStateAsUpdate;
export const applyUpdate = _Y.applyUpdate;
export const encodeStateVector = _Y.encodeStateVector;
export const mergeUpdates = _Y.mergeUpdates;
export const diffUpdate = _Y.diffUpdate;
export const transact = _Y.transact;
