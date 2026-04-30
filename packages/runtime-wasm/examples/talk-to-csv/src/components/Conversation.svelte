<script>
  let { turns } = $props();

  function fmtCell(v) {
    if (v == null) return "—";
    if (typeof v === "number") {
      if (Math.abs(v) >= 1000) return v.toLocaleString();
      if (Number.isInteger(v)) return String(v);
      return v.toFixed(2);
    }
    return String(v);
  }
</script>

<div class="space-y-4">
  {#each turns as turn (turn.id)}
    <div class="border border-border bg-surface">
      <!-- Question -->
      <div class="px-4 py-3 border-b border-border">
        <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-1">
          question · {turn.source === "llm" ? "via LLM" : "matched canned"}
        </div>
        <div class="text-sm">{turn.question}</div>
      </div>

      <!-- SQL -->
      <div class="px-4 py-3 border-b border-border bg-page">
        <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-1">
          translated to polars-sql
        </div>
        <pre class="text-[12px] font-mono whitespace-pre-wrap">{turn.sql}</pre>
      </div>

      <!-- Result -->
      <div class="px-4 py-3">
        {#if turn.error}
          <div class="border-2 border-fg p-3 text-sm font-mono whitespace-pre-wrap">
            {turn.error}
          </div>
        {:else if turn.busy}
          <div class="text-sm text-fg-muted font-mono">running query…</div>
        {:else if turn.rows && turn.rows.length}
          <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
            {turn.rows.length} row{turn.rows.length === 1 ? "" : "s"}
          </div>
          <div class="overflow-x-auto">
            <table class="text-[12px] font-mono w-full">
              <thead>
                <tr class="border-b border-border">
                  {#each Object.keys(turn.rows[0]) as col}
                    <th class="text-left px-2 py-1 text-fg-muted uppercase tracking-wider text-[10px]">
                      {col}
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each turn.rows as row, i}
                  <tr class="border-b border-border last:border-0 {i % 2 ? '' : 'bg-page/40'}">
                    {#each Object.keys(turn.rows[0]) as col}
                      <td class="px-2 py-1 align-top">{fmtCell(row[col])}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-sm text-fg-muted font-mono">no rows matched.</div>
        {/if}
      </div>
    </div>
  {/each}
</div>
