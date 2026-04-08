# Changelog

All notable changes to the "update-npm-dependencies" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-08

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
