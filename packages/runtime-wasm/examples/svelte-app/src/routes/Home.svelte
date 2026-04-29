<script>
  import { link } from "svelte-spa-router";
</script>

<section>
  <div class="eyebrow">workbook · portable apps</div>
  <h1>This isn't a notebook. It's a Svelte app shipped as a single HTML file.</h1>
  <p>
    Three routes, hash-based navigation, all components compiled into
    one self-contained <code>.workbook.html</code>. Same wasm runtime
    available under the hood (Polars / Rhai / charts) when you need it.
    Open this file from a USB stick, an email attachment, or
    <code>file://</code> — it just runs.
  </p>
  <div class="cta">
    <a use:link href="/editor" class="btn primary">open the editor</a>
    <a use:link href="/settings" class="btn">env settings</a>
  </div>
</section>

<section>
  <h2>What's inside</h2>
  <ul>
    <li><strong>Multi-page navigation.</strong> svelte-spa-router for hash routes — works under file://, browser back/forward all functional.</li>
    <li><strong>Component model.</strong> Real Svelte 5 components, not hand-written templates. <code>workbook build</code> compiles them.</li>
    <li><strong>Single artifact.</strong> No <code>dist/</code> folder. One <code>.workbook.html</code>, ~17 MB with the wasm runtime included.</li>
    <li><strong>Optional runtime.</strong> Pull in Polars, Rhai, charts on demand from <code>virtual:workbook-runtime</code>. Most pages don't need them.</li>
  </ul>
</section>

<style>
  section { margin: 0 0 48px; }
  .eyebrow {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #78716c;
    text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 12px;
  }
  h1 { font-size: 32px; font-weight: 700; margin: 0 0 16px; line-height: 1.2; max-width: 700px; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
  p { font-size: 16px; color: #44403c; max-width: 640px; }
  ul { padding-left: 22px; color: #44403c; max-width: 640px; }
  ul li { margin: 6px 0; }
  code {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.92em; background: #f3f1ec;
    padding: 1px 6px; border-radius: 3px;
  }
  .cta { display: flex; gap: 12px; margin-top: 24px; }
  .btn {
    display: inline-block; padding: 8px 16px;
    border: 1px solid #d6d3d1; border-radius: 4px;
    text-decoration: none; color: #44403c; font-size: 14px;
  }
  .btn:hover { background: #f3f1ec; color: #0c0a09; border-color: #a8a29e; }
  .btn.primary { background: #7c2d12; border-color: #7c2d12; color: white; }
  .btn.primary:hover { background: #5e220e; border-color: #5e220e; color: white; }
</style>
