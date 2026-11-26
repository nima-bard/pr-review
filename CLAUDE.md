# PR Review

A macOS Electron app for reviewing GitHub pull requests in a git worktree of a clone the user already has. README.md describes it for users; CHANGELOG.md lists what each release added.

## Commands

```sh
npm run dev              # the app, reloading as you edit
npm run typecheck        # tsconfig.node.json (main, preload, core, shared, tests) and tsconfig.web.json (renderer, shared)
npm test                 # vitest: test/**/*.test.ts
npm run e2e              # builds, then Playwright drives the built app against a mock GitHub (e2e/open-pr.spec.ts)
npm run eval -- owner/repo /path/to/clone   # how well comments are re-placed on real PR threads; report goes to eval/
npm run release:publish  # see README › Releasing: builds, then creates a draft GitHub release
```

A change is done when `npm run typecheck` and `npm test` pass. Run `npm run e2e` too when it touches sessions, IPC or the pull request view.

## Layout

- `src/core`: git, GitHub (GraphQL and REST), comment anchoring (`anchor/`), code search and the JSON stores. Plain Node with no Electron imports, unit-tested against real temporary git repositories (`test/helpers/gitRepo.ts`).
- `src/main`: the Electron main process.
  - `index.ts`: windows, menus, `prreview://` links and the host methods (dialogs, notifications, Finder).
  - `sessions.ts`: `SessionRegistry` holds the GitHub clients, settings, drafts and the quick-action runner, and implements the IPC `Api`.
  - `session.ts`: `PrSession`, one per open pull request. It prepares the worktree, refreshes (and checks GitHub every 45s), places threads, and runs the review and merge actions.
  - `quickActions.ts`: opening terminals, and the background runner.
- `src/preload`: exposes `window.api`, built from `API_METHODS`.
- `src/shared`: types (`model.ts`, `ipc.ts`) and pure logic used by both sides (`mergeRules`, `quickActions`, `triage`…). Both tsconfigs compile it, so it can use neither `node:` modules nor DOM APIs.
- `src/renderer`: the React 19 interface.
  - `state/`: zustand stores.
  - `views/newtab/`: the new-tab page, settings and worktrees.
  - `views/pr/`: the pull request view.
  - `diff/`: diff rendering with `@pierre/diffs`.
  - `dialogs/`: the merge, submit-review and versions dialogs.
  - `components/ui.tsx`: shared controls (Button, Badge, Segmented, Select, Skeleton, Spinner, `cx`).
- `browser-extension/`: the Chrome/Edge extension that opens GitHub pull request links in the app. It ships inside the app (`extraResources`) and as a zip on each release.
- `scripts/`: `release.mjs`, `eval-anchoring.ts` and the file-icons Vite plugin.

## Wiring

- **New IPC call:**
  1. Add the method to `Api` in `src/shared/ipc.ts` and its name to `API_METHODS`; `API_METHODS_COMPLETE` stops compiling if you forget.
  2. Implement it in the registry's api in `src/main/sessions.ts`, usually by calling the `PrSession`.
  3. Call `api.method()` from the renderer, and show errors with `errorText(err)`.
- **Main to renderer:** updates go out as a `PrEvent` on `pr:event`. A `PrSession` emits a `SessionEvent` without a key. The registry adds the key in `emitFor` and drops events from sessions that have since closed.
- **A new setting:** add the field to `Settings` in `src/shared/model.ts` and its default to `DEFAULT_SETTINGS` in `src/core/store/appState.ts`. Settings pages save as you change things (`useSettingsSaver` in `SettingsView.tsx`).

## Conventions

- **TypeScript:** strict, with `noUncheckedIndexedAccess`. No `any`.
- **Dependencies:** pinned to exact versions.
- **Comments:** short plain-English doc comments on exports and on anything non-obvious, saying what the code is for rather than restating it.
- **UI text:**
  - Plain and in sentence case, with "pull request" written out and typographic apostrophes and quotes (’ “ ”).
  - User-facing changes go in `CHANGELOG.md` under `## Unreleased` (fixes under `### Fixes`), written the same way. Releasing renames that section to the version.
- **Styling:**
  - Tailwind v4 with the theme tokens from `src/renderer/styles.css` (`bg-panel`, `bg-side`, `text-muted`, `text-strong`, `border-line`, `text-add`, `text-del`…), never raw colours.
  - Every theme in `themes.css` defines them, light and dark.
- **Icons:**
  - Octicons are copied as path data into `components/octicons.tsx`, from the version named at the top of that file.
  - File icons come from `material-icon-theme`.
- **Running commands:**
  - Use `execFile`/`spawn` with argument arrays, not command strings.
  - Quick actions get pull request details as environment variables, never substituted into the command text; `test/main/quickActions.test.ts` checks this with a hostile title.
- **GitHub writes:**
  - Mutations live in `src/core/github/prActions.ts`.
  - Merging passes `expectedHeadOid`, so it only merges the commit the user has seen.

## Running the app from scripts and tests

- Automated runs always set `PR_REVIEW_HIDDEN_WINDOWS=1`, which keeps windows off screen. Also set `PR_REVIEW_USER_DATA=<temp dir>` for a separate profile, which also stops the run from claiming `prreview://` links.
- `PR_REVIEW_API=<url>` and `PR_REVIEW_TOKEN=<token>` point the app at a mock GitHub, as the e2e test does. `PR_REVIEW_VERSION` pretends to be another version for the update check.
- A Playwright script outside `e2e/` has to sit inside the repo to resolve `@playwright/test`: build, copy it into `out/`, run it with `node`, then delete it.
- Tests must not open real terminals, browsers or iTerm2 windows.

## This repository is public

- Never commit names of private organizations or repositories, internal URLs, tokens or email addresses. Commits use the GitHub noreply address.
- `plan.md`, `research.md`, `eval/` and `CLAUDE.local.md` are gitignored working notes that may mention private repositories. Keep them out of commits.
