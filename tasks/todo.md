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
- [ ] `packageManager` update shown in its own "Toolchain" group at the top, not covered by the Select-all toggles
- [ ] When mise is detected: add outdated mise tools (`mise outdated --json`) to the same group; apply with mise's own bump command (confirm exact command while building)
- Known: corepack's `+sha512…` hash is dropped on update

## 4. Cooldown
- [ ] Setting `cooldown` (e.g. `"7d"`, `"12h"`), off by default
- [ ] Picker prompt shows when cooldown is on
- Note: npm-check-updates also picks up an existing pnpm `minimumReleaseAge` / npm `min-release-age` / bun `npmMinimalAgeGate` automatically; confirm while building

## 5. Settings: target, ignore list, peer
- [ ] Settings `target` (latest / minor / patch), `reject` (packages to ignore), `peer` (only peer-compatible versions)
- [ ] Respect a project's `.ncurc.json` (the library ignores it when called from code; re-test on v23)

## 6. Link button per row
- [ ] Button opens `npmjs.com/package/<name>?activeTab=versions`
- [ ] `ignoreFocusOut = true` so the picker stays open and keeps selections
- Manual: click link → browser opens → picker still open with same checkboxes

## 7. Multi-root and monorepo
- [ ] More than one workspace folder with `package.json` → choose folder first; skip when only one
- [ ] Monorepo (`workspaces` field or `pnpm-workspace.yaml`) → one picker covering all packages, same dependency merged into one row listing its packages
- [ ] Writes go to each affected `package.json`; one install at the root

## 8. Check after updating
- [ ] After a successful install, if a `test` script exists: offer [Run test] [Skip]
- [ ] If tests fail: offer [Revert] [Keep]; revert restores `package.json` file(s) and the lockfile, then reinstalls

## 9. Status bar + inline hints
- [ ] Status bar "N outdated" (click opens the picker); refreshed on activation and on `package.json` save, results cached
- [ ] Faded inline text after outdated lines in `package.json`: `→ ^10.13.0 · minor`
- [ ] Setting to turn off background checks (they hit the network)

## 10. Docs and release
- [ ] README, CHANGELOG, version bump

---

## Review
_(filled in as steps complete)_
