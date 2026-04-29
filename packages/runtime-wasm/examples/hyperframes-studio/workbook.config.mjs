// hyperframes-studio — chat-on-left, player+timeline-on-right.
// An LLM agent edits an HTML video composition; a sandboxed iframe
// renders it; a parsed timeline shows clips with their data-start /
// data-duration. Same SPA workbook shape as svelte-app & tailwind-app.
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default {
  name: "hyperframes-studio · workbook",
  slug: "hyperframes-studio",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  vite: {
    // wasm + topLevelAwait are needed because loro-crdt ships as an
    // ESM-integrated WASM module (the proposal Vite doesn't yet
    // support natively). The plugins handle the compile + init
    // and degrade the top-level-await loader for older targets.
    plugins: [tailwindcss(), wasm(), topLevelAwait()],
  },
  env: {
    OPENROUTER_API_KEY: {
      label: "openrouter api key",
      prompt: "sk-or-…",
      required: true,
      secret: true,
    },
  },
};
