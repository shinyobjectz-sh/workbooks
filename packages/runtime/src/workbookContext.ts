/**
 * Sbook render context (epic core-6vr).
 *
 * Provides the host sbook's id to deeply-nested block components that
 * need to write back (`Input.svelte` calls api.sbookBlocks.setBlockValue
 * with this; future Phase C step blocks will read it for run-state
 * mutations). Pages mounting an sbook (`/n/[slug]`) call setWorkbookContext
 * once at the canvas level; blocks consume via getWorkbookContext.
 *
 * Reading the context returns null when an sdoc is rendered outside a
 * sbook (legacy session-report viewer) — Input blocks degrade to no-op
 * persistence in that case.
 */

import { getContext, setContext } from "svelte";
import type { Id } from "$convex/dataModel";

const KEY = Symbol("sbook-context");

export type WorkbookContext = {
  sbookId: Id<"sbooks">;
};

export function setWorkbookContext(ctx: WorkbookContext): void {
  setContext(KEY, ctx);
}

export function getWorkbookContext(): WorkbookContext | null {
  return (getContext(KEY) as WorkbookContext | undefined) ?? null;
}
