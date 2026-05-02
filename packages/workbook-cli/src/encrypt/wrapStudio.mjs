// Studio-encrypted workbook wrapper. Sister of wrapHtml.mjs (which does
// passphrase-based age-v1). This produces studio-v1 envelopes whose
// decryption keys are released by the broker, not derived from a
// passphrase.
//
// Spec: vendor/workbooks/docs/ENCRYPTED_FORMAT.md
// Threat model: vendor/workbooks/docs/SECURITY_MODEL_MULTIPARTY.md
// Tracker: bd show core-1fi.1.3

import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64");
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Generate a UUIDv7-shaped id, base32-encoded for URL-safe display.
 * Not strictly UUIDv7 (we skip the variant bits) — close enough for
 * our use as a workbook identifier.
 */
function newWorkbookId() {
  const ts = Date.now();
  const rand = new Uint8Array(10);
  webcrypto.getRandomValues(rand);
  const bytes = new Uint8Array(16);
  bytes[0] = (ts >>> 40) & 0xff;
  bytes[1] = (ts >>> 32) & 0xff;
  bytes[2] = (ts >>> 24) & 0xff;
  bytes[3] = (ts >>> 16) & 0xff;
  bytes[4] = (ts >>> 8) & 0xff;
  bytes[5] = ts & 0xff;
  for (let i = 0; i < 10; i++) bytes[6 + i] = rand[i];
  return bytesToBase64Url(bytes);
}

/**
 * Canonical-JSON hash of the policy. Stable across implementations
 * because we sort keys and use compact separators. Used as both the
 * value of wb-policy-hash and the AD-binding for AES-GCM.
 */
async function hashPolicy(policy) {
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());
  const bytes = new TextEncoder().encode(canonical);
  const digest = await subtle.digest("SHA-256", bytes);
  return "sha256:" + Buffer.from(digest).toString("hex");
}

function buildAd({ workbookId, viewId, policyHash }) {
  return new TextEncoder().encode(
    `studio-v1|${workbookId}|${viewId}|${policyHash}`,
  );
}

/**
 * Encrypt one view payload under a freshly-generated DEK.
 *
 * Returns:
 *   { dek: Uint8Array(32), iv: Uint8Array(12), ciphertext: Uint8Array,
 *     mac: Uint8Array(16) }
 *
 * In WebCrypto, GCM returns ciphertext||tag concatenated. We split so
 * the envelope can carry the MAC separately (improves inspectability;
 * decryptor reassembles before calling decrypt).
 */
async function encryptView({ plaintext, workbookId, viewId, policyHash }) {
  const dek = new Uint8Array(32);
  webcrypto.getRandomValues(dek);
  const iv = new Uint8Array(12);
  webcrypto.getRandomValues(iv);

  const key = await subtle.importKey(
    "raw",
    dek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ad = buildAd({ workbookId, viewId, policyHash });
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  // GCM returns ct||tag. Split.
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const mac = sealed.slice(sealed.length - 16);
  return { dek, iv, ciphertext, mac };
}

/**
 * Decrypt one view payload given its DEK and the envelope metadata.
 * Used by `workbook unseal` for testing — bypasses the broker entirely.
 */
export async function decryptView({
  dek,
  iv,
  ciphertext,
  mac,
  workbookId,
  viewId,
  policyHash,
}) {
  const key = await subtle.importKey(
    "raw",
    dek,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const ad = buildAd({ workbookId, viewId, policyHash });
  const sealed = new Uint8Array(ciphertext.length + mac.length);
  sealed.set(ciphertext, 0);
  sealed.set(mac, ciphertext.length);
  const pt = new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
      key,
      sealed,
    ),
  );
  return pt;
}

/** Lock screen template. The decryptor placeholder runs in the browser
 *  fallback path (no daemon installed). Daemons parse meta tags
 *  directly and never render this UI.
 *
 *  Kept lean — CSP restricts to self only; no external resources. */
const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="wb-encryption" content="studio-v1">
<meta name="wb-workbook-id" content="%%WORKBOOK_ID%%">
<meta name="wb-broker-url" content="%%BROKER_URL%%">
<meta name="wb-policy-hash" content="%%POLICY_HASH%%">
<meta name="wb-cipher" content="aes-256-gcm">
<meta name="wb-views" content='%%VIEWS_JSON%%'>
<title>%%TITLE%%</title>
<style>
:root{--fg:#0f1115;--fg-soft:#4b5160;--fg-mute:#8a909c;--bg:#fbfbf9;--rule:#e7e6e2;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--serif:"Iowan Old Style","Charter","Source Serif Pro",Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:380px;width:100%;padding:32px}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--fg-mute);margin:0 0 12px}
h1{font-family:var(--serif);font-size:28px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px;line-height:1.15}
.lede{color:var(--fg-soft);font-size:13px;line-height:1.55;margin:0 0 24px}
button{padding:10px 16px;background:var(--fg);color:#fff;border:0;border-radius:6px;font-size:13px;font-weight:500;letter-spacing:.02em;cursor:pointer;width:100%}
button:hover{background:#1a1d24}
.foot{margin-top:24px;font-size:11px;color:var(--fg-mute);font-family:var(--mono);letter-spacing:.02em}
</style>
</head>
<body>
<main>
<p class="kicker">workbooks studio · sealed</p>
<h1>%%TITLE%%</h1>
<p class="lede">This workbook is sealed. Sign in to your organization to unlock — decryption happens after identity is verified by the broker.</p>
<button id="wb-signin">Sign in</button>
<p class="foot">studio-v1 · aes-256-gcm</p>
</main>
<script type="application/octet-stream" id="wb-payload">%%PAYLOAD_B64%%</script>
<script type="module">
// Browser fallback decryptor. Daemons bypass this entirely — they parse
// the meta tags above and run the broker auth flow themselves. This
// path is for users who open the file in a browser without workbooksd
// installed; full implementation lands in C3 (hosted recipient flow).
const btn = document.getElementById("wb-signin");
btn.addEventListener("click", () => {
  const broker = document.querySelector('meta[name="wb-broker-url"]').content;
  const id = document.querySelector('meta[name="wb-workbook-id"]').content;
  const ret = encodeURIComponent(location.href);
  location.href = broker + "/v1/auth/start?workbook_id=" + id + "&return_to=" + ret;
});
</script>
</body>
</html>
`;

/**
 * Wrap a workbook HTML body into a studio-v1 envelope.
 *
 * Inputs:
 *   html        — utf-8 string, the cleartext workbook to seal
 *   brokerUrl   — absolute https URL of the broker
 *   policy      — policy object; will be canonicalized + hashed
 *   title       — optional title shown on the lock screen
 *   workbookId  — optional explicit id (default: fresh UUIDv7-shape)
 *
 * Output:
 *   { html, workbookId, policyHash, views: [{id, dek (base64url)}] }
 *
 * The caller is responsible for registering each (workbookId, viewId,
 * dek) tuple with the broker via POST /v1/workbooks/:id/views/:view_id/key
 * before distributing the sealed file. The DEK never persists on disk
 * outside this function's return value — once registered, the caller
 * should drop it.
 */
/**
 * Wrap one or more workbook view payloads into a single studio-v1
 * envelope.
 *
 * Two input shapes accepted (C2 multi-view):
 *
 *   1. Single view (legacy / C1 shape):
 *        wrapStudio({ html: "...", policy, ... })
 *      Wraps a single view with id="default". Equivalent to passing
 *      `{ views: { default: html } }`.
 *
 *   2. Multi-view (C2):
 *        wrapStudio({ views: { full: htmlA, redacted: htmlB }, policy, ... })
 *      Each view is encrypted under its own freshly-generated DEK.
 *      The policy.views object should enumerate the same view ids
 *      (one per content variant the author wants to gate
 *      independently). Recipients unlock only the views their policy
 *      claims permit; the rest stay encrypted in the payload.
 *
 * Per-view ciphertext is concatenated into a single payload blob; the
 * `wb-views` meta tag carries (offset, len) descriptors so the
 * daemon / browser fallback can extract each view's bytes.
 *
 * Author responsibilities: register each (workbookId, viewId, dek)
 * tuple with the broker via POST /v1/workbooks/:id/views/:view_id/key
 * before distributing the sealed file. DEKs never persist outside
 * this function's return value — drop them after registration.
 */
export async function wrapStudio({
  html,
  views,
  brokerUrl,
  policy,
  title = "Sealed workbook",
  workbookId = newWorkbookId(),
}) {
  if (typeof brokerUrl !== "string" || !brokerUrl.startsWith("https://")) {
    throw new Error("wrapStudio: brokerUrl must be an https:// URL");
  }
  if (!policy || typeof policy !== "object") {
    throw new Error("wrapStudio: policy must be an object");
  }

  // Normalize the two input shapes into a single map of viewId →
  // utf8 bytes. Single-view path stays C1-compatible.
  let viewMap;
  if (views !== undefined) {
    if (typeof views !== "object" || views === null || Array.isArray(views)) {
      throw new Error("wrapStudio: views must be an object map of viewId → html string");
    }
    if (Object.keys(views).length === 0) {
      throw new Error("wrapStudio: views map cannot be empty");
    }
    viewMap = {};
    for (const [id, body] of Object.entries(views)) {
      if (typeof body !== "string" || body.length === 0) {
        throw new Error(`wrapStudio: views.${id} must be a non-empty string`);
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new Error(
          `wrapStudio: view id ${JSON.stringify(id)} must be 1–64 chars [A-Za-z0-9_-]`,
        );
      }
      viewMap[id] = new TextEncoder().encode(body);
    }
  } else {
    if (typeof html !== "string" || html.length === 0) {
      throw new Error("wrapStudio: html must be a non-empty string when views is not provided");
    }
    viewMap = { default: new TextEncoder().encode(html) };
  }

  // Cross-check: when the policy enumerates views, the author MUST
  // provide content for every view listed (or skip the policy.views
  // listing entirely if all views share the same gating). This catches
  // the easy mistake of "I declared a `redacted` view in policy but
  // forgot to provide its content," which would otherwise silently
  // ship a workbook where the redacted view is missing.
  if (policy.views && typeof policy.views === "object") {
    for (const viewId of Object.keys(policy.views)) {
      if (!(viewId in viewMap)) {
        throw new Error(
          `wrapStudio: policy.views.${viewId} declared but no content provided for that view`,
        );
      }
    }
  }

  const policyHash = await hashPolicy(policy);
  const viewIds = Object.keys(viewMap);

  // Encrypt each view under its own DEK. We assemble the payload by
  // concatenating ciphertexts in the order the author passed them;
  // the descriptor records each view's offset+len so the parser can
  // slice cleanly without depending on order.
  const viewsDescriptor = [];
  const dekRecords = [];
  const ciphertextChunks = [];
  let offset = 0;
  for (const viewId of viewIds) {
    const plaintext = viewMap[viewId];
    const { dek, iv, ciphertext, mac } = await encryptView({
      plaintext,
      workbookId,
      viewId,
      policyHash,
    });
    viewsDescriptor.push({
      id: viewId,
      iv: bytesToBase64Url(iv),
      offset,
      len: ciphertext.length,
      mac: bytesToBase64Url(mac),
    });
    dekRecords.push({ id: viewId, dek: bytesToBase64Url(dek) });
    ciphertextChunks.push(ciphertext);
    offset += ciphertext.length;
  }

  // Concatenate.
  const payloadBytes = new Uint8Array(offset);
  let writePos = 0;
  for (const chunk of ciphertextChunks) {
    payloadBytes.set(chunk, writePos);
    writePos += chunk.length;
  }
  const payloadB64 = bytesToBase64(payloadBytes);

  const out = SHELL.replace(/%%TITLE%%/g, htmlEscape(title))
    .replace(/%%WORKBOOK_ID%%/g, htmlEscape(workbookId))
    .replace(/%%BROKER_URL%%/g, htmlEscape(brokerUrl))
    .replace(/%%POLICY_HASH%%/g, htmlEscape(policyHash))
    .replace(/%%VIEWS_JSON%%/g, htmlEscape(JSON.stringify(viewsDescriptor)))
    .replace(/%%PAYLOAD_B64%%/g, payloadB64);

  return {
    html: out,
    workbookId,
    policyHash,
    views: dekRecords,
  };
}

/**
 * Parse an envelope's meta tags and view descriptors out of an HTML
 * string. Returns null if the file isn't a studio-v1 envelope.
 */
export function parseEnvelope(html) {
  const meta = (name) => {
    const m = new RegExp(
      `<meta\\s+name=["']${name}["']\\s+content=(['"])(.+?)\\1`,
      "i",
    ).exec(html);
    return m ? m[2] : null;
  };
  const encryption = meta("wb-encryption");
  if (encryption !== "studio-v1") return null;
  const workbookId = meta("wb-workbook-id");
  const brokerUrl = meta("wb-broker-url");
  const policyHash = meta("wb-policy-hash");
  const cipher = meta("wb-cipher");
  const viewsRaw = meta("wb-views");
  if (!workbookId || !brokerUrl || !policyHash || !cipher || !viewsRaw) {
    return null;
  }
  let views;
  try {
    views = JSON.parse(viewsRaw.replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  } catch {
    return null;
  }
  const payloadMatch =
    /<script[^>]*id=["']wb-payload["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const payloadB64 = payloadMatch ? payloadMatch[1].trim() : null;
  return {
    encryption,
    workbookId,
    brokerUrl,
    policyHash,
    cipher,
    views,
    payloadB64,
  };
}

/** Helper for the inspect / unseal commands — decode the base64 payload
 *  back to bytes. */
export function decodePayload(payloadB64) {
  return new Uint8Array(Buffer.from(payloadB64, "base64"));
}

export { bytesToBase64Url, base64UrlToBytes, hashPolicy };
