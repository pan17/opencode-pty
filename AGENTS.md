# AGENTS.md

> Compact instruction file for future OpenCode sessions working in this repo.
> Every line answers: "Would an agent miss this without help?" If not, omit.

## Identity (read first)

- This is **`@panpan2026/opencode-pty` 0.4.0** — a Node ESM fork of [shekohex/opencode-pty](https://github.com/shekohex/opencode-pty) for OpenCode 1.4+.
- Two remotes: `origin` → `https://github.com/pan17/opencode-pty` (this fork), `upstream` → `shekohex/opencode-pty`.
- License: MIT (inherited from upstream). Attribution to shekohex is in `package.json#contributors` and `README.md` fork notice.
- No `CHANGELOG.md`, no `AGENTS.md` was here before. Release notes are auto-generated from `git log`.

## Quick commands

| Task | Command |
|---|---|
| Install deps | `bun install` (NEVER `npm install` — `bun.lock` is the source of truth) |
| Lint | `bun run lint` (`biome lint .` — strict, single quotes, no semis, 2-space, 100 col) |
| Lint + autofix | `bun run lint:fix` then `bun run format:fix` |
| Typecheck | `bun run typecheck` |
| Unit tests | `bun run unittest` (4 bash-on-Windows tests fail by design — skip) |
| Build plugin only (fast) | `bun run build:plugin` |
| Build full (plugin + web client) | `bun run build:dev` or `bun run build:prod` |
| Build → publish (auto on `npm publish`) | `prepack` runs `bun build:prod` |
| Local install for OpenCode | Put `"plugin": ["file:///<ABS>/opencode-pty/index.ts"]` in `opencode.json` |

## Architecture

- `index.ts` → exports `PTYPlugin` from `src/plugin.ts` (OpenCode plugin entrypoint)
- `src/plugin/pty/` — core PTY management: `manager.ts` (orchestrator), `session-lifecycle.ts` (PTY spawn/exit), `output-manager.ts` (read/write), `notification-manager.ts` (notifyOnExit), `buffer.ts` (ring buffer), `tools/` (5 tool implementations: spawn/write/read/list/kill)
- `src/web/server/` — Node `http` + `ws` server (NOT Bun.serve). Handlers in `handlers/`. `server.ts` owns both the HTTP server and the WS upgrade.
- `src/web/client/` — React + Vite frontend
- `test/` — unit + integration; `test/e2e/` — Playwright e2e (heavy, runs in CI only)
- `scripts/` — one-off migration helpers, kept for reproducibility (`inline-txt-descriptions.mjs`, `add-ts-extensions.mjs`). `fix-typo.mjs` is a no-op leftover, ignore.

## Conventions (would otherwise guess wrong)

- **TypeScript**: `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noUnusedLocals/Parameters: true`, `verbatimModuleSyntax: true`. Write defensive code (`arr[i]?.foo` or explicit length check, not `arr[i].foo`).
- **Relative imports use `.ts` extension in source**. Build's `rewriteRelativeImportExtensions: true` emits `.js` in dist. Never write `.js` in source.
- **No `as any`, no `@ts-ignore`, no `@ts-expect-error`**. Lint config + tsc will fail.
- **Biome** formats + lints together. Don't use Prettier or ESLint. `bun run lint:fix` covers most issues.
- **Tool descriptions live in `*-description.ts` files** (Node ESM can't `import str from './x.txt'`). When adding a new tool, create the description file + update imports in the same commit.
- **`pty_*` tool descriptions go to the LLM** — keep them clear, concrete, and include the Windows PATHEXT note in `spawn-description.ts` (the LLM often writes `command="npm"` and the call fails silently without the note).

## Windows PATHEXT gotcha (silent failure!)

`@lydell/node-pty` calls `CreateProcessW` with the literal command name and does **not** do PATHEXT extension resolution. So:

- `command="ping"` → fails with "File not found" ❌
- `command="ping.exe"` → works ✅
- `command="npm"` → fails ❌
- `command="npm.cmd"` → works ✅
- `command="cmd.exe"` → works ✅ (always use this for shell metacharacters)

Documented in `spawn-description.ts` "Platform notes (Windows)". Do NOT add a `cwd` workaround — the user has to write the right extension.

## Build & test pitfalls

- **`bun run build:dev` deletes `dist/` first** (calls `bun clean`). Don't be alarmed when your manual edits to dist disappear.
- **`.txt` files in src/ are copied to dist/ by `bun x copyfiles`** (in `build:plugin`). The plugin still references them at runtime. If you add a new `.txt` file, it auto-copies.
- **4 pre-existing test failures on Windows** (Windows env limitation, not real bugs): `pty-echo.test.ts`, `pty-spawn-echo.test.ts`, `spawn-repeat.test.ts`, `integration.test.ts` spawn `bash`/`cat`/`echo` which aren't on Windows PATH. They pass on Linux/macOS. Don't fix them — leave a comment if you must.
- **e2e tests need Playwright browsers**: `bunx playwright install --with-deps` before running locally. CI does this automatically.
- **`engines.node: ">=22.0.0"`** is required for `import.meta.dirname` used in the web server. Don't try to support Node 20 or earlier.

## Release workflow (CI auto-publishes)

- `.github/workflows/release.yml` is `workflow_run` triggered on CI success.
- It auto-detects `package.json` version bump vs `HEAD^`. **No change → no publish. Tag exists → skip.**
- To publish: `npm version patch|minor|major` + `git push origin main`. CI does the rest.
- Tag push is NOT the trigger (unlike most projects). `git push origin --tags` is harmless but unnecessary.
- One-time setup: `NPM_TOKEN` secret on GitHub (Automation-type npm token). See `PUBLISH.md`.

## Sync with upstream

```bash
git fetch upstream
git log upstream/main..HEAD    # local-only commits
git merge upstream/main         # or rebase
# resolve conflicts → bun run lint + test + build:dev → commit + push
```

Upstream may rename packages back, add Bun-specific features, or break the Node ESM port. Resolve in favor of the fork (`@panpan2026/opencode-pty`, Node 22+, `@lydell/node-pty`) and keep a clean history.

## Don't do

- Don't add `.txt` files for tool descriptions — they break Node ESM imports. Use `.ts`.
- Don't add `bun:` or `bun-*` imports — the plugin is Node ESM only now.
- Don't use `npm install` or `yarn` — `bun.lock` is canonical.
- Don't fix the 4 bash-on-Windows test failures (env limitation, pre-existing).
- Don't manually edit `dist/` — it gets regenerated on build. Edit source.
- Don't push to `upstream` — only `origin` (this fork) and your own branches.
