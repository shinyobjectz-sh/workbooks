// Cryptographic edit-log backed by the Prolly Tree primitive.
//
// Every meaningful edit (composition save, asset add/remove, agent
// turn finished) commits a (key, value) into a content-addressed
// Merkle commit chain. The chain serializes to a single byte blob
// that round-trips through IDB.
//
// What's recorded
// ---------------
//   key                       value                         message
//   ─────────────────────     ──────────────────────────    ─────────────────
//   "composition"             current html                  composition save (N chars)
//   "asset:<id>"              JSON of the asset entry       add asset <name>
//   "asset:<id>" (deleted)    null marker                   remove asset <id>
//   "turn:<turn_id>"          JSON of the turn              <role> turn (N segs)
//
// Everything since the last commit is one chunk; the parent pointer
// chains commits, sha256 verifies integrity. Reload-detect on the
// IDB key, or full reset via prollyInit.
//
// What this primitive unlocks (future, not built yet)
// ---------------------------------------------------
//   - "show me what I changed in the last hour" via prollyLog
//   - "checkout previous composition state" via prollyCheckout
//   - tamper-evident audit when sharing a workbook (the head-sha256
//     attribute on <wb-history> in the exported zip is the proof)
//
// We don't ship UI for these yet; the wiring captures the events so
// the data is there when a History panel lands.

import { loadState, saveState } from "./persistence.svelte.js";
import { loadRuntime } from "virtual:workbook-runtime";

const HISTORY_KEY = "history.prolly";
const INIT_MESSAGE = "hyperframes session start";

let _wasmPromise = null;
let _bytesPromise = null;

async function getWasm() {
  if (!_wasmPromise) {
    _wasmPromise = loadRuntime().then((r) => r.wasm);
  }
  return _wasmPromise;
}

/** Lazy bootstrap: load saved bytes from IDB, or call prollyInit
 *  to create a fresh chain. Subsequent calls reuse the same promise.
 *  Returns the current serialized history bytes. */
async function ensureBytes() {
  if (!_bytesPromise) {
    _bytesPromise = (async () => {
      const wasm = await getWasm();
      if (!wasm.prollyInit) {
        throw new Error("history: runtime build missing prolly* bindings");
      }
      const saved = await loadState(HISTORY_KEY);
      if (saved instanceof Uint8Array && saved.byteLength > 0) {
        // Validate by reading HEAD — if corrupted, fall back to fresh.
        try {
          wasm.prollyHead(saved);
          return saved;
        } catch (e) {
          console.warn("history: stored Prolly blob unreadable, starting fresh:", e?.message ?? e);
        }
      }
      return wasm.prollyInit(INIT_MESSAGE);
    })();
  }
  return _bytesPromise;
}

/** Record one logical edit. Commits a (key, value) pair to the chain
 *  with the given human-readable message. value can be a string or a
 *  plain object (objects get JSON.stringified). Returns the new HEAD
 *  hash, or null on error (errors are non-fatal — the app continues). */
export async function recordEdit(key, value, message) {
  let wasm;
  try {
    wasm = await getWasm();
  } catch (e) {
    // Runtime not loadable — silently skip history without breaking
    // the calling code's main path.
    return null;
  }
  if (!wasm.prollySet) return null;
  try {
    const valueStr = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const valueBytes = new TextEncoder().encode(valueStr);
    const current = await ensureBytes();
    const next = wasm.prollySet(current, key, valueBytes, message);
    _bytesPromise = Promise.resolve(next);
    saveState(HISTORY_KEY, next);
    return wasm.prollyHead(next);
  } catch (e) {
    console.warn("history: recordEdit failed:", e?.message ?? e);
    return null;
  }
}

/** Record a key removal. Same shape as recordEdit but commits a
 *  delete instead of a set. */
export async function recordDelete(key, message) {
  let wasm;
  try { wasm = await getWasm(); } catch { return null; }
  if (!wasm.prollyDelete) return null;
  try {
    const current = await ensureBytes();
    const next = wasm.prollyDelete(current, key, message);
    _bytesPromise = Promise.resolve(next);
    saveState(HISTORY_KEY, next);
    return wasm.prollyHead(next);
  } catch (e) {
    console.warn("history: recordDelete failed:", e?.message ?? e);
    return null;
  }
}

/** Walk the parent chain from HEAD. Returns CommitInfo[] in newest-
 *  first order — same shape the runtime's prollyLog binding produces.
 *  Empty array if the chain isn't bootstrapped yet. */
export async function readLog() {
  let wasm;
  try { wasm = await getWasm(); } catch { return []; }
  if (!wasm.prollyLog) return [];
  try {
    const current = await ensureBytes();
    return wasm.prollyLog(current);
  } catch (e) {
    console.warn("history: readLog failed:", e?.message ?? e);
    return [];
  }
}

/** Snapshot the raw bytes for the Package zip. Returns null if the
 *  chain hasn't been bootstrapped (no edits yet recorded). */
export async function snapshotHistoryBytes() {
  // Don't force bootstrap if it hasn't happened — that would imply
  // an empty session has history to save, which it doesn't.
  if (!_bytesPromise) return null;
  return _bytesPromise;
}

/** Replace the entire chain with a fresh init. Used by a
 *  "reset history" affordance — currently unwired but kept for
 *  symmetry with clearAll() in persistence. */
export async function resetHistory() {
  let wasm;
  try { wasm = await getWasm(); } catch { return; }
  if (!wasm.prollyInit) return;
  const fresh = wasm.prollyInit(INIT_MESSAGE);
  _bytesPromise = Promise.resolve(fresh);
  saveState(HISTORY_KEY, fresh);
}
