# @work.books/runner

The Workbook polyglot runner. Wraps a workbook's HTML payload in a single APE binary that runs natively on Linux / macOS / Windows / FreeBSD without installation.

## What it does

When the user double-clicks the produced binary:

1. Binds a random free port on `127.0.0.1`.
2. Spawns the user's default browser pointing at `http://127.0.0.1:<port>/`.
3. Serves the embedded workbook HTML on `GET /`.
4. Accepts state writes via `PUT /save`. (v0: writes a sibling file. v1: rewrites the binary's own data section.)
5. Exits when the browser closes / after an idle timeout / on `POST /_runner/shutdown`.

The resulting binary is one file. The user opens it once, accepts the OS Gatekeeper / SmartScreen warning, then every subsequent open is silent and edits save to the same file.

## Build

```sh
# 1. Get the cosmocc toolchain (one-time)
mkdir -p vendor/cosmocc
cd vendor/cosmocc
curl -sSL -O https://cosmo.zip/pub/cosmocc/cosmocc.zip
unzip cosmocc.zip

# 2. Build a workbook binary
cd vendor/workbooks/packages/workbook-runner
./scripts/build.sh path/to/input.workbook.html path/to/output-binary

# 3. Run it
chmod +x output-binary
./output-binary
```

The binary launches a localhost server, opens your default browser, serves the workbook. Try `curl http://localhost:<port>/_runner/info` to inspect runtime state, or `curl -X POST http://localhost:<port>/_runner/shutdown` to ask it to exit.

## Versions

- **v0 (this version):** localhost host + serve embedded HTML + PUT /save writes a sibling file. Validates the architecture without yet self-rewriting.
- **v1 (planned):** true self-rewrite via APE's appended-ZIP data section. The binary edits its own file in place; reopening shows the saved state.
- **v2 (planned):** WebSocket for real-time substrate transport status, multi-target persistence (composition + sql + assets), substrate-aware save merging.

## Per-platform notes

| Platform | Run | First-launch friction |
|---|---|---|
| **macOS** | `./binary` (CLI) or rename to `.app` | Gatekeeper "unidentified developer" — right-click → Open → confirm. Once. (Code signing reduces / eliminates this.) |
| **Windows** | Rename to `.com` or `.exe` then double-click | SmartScreen "Don't run" — More info → Run anyway. Once. |
| **Linux** | `chmod +x binary && ./binary` | None (Linux trusts file permissions). |
| **FreeBSD** | `chmod +x binary && ./binary` | None. |
| **Mobile (iOS/Android)** | Doesn't run — no native execution. | Use the `.workbook.html` fallback (substrate's T3/T4 transports). |

## Trust + signing

This runner is the foundation for the Workbooks signing pipeline (see `core-???.??`). Authors who want polished UX submit their workbook source to a registry; CI builds + signs the binary with the Workbooks signing key and publishes it to a community catalog. Authors who want full control build unsigned and distribute themselves — users see the Gatekeeper warning once per file.

## Next milestones

- [ ] Self-rewrite via APE-format ZIP appendage (v1)
- [ ] WebSocket layer for substrate transport status
- [ ] CI build/sign pipeline scaffold
- [ ] Mac `.app` wrapper output mode
- [ ] Windows `.exe` extension renaming convenience flag
