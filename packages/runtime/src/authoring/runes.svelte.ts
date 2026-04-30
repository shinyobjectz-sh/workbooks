/**
 * Authoring hooks. The runes-based escape hatch for components that
 * want fine-grained control beyond <Cell>/<Input>/<Output>.
 *
 *   useCell(id)     reactive single-cell state
 *   useDAG()        reactive whole-cell-graph view
 *   useRuntime()    raw wasm + bundle accessors (after boot)
 *
 * All three must be called inside a component that's a descendant of
 * <WorkbookApp>. Calling them outside throws — the error message
 * points at the missing wrapper.
 *
 * Why .svelte.ts: these functions use $derived under the hood, which
 * Svelte 5 only allows in .svelte and .svelte.ts modules.
 */

import { requireAuthoringContext } from "./context";
import type { CellState, ReactiveExecutor } from "../reactiveExecutor";
import type { CellStatesMap } from "./context";

/**
 * Reactive subscription to a single cell's state. Returns a getter
 * function that always reflects the latest state.
 *
 *   const cell = useCell("by_region");
 *   $effect(() => console.log(cell().status));
 *
 * The getter pattern keeps the rune chain unbroken — if we returned a
 * plain CellState we'd snapshot it at call time and lose reactivity.
 */
export function useCell(id: string): () => CellState | undefined {
  const ctx = requireAuthoringContext("useCell");
  return () => ctx.getCellState(id);
}

/**
 * Reactive view of every cell's state. Returns a getter for the
 * whole map. Useful for inspectors / overviews that want to render
 * the DAG.
 *
 *   const all = useDAG();
 *   $effect(() => {
 *     for (const [id, state] of all()) {
 *       console.log(id, state.status);
 *     }
 *   });
 */
export function useDAG(): () => CellStatesMap {
  const ctx = requireAuthoringContext("useDAG");
  return () => ctx.getAllCellStates();
}

/**
 * Direct access to the runtime bindings (wasm-bindgen exports +
 * the bundle's helpers). Returns null until the runtime has booted —
 * call ctx.ready() if you need to await.
 *
 *   const runtime = useRuntime();
 *   $effect(() => {
 *     const r = runtime();
 *     if (r) {
 *       const result = r.runPolarsSql("SELECT 1", "");
 *     }
 *   });
 */
export function useRuntime(): () => unknown {
  const ctx = requireAuthoringContext("useRuntime");
  return () => ctx.getRuntime();
}

/** Direct access to the executor. Useful when you need to call
 *  runCell/runAll imperatively (e.g. a "Run all" button). Returns
 *  null until the runtime has booted. */
export function useExecutor(): () => ReactiveExecutor | null {
  const ctx = requireAuthoringContext("useExecutor");
  return () => ctx.getExecutor();
}
