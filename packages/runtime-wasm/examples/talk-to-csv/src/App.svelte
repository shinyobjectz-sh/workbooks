<script>
  import LockScreen from "./components/LockScreen.svelte";
  import SchemaPanel from "./components/SchemaPanel.svelte";
  import LlmConfig from "./components/LlmConfig.svelte";
  import QuestionInput from "./components/QuestionInput.svelte";
  import Conversation from "./components/Conversation.svelte";
  import {
    unlock,
    query,
    dispose,
    getSchema,
    getSampleRows,
  } from "./lib/secure-csv.js";
  import { tryCanned, askLlm } from "./lib/nl2sql.js";

  let unlocked = $state(false);
  let schema = $state([]);
  let rowCount = $state(0);
  let sampleRows = $state([]);
  let turns = $state([]);
  let busy = $state(false);
  let schemaExpanded = $state(false);

  let llm = $state({
    apiKey: "",
    model: "anthropic/claude-haiku-4-5",
    includeSampleRows: false,
  });

  async function handleUnlock(passphrase) {
    const info = await unlock(passphrase);
    schema = info.schema;
    rowCount = info.rows;
    // Pre-fetch the 5-row sample so the trust panel can show it.
    // We never display the full data — the LLM panel is opt-in.
    sampleRows = await getSampleRows(5);
    unlocked = true;
  }

  async function ask(question) {
    const id = crypto.randomUUID?.() ?? String(Date.now());
    let turn = {
      id,
      question,
      sql: "",
      source: "canned",
      busy: true,
      rows: null,
      error: "",
    };
    turns = [turn, ...turns];

    try {
      // 1. canned mapping first
      let sql = tryCanned(question);
      let source = "canned";

      // 2. fall back to the LLM if configured
      if (!sql && llm.apiKey) {
        source = "llm";
        sql = await askLlm({
          apiKey: llm.apiKey,
          model: llm.model,
          question,
          schema,
          sampleRows: llm.includeSampleRows ? sampleRows : [],
        });
      }

      if (!sql) {
        throw new Error(
          "I don't recognize that question and the LLM panel is off. " +
            "Try a suggested question or paste an OpenRouter key in the LLM panel.",
        );
      }

      // mutate the turn object that's already in state
      turn.sql = sql;
      turn.source = source;
      turn.rows = await query(sql);
    } catch (e) {
      turn.error = e?.message ?? String(e);
    } finally {
      turn.busy = false;
      // trigger reactivity by reassigning the array
      turns = [...turns];
    }
  }

  function lock() {
    dispose();
    unlocked = false;
    turns = [];
    sampleRows = [];
    schema = [];
    rowCount = 0;
  }
</script>

{#if !unlocked}
  <LockScreen onUnlock={handleUnlock} />
{:else}
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-border bg-surface px-6 py-3 flex items-baseline justify-between">
      <div class="flex items-baseline gap-3">
        <h1 class="text-base font-semibold">talk to your CSV</h1>
        <span class="text-[11px] text-fg-muted font-mono">
          encrypted · age-v1 · isolated in WASM
        </span>
      </div>
      <button
        type="button"
        onclick={lock}
        class="text-[11px] uppercase tracking-wider font-mono border border-border px-3 py-1 hover:border-fg"
      >
        lock
      </button>
    </header>

    <main class="flex-1 max-w-4xl w-full mx-auto px-6 py-6 space-y-4">
      <SchemaPanel
        {schema}
        {rowCount}
        sample={sampleRows}
        bind:expanded={schemaExpanded}
      />

      <LlmConfig bind:config={llm} />

      <div class="pt-2">
        <QuestionInput onAsk={ask} {busy} />
      </div>

      {#if turns.length}
        <Conversation {turns} />
      {:else}
        <div class="text-center py-12 text-fg-muted text-sm">
          ask anything about the data —
          <span class="text-fg-faint">canned questions covered above</span>
        </div>
      {/if}
    </main>

    <footer class="border-t border-border bg-surface px-6 py-3 text-[11px] text-fg-faint font-mono">
      decrypted bytes never leave WASM linear memory · schema-only LLM prompts ·
      <a class="hover:text-fg" href="https://github.com/zaius-labs/workbooks">workbooks</a>
    </footer>
  </div>
{/if}
