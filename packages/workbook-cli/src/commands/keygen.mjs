// `workbook keygen` — generate an Ed25519 author keypair for signing
// encrypted <wb-data> blocks. Outputs:
//
//   <out>.priv  — base64 of the 32-byte secret key (KEEP THIS SECRET)
//   <out>.pub   — base64 of the 32-byte public key (publish this)
//
// Usage:
//   workbook keygen --out keys/myauthor
//
// The .priv file is written 0600 (owner read/write only). Distribute
// the .pub via your normal channels (Git, signature footer, business
// card with QR — whatever). Hosts of the workbook pin the .pub
// content via createWorkbookDataResolver({ expectedAuthorPubkey }).
//
// Loss-of-priv = loss of ability to sign new encrypted blocks. Old
// signed blocks remain verifiable. To rotate, generate a new keypair
// and resign anything you still want to ship.

import { promises as fs } from "node:fs";
import path from "node:path";

export async function runKeygen(opts) {
  if (!opts.out) {
    throw new Error("missing --out <basename>");
  }
  const { generateKeypair } = await import("@work.books/runtime/signature");
  const { privateKey, publicKey } = generateKeypair();

  const privPath = `${opts.out}.priv`;
  const pubPath = `${opts.out}.pub`;
  await fs.mkdir(path.dirname(privPath), { recursive: true });

  // Write priv with restricted permissions. Use writeFile + chmod
  // separately for portability — `mode` arg to writeFile doesn't
  // strip existing file permissions on overwrite.
  await fs.writeFile(privPath, privateKey + "\n", "utf8");
  await fs.chmod(privPath, 0o600);
  await fs.writeFile(pubPath, publicKey + "\n", "utf8");
  await fs.chmod(pubPath, 0o644);

  process.stdout.write(
    `workbook keygen: wrote\n` +
      `  ${privPath}  (0600 — keep this secret)\n` +
      `  ${pubPath}   (0644 — publish or pin via expectedAuthorPubkey)\n` +
      `\n` +
      `pubkey: ${publicKey}\n`,
  );
}
