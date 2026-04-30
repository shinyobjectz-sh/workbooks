<script lang="ts">
  /**
   * MenuBar — File / Edit / View / Plugins / Skills dropdowns.
   *
   * Shape: a horizontal strip of menu triggers. Click opens a
   * dropdown; click outside closes; Escape closes; arrow-keys
   * navigate items; Enter activates. The menus are flat (no
   * submenus yet) — keeps the keyboard model simple.
   *
   * Each menu item is { label, accel?, onSelect, disabled?,
   * separator? }. Separators render as a thin rule between groups.
   *
   * Initial population is partial — Phase A surfaces the existing
   * actions (Settings, Render, Package). Subsequent phases (B–E)
   * fill in New / Open / Export / Plugins / Skills as those features
   * land.
   */

  import { onMount } from "svelte";

  type MenuItem =
    | { kind: "item"; label: string; accel?: string; onSelect: () => void; disabled?: boolean }
    | { kind: "separator" };

  type Menu = { label: string; items: MenuItem[] };

  type Props = {
    onPackage: () => void;
    onRender: () => void;
    onSettings: () => void;
    /** Future: wire these as B/C/D/E phases land. */
    onNewProject?: () => void;
    onOpenProject?: () => void;
    onExportHyperframe?: () => void;
    onPluginManager?: () => void;
    onSkillManager?: () => void;
  };

  let {
    onPackage,
    onRender,
    onSettings,
    onNewProject,
    onOpenProject,
    onExportHyperframe,
    onPluginManager,
    onSkillManager,
  }: Props = $props();

  // Active dropdown — null when no menu is open.
  let openMenu = $state<string | null>(null);
  let menuRoot: HTMLDivElement | undefined = $state(undefined);

  // Menu definitions — labels match common DAW conventions
  // (After Effects / Premiere / Photoshop) for muscle-memory.
  const menus: Menu[] = $derived([
    {
      label: "File",
      items: [
        { kind: "item", label: "New Project…", onSelect: () => onNewProject?.(), disabled: !onNewProject },
        { kind: "item", label: "Open Project…", accel: "⌘O", onSelect: () => onOpenProject?.(), disabled: !onOpenProject },
        { kind: "separator" },
        { kind: "item", label: "Export Hyperframe HTML…", onSelect: () => onExportHyperframe?.(), disabled: !onExportHyperframe },
        { kind: "item", label: "Package Project…", onSelect: onPackage },
        { kind: "separator" },
        { kind: "item", label: "Render…", accel: "⌘R", onSelect: onRender },
        { kind: "separator" },
        { kind: "item", label: "Settings…", accel: "⌘,", onSelect: onSettings },
      ],
    },
    {
      label: "Edit",
      items: [
        { kind: "item", label: "Undo", accel: "⌘Z", onSelect: () => {}, disabled: true },
        { kind: "item", label: "Redo", accel: "⇧⌘Z", onSelect: () => {}, disabled: true },
      ],
    },
    {
      label: "Plugins",
      items: [
        { kind: "item", label: "Plugin Manager…", onSelect: () => onPluginManager?.(), disabled: !onPluginManager },
      ],
    },
    {
      label: "Skills",
      items: [
        { kind: "item", label: "Skill Manager…", onSelect: () => onSkillManager?.(), disabled: !onSkillManager },
      ],
    },
  ]);

  function toggle(label: string) {
    openMenu = openMenu === label ? null : label;
  }
  function close() { openMenu = null; }
  function activate(item: MenuItem) {
    if (item.kind !== "item" || item.disabled) return;
    close();
    item.onSelect();
  }

  // Click-outside + Escape closes the menu.
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!menuRoot) return;
      if (!menuRoot.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  // Hover-to-rotate-open: when one menu is open and the cursor
  // moves to another trigger, swap. Matches AE/Premiere behavior.
  function onTriggerEnter(label: string) {
    if (openMenu !== null && openMenu !== label) openMenu = label;
  }
</script>

<div bind:this={menuRoot} class="mb-bar">
  {#each menus as m (m.label)}
    <div class="mb-slot">
      <button
        class="mb-trigger"
        class:open={openMenu === m.label}
        onclick={() => toggle(m.label)}
        onmouseenter={() => onTriggerEnter(m.label)}
        aria-haspopup="menu"
        aria-expanded={openMenu === m.label}
      >{m.label}</button>

      {#if openMenu === m.label}
        <div class="mb-dropdown" role="menu">
          {#each m.items as item, idx (idx)}
            {#if item.kind === "separator"}
              <div class="mb-sep" role="separator"></div>
            {:else}
              <button
                class="mb-item"
                class:disabled={item.disabled}
                role="menuitem"
                disabled={item.disabled}
                onclick={() => activate(item)}
              >
                <span class="mb-label">{item.label}</span>
                {#if item.accel}<span class="mb-accel">{item.accel}</span>{/if}
              </button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .mb-bar {
    display: flex; align-items: stretch;
    gap: 0;
    height: 100%;
  }
  .mb-slot { position: relative; display: flex; }
  .mb-trigger {
    display: inline-flex; align-items: center;
    height: 100%;
    padding: 0 10px;
    background: transparent;
    border: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-fg-muted);
    transition: background 100ms ease, color 100ms ease;
    white-space: nowrap;
  }
  .mb-trigger:hover, .mb-trigger.open {
    color: var(--color-fg);
    background: var(--color-surface);
  }
  .mb-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 220px;
    z-index: 50;
    padding: 4px 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-top: 0;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }
  .mb-item {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%;
    padding: 6px 14px;
    background: transparent;
    border: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-fg);
    text-align: left;
    gap: 24px;
    transition: background 80ms ease;
  }
  .mb-item:hover:not(:disabled) {
    background: var(--color-surface-2, color-mix(in srgb, var(--color-accent) 14%, transparent));
    color: var(--color-fg);
  }
  .mb-item.disabled, .mb-item:disabled {
    color: var(--color-fg-faint);
    cursor: default;
  }
  .mb-accel {
    font-size: 10px;
    color: var(--color-fg-faint);
    font-feature-settings: "tnum";
    letter-spacing: 0.04em;
  }
  .mb-sep {
    height: 1px;
    background: var(--color-border);
    margin: 4px 0;
  }
</style>
