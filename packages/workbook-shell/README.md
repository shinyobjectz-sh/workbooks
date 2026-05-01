# @work.books/shell

The Workbooks PWA shell. Registered with the OS as the default handler for `.workbook.html` files. When a user double-clicks a workbook file, the OS routes the open to this PWA, which loads the workbook's HTML and hands it the file's `FileSystemFileHandle` for silent autosave (via the substrate's T2 transport).

## What this is

A static, ~50 KB shell consisting of:
- `public/manifest.json` — declares the PWA, including the `file_handlers` entry that registers `.workbook.html` association
- `public/sw.js` — service worker that caches the shell assets so the PWA boots offline and supports `start_url` after install
- `public/index.html` — the boot page; subscribes to `launchQueue.setConsumer`, receives file handles when the OS launches the PWA via a file association, hands the handle to the workbook's runtime via `window.__wbInbound`

## What this is not

- Not a host for user data. The PWA never stores user state.
- Not a network app. After install + first cache, the shell runs entirely offline.
- Not specific to any single workbook. Color.wave, stocks, chess, anything built with the workbook substrate — all open through this same shell.

## Hosting

The shell needs an HTTPS origin. Pick one (e.g. `workbooks.run`, `workbooks.colorwave.ai`, etc.) and serve `public/` as static assets. The exact origin doesn't change the shell's behavior — but it DOES become the PWA's identity once users install it. Choose carefully (you cannot easily migrate installed PWAs to a new origin).

**This is a product/ops decision blocked on user input** — see `bd show core-1ja.10` for the deployment plan once a domain is selected.

For local development:

```sh
cd vendor/workbooks/packages/workbook-shell
npm run preview   # serves on http://localhost:5174
```

Then test workbooks against `http://localhost:5174/` — install via Chrome's "Install Workbooks" button in the URL bar, double-click a `.workbook.html` file with the OS file association (manual step on macOS: right-click → Get Info → Open With → choose Chrome).

## Boot flow

1. User launches `colorwave.workbook.html` from their file manager.
2. OS's file association dispatch finds Workbooks PWA registered for `.workbook.html`; routes the open to the PWA.
3. PWA's `index.html` runs in standalone mode.
4. `launchQueue.setConsumer` fires with `params.files[0]` = a `FileSystemFileHandle` for the launched file.
5. PWA reads the file's bytes (`handle.getFile().text()`), exposes the handle via `window.__wbInbound`, then `document.write`s the workbook's HTML.
6. Workbook's bootstrapper finds `window.__wbInbound`, passes it to substrate's `negotiate()`, which constructs a `PwaFsaTransport` (T2) wrapping the handle.
7. From there: every Y.Doc / SQLite mutation flows through the substrate WAL → debounced commitPatch → `handle.createWritable()` → silent rewrite back to the user's file.

## File handler registration on each platform

- **macOS / Windows**: Chromium-based browsers register the file_handler when the PWA is installed. macOS Finder and Windows Explorer pick it up via standard file-association APIs; users may need to manually choose the PWA on first open.
- **Linux**: Same mechanism via `xdg-mime`.
- **iOS**: PWA file handlers are not yet supported. Workbooks open via download / Safari, falling back to T4 (OPFS shadow + download).
- **Android Chrome**: file_handlers ARE supported; works similarly to desktop Chromium.

## Future work

- Polyfill / older-browser fallback for `launchQueue` (currently fails silently if the API is missing — drops to T3 or T4 inside the workbook's own runtime).
- Eventual icon set + Open Graph tags for marketing context.

## Tickets

This shell implements `core-1ja.10`. Companion tickets:
- `core-1ja.11` — install banner inside each workbook (tells users in non-PWA contexts to install Workbooks).
- `core-1ja.12` — workbook CLI substrate emit (workbooks ship with the substrate runtime + the install banner baked in).
