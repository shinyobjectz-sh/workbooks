import { mount } from "svelte";
import App from "./App.svelte";
import { bootstrapLoro } from "./lib/loroBackend.svelte.js";

// Kick off the Loro CRDT bootstrap in parallel with the Svelte mount.
// The composition store's hydration path awaits this promise before
// reading any saved state. Eager start avoids a perceptible "loading"
// frame after first paint when prior state exists.
bootstrapLoro().catch((e) => {
  // bootstrapLoro itself swallows the missing-peer-dep case and
  // returns null. Anything that lands here is unexpected — surface
  // to console, app continues with empty state.
  console.error("hf: loro bootstrap failed:", e);
});

mount(App, { target: document.getElementById("app") });
