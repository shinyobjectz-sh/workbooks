// Polyglot packaging stage of `workbook build`.
//
// Invokes the workbook-runner build.sh against the just-emitted
// <slug>.workbook.html, producing three platform artifacts:
//   <slug>-mac.zip      Mac Finder-friendly .app bundle
//   <slug>-win.exe      Windows-runnable polyglot
//   <slug>-linux        Bare polyglot
//
// Soft-skips with an instructional log line when cosmocc isn't
// installed — authors who only want the .html artifact aren't blocked.

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PKG = path.resolve(HERE, "..", "..", "..", "workbook-runner");
const BUILD_SH = path.join(RUNNER_PKG, "scripts", "build.sh");
const COSMOCC = path.resolve(RUNNER_PKG, "..", "..", "..", "cosmocc", "bin", "cosmocc");

export async function runPolyglotPackage({ outDir, slug }) {
  const htmlPath = path.join(outDir, `${slug}.workbook.html`);
  if (!existsSync(htmlPath)) {
    process.stdout.write(
      `[polyglot] no ${slug}.workbook.html in ${outDir} — skipping polyglot wrap\n`,
    );
    return;
  }

  if (!existsSync(COSMOCC)) {
    process.stdout.write(
      `[polyglot] cosmocc not installed at ${path.relative(process.cwd(), COSMOCC)} — skipping polyglot wrap.\n` +
      `[polyglot]   Install once:\n` +
      `[polyglot]     mkdir -p vendor/cosmocc && cd vendor/cosmocc && curl -sSL -O https://cosmo.zip/pub/cosmocc/cosmocc.zip && unzip cosmocc.zip\n` +
      `[polyglot]   Then re-run \`workbook build\` for cross-platform binaries.\n` +
      `[polyglot]   Pass --no-polyglot to silence this message.\n`,
    );
    return;
  }
  if (!existsSync(BUILD_SH)) {
    process.stdout.write(
      `[polyglot] missing ${BUILD_SH} — workbook-runner package not present? Skipping.\n`,
    );
    return;
  }

  process.stdout.write(`[polyglot] wrapping ${slug}.workbook.html → ${slug}.com\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(BUILD_SH, [htmlPath, outDir, "--name", slug], {
      stdio: "inherit",
      env: process.env, // forwards APPLE_DEVELOPER_ID, WIN_CODESIGN_CERT_PATH, etc.
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build.sh exited ${code}`));
    });
  });

  // Friendly summary — one polyglot file + the HTML mobile fallback.
  const polyglotPath = path.join(outDir, `${slug}.com`);
  if (existsSync(polyglotPath)) {
    const stat = await fs.stat(polyglotPath);
    const mb = (stat.size / 1024 / 1024).toFixed(2);
    process.stdout.write(`[polyglot]   ${slug}.com: ${mb} MB (universal — Mac/Win/Linux)\n`);
  }
  // The original .workbook.html is always preserved in outDir as the
  // mobile-fallback artifact (mobile browsers open the HTML and use
  // substrate's T3/T4 transports for save).
  process.stdout.write(`[polyglot]   ${slug}.workbook.html kept for mobile users (substrate T3/T4 transports)\n`);
}
