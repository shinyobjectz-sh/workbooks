/**
 * Cross-workbook composition + lockfile (P6.4).
 *
 * A workbook can `load()` cells from other workbooks. The loader resolves
 * the upstream workbook's `.workbook` file, pins the resolved
 * (slug, version, sha256) into a lockfile, and re-exports the upstream's
 * `provides` set for downstream cells.
 *
 * Lockfile contract (one per consuming workbook):
 *
 *   {
 *     version: 1,
 *     entries: [
 *       {
 *         slug: "@user/forecasting-utils",
 *         resolved_url: "https://workbooks.example/.../v3.workbook",
 *         resolved_at: "2026-04-29T01:23:45Z",
 *         sha256: "abc…",
 *         provides: ["forecast_arima", "forecast_prophet"],
 *       }
 *     ]
 *   }
 *
 * Pinned shas mean a workbook never silently picks up upstream changes
 * — re-running an old workbook produces the same outputs even if the
 * upstream has shipped breaking changes since.
 *
 * Status: P6.4 baseline. Schema + lockfile builder + resolver shape;
 * the runtime-side execution path that mounts upstream cells into the
 * dependency graph is a follow-up tied to the executor (composes with
 * ReactiveExecutor.setCell + cellAnalyzer's reads/provides).
 */

import { sha256Hex } from "./modelArtifactResolver";

export interface CrossWorkbookRef {
  /** Stable slug (with optional @user/ scope) — the source-of-truth name. */
  slug: string;
  /** Version constraint. Today only exact-version pins (`v3` etc.). */
  version: string;
  /**
   * Optional pre-resolved URL. If not set, the resolver consults the
   * registry (Tier 2/3 host) to locate the workbook file.
   */
  url?: string;
}

export interface LockfileEntry {
  slug: string;
  /** Resolved URL — what was actually fetched. */
  resolved_url: string;
  /** ISO-8601 timestamp of the original resolve. */
  resolved_at: string;
  /** SHA-256 of the workbook file bytes. Pin guarantee. */
  sha256: string;
  /** Names this upstream provides for downstream consumption. */
  provides: string[];
}

export interface Lockfile {
  version: 1;
  entries: LockfileEntry[];
}

export interface CrossWorkbookLoader {
  resolve(ref: CrossWorkbookRef): Promise<LockfileEntry>;
  resolveAll(refs: CrossWorkbookRef[]): Promise<Lockfile>;
  /** Fetch upstream bytes for an already-pinned entry (lockfile path). */
  loadPinned(entry: LockfileEntry): Promise<Uint8Array>;
}

export interface LoaderOptions {
  /**
   * Resolve a slug (+ version) to a fetchable URL. The Tier 2/3 host
   * provides this — typically a workbooks-registry HTTP service.
   */
  registryResolve: (slug: string, version: string) => Promise<string>;
  /**
   * Fetch a URL and return bytes. Defaults to global fetch; override for
   * authentication, retry, etc.
   */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /**
   * Extract the upstream's `provides` set from its workbook bytes. The
   * host parses the manifest and returns the names. v1 caller responsibility.
   */
  extractProvides: (bytes: Uint8Array) => string[];
}

export function createCrossWorkbookLoader(opts: LoaderOptions): CrossWorkbookLoader {
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;

  return {
    async resolve(ref) {
      const url = ref.url ?? (await opts.registryResolve(ref.slug, ref.version));
      const bytes = await fetchBytes(url);
      const sha256 = await sha256Hex(bytes);
      const provides = opts.extractProvides(bytes);
      return {
        slug: ref.slug,
        resolved_url: url,
        resolved_at: new Date().toISOString(),
        sha256,
        provides,
      };
    },

    async resolveAll(refs) {
      const entries: LockfileEntry[] = [];
      for (const ref of refs) {
        // Sequential to keep the registry happy + log lines ordered;
        // if registries are CDN-cached this is still <100ms per ref.
        entries.push(await this.resolve(ref));
      }
      return { version: 1, entries };
    },

    async loadPinned(entry) {
      const bytes = await fetchBytes(entry.resolved_url);
      const sha = await sha256Hex(bytes);
      if (sha !== entry.sha256) {
        throw new Error(
          `lockfile integrity failed for ${entry.slug}: ` +
            `expected ${entry.sha256}, got ${sha}`,
        );
      }
      return bytes;
    },
  };
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`workbook fetch failed: ${url} → ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
