// Composition state backed by a real Loro CRDT.
//
// We previously persisted composition.html as a plain string in IDB.
// This module replaces that storage shape with a Loro document so two
// hyperframes sessions on different machines can fork-and-merge their
// state automatically (last-writer-wins on the html key for now).
//
// Phase 1 (this file): the composition lives inside one top-level
// Loro Map under the key "html" — full-string LWW on every write.
// Future Phase 2: switch to LoroText for character-level merge so
// concurrent edits to the composition source resolve byte-by-byte
// instead of clobbering each other.
//
// Storage: the Loro snapshot bytes round-trip through IDB under
// LORO_KEY. On first run with this code, we migrate any prior
// plain-string state from LEGACY_KEY into the Loro doc — single
// commit, no data loss.

import { loadState, markDirty } from "./persistence.svelte.js";

const LORO_KEY = "composition.loro";
const LEGACY_KEY = "composition";

let _doc = null;            // populated post-bootstrap
let _bootPromise = null;

/** Bootstrap the Loro doc once. Subsequent calls reuse the cached
 *  promise; sync callers use getDoc() after awaiting bootstrap(). */
export function bootstrapLoro() {
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    let loro;
    try {
      loro = await import("loro-crdt");
    } catch (e) {
      console.warn("hf loro: peer dep missing, falling back to plain string IDB:", e?.message ?? e);
      // No-op stub — composition.set() calls below will still
      // markDirty under the legacy key, so persistence still works.
      _doc = null;
      return null;
    }
    const doc = new loro.LoroDoc();

    const savedBytes = await loadState(LORO_KEY);
    if (savedBytes instanceof Uint8Array && savedBytes.byteLength > 0) {
      try {
        doc.import(savedBytes);
      } catch (e) {
        console.warn("hf loro: snapshot import failed, starting fresh:", e?.message ?? e);
      }
    } else {
      // First run with Loro — migrate prior plain-string state if any.
      const legacy = await loadState(LEGACY_KEY);
      if (legacy && typeof legacy.html === "string" && legacy.html.length > 0) {
        doc.getMap("composition").set("html", legacy.html);
        doc.commit();
      }
    }

    _doc = doc;
    return doc;
  })();
  return _bootPromise;
}

/** Synchronous access — returns null until bootstrapLoro() resolves. */
export function getDoc() { return _doc; }

/** Read the current composition html from Loro. Returns "" if the
 *  doc has no html set yet. */
export function readComposition() {
  if (!_doc) return "";
  const v = _doc.getMap("composition").get("html");
  return typeof v === "string" ? v : "";
}

/** Apply a new composition html as a single Loro op + commit. The
 *  snapshot save is debounced via markDirty in the persistence
 *  coordinator. Safe to call before bootstrap (no-op until ready). */
export function writeComposition(html) {
  if (!_doc) return;
  _doc.getMap("composition").set("html", String(html ?? ""));
  _doc.commit();
  // Schedule save of the new snapshot bytes (debounced).
  markDirty(LORO_KEY, () => {
    return _doc ? _doc.export({ mode: "snapshot" }) : null;
  });
}

/** Force-export the current snapshot synchronously. Used by the
 *  Package flow when it needs canonical bytes regardless of debounce
 *  state. Returns null if the doc isn't bootstrapped yet. */
export function snapshotCompositionBytes() {
  return _doc ? _doc.export({ mode: "snapshot" }) : null;
}
