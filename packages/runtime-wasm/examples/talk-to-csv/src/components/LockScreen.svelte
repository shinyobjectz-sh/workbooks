<script>
  let { onUnlock } = $props();

  let passphrase = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(e) {
    e.preventDefault();
    if (!passphrase) return;
    busy = true;
    error = "";
    try {
      await onUnlock(passphrase);
    } catch (err) {
      error = err?.message ?? String(err);
      passphrase = "";
    } finally {
      busy = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center p-6">
  <form onsubmit={submit} class="w-full max-w-md">
    <div class="border border-border bg-surface p-8">
      <div class="flex items-center gap-2 mb-1">
        <span class="inline-block w-2 h-2 bg-locked rounded-full"></span>
        <span class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">
          locked
        </span>
      </div>
      <h1 class="text-xl font-semibold mb-1">talk to your CSV</h1>
      <p class="text-sm text-fg-muted mb-6">
        The dataset embedded in this file is encrypted with age. Enter the
        passphrase to decrypt — your bytes never leave the browser.
      </p>

      <label class="block text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
        passphrase
      </label>
      <input
        type="password"
        bind:value={passphrase}
        placeholder="correct-horse-battery-staple"
        autocomplete="current-password"
        autofocus
        class="input-mono w-full border border-border bg-page px-3 py-2 mb-4 focus:outline-none focus:border-fg"
      />

      {#if error}
        <div class="border-2 border-fg p-3 mb-4 text-sm font-mono whitespace-pre-wrap">
          {error}
        </div>
      {/if}

      <button
        type="submit"
        disabled={busy || !passphrase}
        class="w-full bg-fg text-page py-2 text-sm uppercase tracking-wider font-mono hover:bg-fg/90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "decrypting…" : "unlock"}
      </button>

      <div class="mt-6 pt-6 border-t border-border space-y-1.5">
        <p class="text-[11px] text-fg-muted font-mono">
          age-v1 · scrypt N=2^18 · ChaCha20-Poly1305
        </p>
        <p class="text-[11px] text-fg-muted font-mono">
          plaintext stays in WASM linear memory (Phase E)
        </p>
        <p class="text-[11px] text-fg-faint font-mono">
          demo passphrase: <span class="text-fg-muted">correct-horse-battery-staple</span>
        </p>
      </div>
    </div>
  </form>
</div>
