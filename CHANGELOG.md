# Changelog

All notable changes to the "update-npm-dependencies" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - Unreleased

### Added

- **Toolchain group** — a newer package manager version for the `packageManager` field, and newer tools pinned in the project's mise config (applied with `mise upgrade --bump`), are listed in their own group at the top of the picker
- **Monorepo support** — npm, yarn, bun and pnpm workspaces are checked as a whole, including pnpm catalogs; a dependency used in several packages appears once and is updated everywhere
- **Several projects in one window** — with several workspace folders open, or one folder holding several projects in subfolders, you choose which project to check; a Back button in the dependency picker returns to the project list
- **npm link button** on each picker row; the picker stays open while you browse
- **Settings** — `updateDependencies.cooldown` (skip freshly published versions), `.target` (latest / minor / patch), `.reject` (packages to ignore), `.peer` (peer-compatible versions only), `.backgroundCheck`
- A project `.ncurc.json` is read too
- Packages in pnpm's `updateConfig.ignoreDependencies` are never offered; exact-version pins go in a separate Pinned group, and packages forced by `overrides` / `resolutions` go in a separate Overridden group outside the Select-all toggles
- **Test after updating** — when a `test` script exists, offer to run it and revert if it fails
- **Status bar count and inline hints** for outdated dependencies, refreshed in the background

### Changed

- Requires VS Code 1.123 or later (was 1.100), for npm-check-updates 23
- `0.x` updates that semver treats as breaking (`0.3 → 0.4`, `0.0.3 → 0.0.4`) are now classified as major
- A failed update also restores the lockfile and any changed mise config, not just `package.json`
- All dependencies updated; `npm audit` reports no vulnerabilities

### Fixed

- `package.json` formatting is kept: tabs, one-line objects and the final newline were previously rewritten
- Selected `packageManager` and `optionalDependencies` updates were silently skipped while the install still reported success

## [2.0.0] - 2026-04-10

### Added

- **Multi-package-manager support** — auto-detects npm, yarn, pnpm, and bun via lockfile (with `packageManager` field fallback)
- **mise integration** — detects `mise.toml`, `.mise.toml`, `.tool-versions`, `tool-versions`, or a `mise/` directory; locates the `mise` binary via known filesystem paths before falling back to `which mise`, so it works correctly when VS Code is launched outside a terminal; install commands are prefixed with `mise exec --`
- **Grouped, color-coded picker** — outdated packages are separated into Patch / Minor / Major groups with colored icons (green / yellow / red); each group has a "Select all `patch`/`minor`/`major`" toggle that selects/deselects the whole group, and auto-checks when all packages in the group are individually selected
- **Live install output** — a dedicated "Update Dependencies" output panel streams the package manager's stdout/stderr in real time
- Version transition shown in picker description: `1.2.3 → 2.0.0 · MAJOR`
- Detected package manager shown in progress and success notifications

### Changed

- Install step simplified: writes target versions to `package.json` then runs `<pm> install` (previously ran `npm update <packages>`)
- Switched from `child_process.exec` to `child_process.spawn` for streaming output
- Extension and command renamed from "Update NPM Dependencies" to "Update Node/Bun Dependencies"
- `package.json` is restored to its original content if the install fails, preventing a partially-updated state

## [1.0.0] - 2024-11-20

### Added

- Initial release
- Scan `package.json` for outdated dependencies
- Interactive checklist to select packages to upgrade
- Updates selected versions in `package.json` and runs `npm update`
- Progress indicators for checking and applying updates
- Command Palette integration
