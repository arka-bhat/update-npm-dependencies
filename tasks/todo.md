# Plan: dependency refresh + new features

Decisions so far:
- Minimum VS Code (`engines.vscode`) → `^1.123.0`, the first release whose built-in Node (24.15) meets npm-check-updates 23's requirement.
- Build every feature, one at a time. Stop after each for review; commit only when asked.
- Work on a branch, not `main`.

Each step's verification: `npm run compile`, `npm run lint`, `npm test`, plus the manual checks listed. Picker UI checks need a real VS Code window (F5 → Extension Development Host).

---

## 0. Dependencies and security
- [x] `engines.vscode` and `@types/vscode` → `^1.123.0`
- [x] Update every other package to latest, except `typescript` → `~6.0.3` (7.x ships no programmatic API; ts-loader and typescript-eslint can't load it)
- [x] Remove `@types/semver` (unused)
- [x] npm-check-updates 20 → 23 is ESM-only: `tsconfig` `module` → `node20` (allows `require()` of ESM)
- [x] `npm audit` reports 0 vulnerabilities (was 17). Last 4 came from mocha 11 inside `@vscode/test-cli`; fixed with an npm `overrides` entry forcing mocha 12
- [x] `npm test` passes inside VS Code 1.142 with mocha 12
- Note: webpack warns about `createRequire().resolve` inside ncu; it only locates installed packages' `package.json` and works in a bundle. Covered by the bundle smoke test in step 2

## 1. Correct `package.json` writes (bug fixes)
- [x] Let npm-check-updates write the file (`upgrade: true, filter: selected`) and delete the `JSON.stringify` write loop
- Fixes: formatting (tabs, one-line objects, final newline) being rewritten; `packageManager` and `optionalDependencies` updates being silently dropped
- [x] Test: fixture with tabs + `packageManager` + `optionalDependencies` round-trips correctly (offline, via `registryType: "json"`)
- [x] Found by the new bundle test: webpack can't bundle ncu 23 (its pre-bundled chunks import each other in a cycle → `... is not a function` at runtime). ncu is now a webpack external shipped in the VSIX (no runtime deps; only its `.js` files are packaged)
- [x] `tasks/` and `PLAN.md` excluded from the VSIX
- Logic not tied to VS Code moved to `src/deps.ts`

## 2. 0.x version classification + real tests
- [x] Classify by caret-range rules: an update outside `^current` is major (`0.3 → 0.4` and `0.0.3 → 0.0.4` are major)
- [x] Replace the sample test with tests for classification (grouping tests come with step 3, where grouping logic changes)

## 3. Toolchain group
- [x] `packageManager` update shown in its own "Toolchain" group at the top, not covered by the Select-all toggles (current version read past any corepack `+sha512…` suffix)
- [x] When mise is detected: tools pinned in the project's own mise config with a newer release (`mise outdated --bump --json`) join the Toolchain group; global mise config is ignored. Applied with `mise upgrade --bump <tools>` before the install, so the install uses the new versions
- [x] A failed update or install restores `package.json` and the touched mise config files
- [x] Tests: mise output parsing, picker grouping, corepack hash. Verified against real mise (dry run) on a scratch project
- Known: corepack's `+sha512…` hash is dropped on update

## 4. Cooldown
- [x] Setting `updateDependencies.cooldown` (e.g. `"7d"`, `"12h"`; plain number = days), off by default
- [x] Picker prompt shows when cooldown is on
- [x] Confirmed: when unset, ncu reads npm `min-release-age` (.npmrc), yarn `npmMinimalAgeGate` (.yarnrc.yml), pnpm `minimumReleaseAge` (pnpm-workspace.yaml). Bun has no equivalent
- [x] Live check against npm: 36500-day cooldown → no update; none / 7d → update

## 5. Settings: target, ignore list, peer
- [x] Settings `updateDependencies.target` (latest / minor / patch), `.reject` (names, wildcards, /regex/), `.peer`
- [x] Respect a project's `.ncurc.json` / JSON `.ncurc` (re-tested on v23: ncu only reads rc files from code in `deep` mode). Project rc wins per key
- [x] Same options used for the check and the write, so the written version matches the one shown

## 6. Link button per row
- [x] Button opens `npmjs.com/package/<name>?activeTab=versions` (npm rows and the packageManager row; not mise tools)
- [x] `ignoreFocusOut = true` so the picker stays open and keeps selections
- [ ] Manual (F5): click link → browser opens → picker still open with same checkboxes

## 7. Multi-root and monorepo
- [x] More than one workspace folder with `package.json` → choose folder first; skip when only one
- [ ] Manual (F5): multi-root workspace shows the project picker
- [x] Monorepo (`workspaces` field or `pnpm-workspace.yaml`) → one picker covering all packages, one row per dependency name listing its packages (`root, packages/a`); differing current ranges shown together, most severe bump wins
- [x] Applying a row updates the dependency in every package that uses it, plus pnpm catalogs (`pnpm-workspace.yaml`, formatting kept); one install at the root
- [x] Each update lists the files it changes, so rollback restores exactly those (package files, catalog, mise config)
- Known: ncu only reads `pnpm-workspace.yaml` when it detects pnpm (from `pnpm-lock.yaml`); yarn/bun catalogs not covered

## 8. Check after updating
- [x] After a successful install, if a real `test` script exists (not npm's "no test specified" placeholder): offer [Run test] [Skip]. Runs `<pm> run test` (`bun test` would start Bun's own runner instead)
- [x] If tests fail: offer [Revert] [Keep]; revert restores every changed file plus the lockfile, then reinstalls
- [x] Lockfiles are now part of every rollback, saved as bytes (`bun.lockb` is binary); tested
- [ ] Manual (F5): project with a failing test script → Revert restores files and reinstalls

## 9. Status bar + inline hints
- [ ] Status bar "N outdated" (click opens the picker); refreshed on activation and on `package.json` save, results cached
- [ ] Faded inline text after outdated lines in `package.json`: `→ ^10.13.0 · minor`
- [ ] Setting to turn off background checks (they hit the network)

## 10. Docs and release
- [ ] README, CHANGELOG, version bump

---

## Review
_(filled in as steps complete)_
