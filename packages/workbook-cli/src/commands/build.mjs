// `workbook build` — compile project into a single .workbook.html.

import path from "node:path";
import { build as viteBuild } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { loadConfig } from "../util/config.mjs";
import workbookPlugin from "../plugins/workbookInline.mjs";

export async function runBuild({ project = ".", out, runtime, wasm } = {}) {
  const config = await loadConfig(project);
  const outDir = path.resolve(config.root, out ?? "dist");
  const inlineRuntime = wasm === false ? false : config.inlineRuntime;

  const plugins = [
    // viteSingleFile inlines all JS + CSS into the HTML. Without it,
    // Vite emits separate /assets/*.js + .css files and the HTML
    // <script>/<link> them — which defeats single-file portability.
    viteSingleFile({
      removeViteModuleLoader: true,
      useRecommendedBuildConfig: true,
    }),
    workbookPlugin({ config: { ...config, inlineRuntime }, runtimeOverride: runtime }),
  ];

  const sveltePlugin = await tryLoadSveltePlugin(config.root);
  if (sveltePlugin) plugins.unshift(sveltePlugin);

  // Use the entry's parent dir as the Vite root so the entry sits
  // at "/index.html" — that gives us a flat dist/ instead of
  // dist/src/index.html mirroring the source layout.
  const entryAbs = path.resolve(config.root, config.entry);
  const viteRoot = path.dirname(entryAbs);

  await viteBuild({
    root: viteRoot,
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: entryAbs,
      },
      // Single-file output — no code splitting, no asset emission.
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: false,
    },
    plugins,
    ...config.vite,
    logLevel: "info",
  });

  process.stdout.write(`[workbook] build complete · slug=${config.slug} → ${path.relative(process.cwd(), outDir)}\n`);
}

async function tryLoadSveltePlugin(root) {
  try {
    const mod = await import("@sveltejs/vite-plugin-svelte");
    return mod.svelte();
  } catch {
    return null;
  }
}
