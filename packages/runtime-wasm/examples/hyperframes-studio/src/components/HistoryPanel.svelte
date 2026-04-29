<script>
  // History panel — newest-first commit log from the Prolly Tree
  // edit chain. Each commit = one significant edit (composition save,
  // asset add/remove, agent turn). The panel auto-refreshes on tab
  // entry; for finer-grained reactivity we'd hook a "history changed"
  // event from historyBackend, but tab-switch is simple enough.

  import { readLog } from "../lib/historyBackend.svelte.js";
  import { layout } from "../lib/layout.svelte.js";

  let entries = $state([]);
  let loading = $state(false);
  let error = $state("");

  // When the tab becomes visible, refresh. Cheap to refresh on every
  // entry since prollyLog walks an in-memory chain.
  $effect(() => {
    if (layout.leftTab !== "history") return;
    loading = true;
    error = "";
    readLog()
      .then((log) => {
        entries = log;
        loading = false;
      })
      .catch((e) => {
        error = e?.message ?? String(e);
        loading = false;
      });
  });

  function fmtTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const d = new Date(ms);
    const ago = Date.now() - ms;
    if (ago < 60_000) return `${Math.max(1, Math.round(ago / 1000))}s ago`;
    if (ago < 3600_000) return `${Math.round(ago / 60_000)}m ago`;
    if (ago < 86400_000) return `${Math.round(ago / 3600_000)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function shortHash(h) {
    if (!h || typeof h !== "string") return "";
    return h.slice(0, 8);
  }

  let isEmpty = $derived(!loading && !error && entries.length === 0);
</script>

<section class="flex flex-col min-h-0 flex-1 bg-page">
  <header class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
    <div class="flex items-center gap-2">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="text-fg-muted">
        <circle cx="7" cy="3" r="1.2"/>
        <circle cx="7" cy="7" r="1.2"/>
        <circle cx="7" cy="11" r="1.2"/>
        <path d="M7 4.2 L7 5.8"/>
        <path d="M7 8.2 L7 9.8"/>
      </svg>
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-fg-muted m-0 font-semibold">
        edit log
      </h3>
    </div>
    {#if entries.length > 0}
      <span class="font-mono text-[10px] text-fg-faint tabular-nums">
        {entries.length} commit{entries.length === 1 ? "" : "s"}
      </span>
    {/if}
  </header>

  <div class="flex-1 min-h-0 overflow-y-auto">
    {#if loading}
      <div class="px-3 py-4 font-mono text-[11px] text-fg-faint">
        loading…
      </div>
    {:else if error}
      <div class="px-3 py-4 font-mono text-[11px] text-red-400">
        {error}
      </div>
    {:else if isEmpty}
      <div class="px-3 py-6 font-mono text-[11px] text-fg-faint leading-relaxed">
        <div>No edits recorded yet.</div>
        <div class="mt-2 text-fg-subtle">
          Every composition save, asset change, or agent turn appends a
          cryptographically-chained entry here. Edits made before this
          panel was first visited still get recorded — they appear after
          your next mutation.
        </div>
      </div>
    {:else}
      <ul class="font-mono text-[11px] divide-y divide-border-subtle">
        {#each entries as e (e.hash)}
          <li class="px-3 py-2 hover:bg-surface group">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-fg truncate" title={e.message}>
                {e.message || "(no message)"}
              </span>
              <span class="text-fg-faint tabular-nums flex-shrink-0">
                {fmtTime(e.timestamp_ms)}
              </span>
            </div>
            <div class="mt-1 flex items-center gap-2 text-fg-subtle">
              <span class="tabular-nums">{shortHash(e.hash)}</span>
              {#if e.parent}
                <span class="text-fg-faint">←</span>
                <span class="tabular-nums">{shortHash(e.parent)}</span>
              {:else}
                <span class="text-fg-faint italic">root</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  /* Subtler divider than the default border. Borrows the same token
   * the timeline divider uses so the visual weight matches. */
  .divide-border-subtle > * + * {
    border-top: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
  }
</style>
