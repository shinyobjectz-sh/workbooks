# Security model — `<wb-data encryption="age-v1">`

What's protected, what's not, and what hardens later phases close.

## What Phase A protects

The `age-v1` encryption tag uses [age](https://github.com/FiloSottile/age)'s
passphrase-recipient mode (`scrypt` for KDF + `ChaCha20-Poly1305` AEAD
in 64 KB chunks). Properties verified by the `security-test.mjs`
adversarial harness in this workspace:

- **Wrong passphrase rejected** — age's HMAC over the header fails;
  the chunk keys derived from `scrypt(wrong)` don't authenticate.
- **Tampered ciphertext rejected** — flipping ANY byte in the body
  fails ChaCha20-Poly1305's authentication tag on the affected chunk.
- **Truncation rejected** — chunks are framed; a missing tail fails
  the final-chunk marker check.
- **Header substitution rejected** — the per-chunk symmetric key
  derives from HKDF-Extract over the header HMAC. Substitute the
  header from another encryption (even with the same passphrase)
  and chunk decryption fails.
- **Trailing-byte injection rejected** — age stops at the EOF
  marker; trailing garbage after a valid stream is ignored, and
  decryption produces the original plaintext exactly.
- **Nonce uniqueness** — every encryption draws a fresh scrypt salt
  + nonce from CSPRNG. Identical plaintexts produce different
  ciphertexts; brute-forcing one ciphertext doesn't help with
  another.
- **Empty / zero-length payloads handled correctly** — sentinels
  in the framing.

The `sha256` attribute on the parent `<wb-data>` attests to the
**plaintext** (post-decrypt, pre-decompress). The resolver verifies
it after decryption — so a well-formed-but-wrong-content ciphertext
(e.g. an attacker substitutes their own age-encrypted payload that
happens to decrypt with the user's passphrase if they know it) is
still caught by sha256 mismatch.

## What Phase A does NOT protect

These are real attack surfaces that future phases close. List them
out so consumers can make informed decisions today.

### Plaintext lives in JS heap (Phase E closes)

After `decryptWithPassphrase` returns, plaintext bytes are a
`Uint8Array` in the JS engine's heap. They stay there until garbage
collection. Implications:

- A malicious cell that gets JS-execution privilege via XSS in the
  surrounding page can read it
- Browser extensions with content-script access can read it
- Crash dumps / memory snapshots can recover it
- DevTools "memory inspector" shows it trivially

**Phase E** (`#46`) swaps `typage` for `wage` (rage compiled to
WASM). With the Rust impl, plaintext stays inside WASM linear
memory, JS sees opaque handles, exfiltration requires a WASM-side
compromise rather than a JS-side one. This is the biggest
architectural delta between Phase A ("the data is encrypted at
rest in the file") and Phase E ("the data is encrypted at rest
AND isolated in memory while in use").

### Tamper-detection on `<wb-data>` attributes — **closed by Phase C**

age's auth tag protects ciphertext integrity but does NOT cover the
wrapping `<wb-data>` element's attributes. Phase C adds an Ed25519
signature over the canonical byte sequence:

```
wbdata-sig-v1
id=<id>
mime=<mime>
encryption=<encryption-tag>
sha256=<plaintext sha256>
<ciphertext bytes>
```

Tamper with any attribute (id, mime, encryption tag, sha256) OR
any ciphertext byte → signature fails on verify, decrypt is never
attempted. Surfaced via `pubkey="..."` and `sig="..."` attributes
on `<wb-data>`.

CLI: `workbook encrypt --sign-key-file authorpriv.key`. Generate
keypairs with `workbook keygen --out keys/myauthor`.

### Author-identity verification — **closed by Phase C** (with pinning)

Without pinning: signature proves "this block hasn't been tampered
after authoring" but NOT "the author is who you expect" — an
attacker can substitute their own (pubkey, sig) pair for a
different ciphertext.

With pinning: pass `expectedAuthorPubkey` to
`createWorkbookDataResolver`. The resolver checks the file's pubkey
against the pinned one BEFORE verifying the signature. Mismatch =
"this came from a different signer than expected" — even a valid
signature is rejected.

Phase C also adds `signaturePolicy: "require"` — block any
unsigned `<wb-data encryption=...>` from resolving. Useful in
production where every author is expected to sign.

### Passphrase strength is the user's problem

age's `scrypt` parameters are `N=2^18` work factor — moderate
GPU-resistant cost. A 6-character lowercase passphrase is brute-
forceable (~10⁹ attempts) by a well-resourced adversary in days.

The CLI (`workbook encrypt`) does not enforce passphrase complexity
today. Implementations should warn or require:

- **Min 14 chars** (or use a diceware-style passphrase generator
  like the example in age's docs: 6+ words, ~77 bits entropy)
- Reject obvious dictionary words

### Cached passphrase lives in resolver-instance scope

`createWorkbookDataResolver` caches the passphrase across blocks
in a closure variable. Implications:

- The cache survives until the resolver is GC'd — typically the
  lifetime of the page
- Calling `resolver.clear()` does NOT clear it (only clears the
  result cache). **TODO: add `forgetPassphrase()` API**.
- Any JS code with a reference to the resolver could in principle
  read the closure variable — JS doesn't enforce closure privacy
  cryptographically. (`getPassword` is a function expression but
  the `cachedPassword` variable lives in its enclosing scope.)
- A tab eviction / freeze / restore could re-prompt unexpectedly
  but not leak.

Mitigation in this phase: keep the cache only as long as needed.
**Phase E** moves the cache to WASM-side too.

### `requestPassword` race on concurrent block resolution

If two `<wb-data encryption="age-v1">` blocks resolve in parallel
and the cache is empty, both call `getPassword()` simultaneously.
Without dedup, both would invoke the host's `requestPassword`
callback — surfacing two prompts to the user.

**TODO: dedup `getPassword` via a single in-flight promise.**
Cheap fix; addressed in the next commit.

### Browser-platform residual risks

Out of our control but worth knowing:

- A malicious browser extension can read JS heap (Phase E mitigates
  by keeping plaintext in WASM)
- A keylogger captures the passphrase as the user types it
- A compromised browser process is game-over regardless
- File-system-level attackers (Spotlight, backup software, etc.)
  see the encrypted ciphertext but not the plaintext

### CLI-level residual risks

- `--password <s>` shows in `ps`. Use `--password-stdin` or
  `--password-file <path>` instead. CLI documents this.
- `--password-file` should be 600-permission'd — the CLI does NOT
  check today. **TODO: warn on world-readable.**
- Build pipelines that put the password in environment variables
  may leak it via process inspectors
- Source maps and build logs do not contain the password (the
  encrypted body lands in the output file, the password never
  touches the build pipeline beyond the CLI invocation)

## Future phases that close gaps

| Gap | Phase | Bead | Status |
|---|---|---|---|
| Plaintext in JS heap | E | `#46` | open |
| Attribute tamper detection | C | `#44` | **closed (Phase C shipped)** |
| Author identity verification | C | `#44` | **closed via expectedAuthorPubkey pinning** |
| WebAuthn / passkey unlock (replaces passphrase typing) | B | `#43` | open |
| Multi-recipient sharing (encrypt to colleague's pubkey) | D | `#45` | open |
| File-permission check on `--password-file` | A+ | — | open |
| Idle-timeout auto-forget passphrase | A+ | — | open |

## Verifying the property claims

```sh
# From the workbook root:
node --experimental-strip-types security-test.mjs
# Expected: 16 pass / 0 fail
```

The harness exercises every adversarial property documented above.
Run it after any change to `encryption.ts`.
