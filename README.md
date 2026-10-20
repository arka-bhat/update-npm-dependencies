# Update Node/Bun Dependencies

## Overview

**Update Node/Bun Dependencies** is a Visual Studio Code extension for selectively upgrading packages in Node.js and Bun projects. It detects your package manager automatically, shows outdated packages grouped and color-coded by risk, and runs the install for you — all from the Command Palette.

## Features

- **Auto-detects your package manager** — supports npm, yarn, pnpm, and bun (lockfile-based detection with `packageManager` field fallback)
- **Color-coded, grouped picker** — outdated packages are sorted by upgrade risk, separated into groups with a "Select all `patch`/`minor`/`major`" toggle at the top of each:
    - Patch (green) — safe, bug fixes
    - Minor (yellow) — new features, backwards-compatible
    - Major (red) — breaking changes, including `0.x` minor bumps (e.g. `0.3 → 0.4`), which semver treats as breaking
- **Toolchain updates** — a newer version of the package manager in your `packageManager` field, and newer tools pinned in your project's mise config, are listed in their own **Toolchain** group at the top
- **Pins and overrides** — exact versions (`"react": "19.2.0"`) are marked `pinned`, and packages forced by `overrides` / `resolutions` are marked `overridden to <version>`, since updating them alone changes nothing. Packages in pnpm's `updateConfig.ignoreDependencies` are never offered
- **Link to npm** — the button on each row opens the package's versions page on npm, where its repo and changelog are linked, without closing the picker
- **Your formatting is kept** — only the version strings change in `package.json`; indentation, layout and key order stay as they were
- **Monorepos** — npm, yarn, bun and pnpm workspaces are checked as a whole, including pnpm catalogs. A dependency used in several packages appears once and is updated everywhere
- **Several projects in one window** — with several workspace folders open, or one folder holding several projects (e.g. `api/` and `mobile/`, each with its own `package.json`), you choose which project to check, and the picker's Back button takes you to another one
- **Release cooldown** — optionally skip versions published in the last few days, a guard against freshly published compromised releases
- **Test after updating** — if your project has a `test` script, you're offered a test run; if it fails, one click reverts the update
- **Safe on failure** — if the update or install fails, every changed file (including the lockfile) is restored
- **Outdated count and hints** — the status bar shows how many updates are available, and outdated lines in `package.json` get a faded hint like `→ ^10.13.0 · minor`
- **Live install output** — an "Update Dependencies" output panel shows the package manager's output in real time

## How It Works

1. Open a Node.js project in VS Code containing a `package.json`.
2. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux) and run **Update Node/Bun Dependencies**, or click the outdated count in the status bar.
3. The extension checks for outdated packages and shows a grouped, color-coded picker.
4. Select the packages you want to upgrade and confirm.
5. The new versions are written and your package manager installs them.
6. If your project has a `test` script, choose whether to run it; if tests fail, you can revert.

## Settings

| Setting                              | Default   | Description                                                                                                                                                                                                                                 |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updateDependencies.cooldown`        | _(empty)_ | Skip versions published more recently than this, e.g. `7d`, `12h`, `30m` (a plain number means days). When empty, your package manager's own setting is used: npm `min-release-age`, yarn `npmMinimalAgeGate`, pnpm `minimumReleaseAge`. |
| `updateDependencies.target`          | `latest`  | `latest` offers every update, `minor` at most minor updates, `patch` patch updates only.                                                                                                                                                    |
| `updateDependencies.reject`          | `[]`      | Packages never offered for update. Accepts names, wildcards such as `@types/*`, or `/regex/`.                                                                                                                                               |
| `updateDependencies.peer`            | `false`   | Only offer versions compatible with the peer dependencies of your installed packages.                                                                                                                                                      |
| `updateDependencies.backgroundCheck` | `true`    | Check in the background on startup and when `package.json` is saved, for the status bar count and inline hints. Contacts the npm registry.                                                                                                   |

A project `.ncurc.json` (the [npm-check-updates](https://github.com/raineorshine/npm-check-updates) config file) is also read, and its options take precedence over these settings.

## Package Manager Detection

The extension checks for lockfiles in this order:

| Lockfile                                 | Package manager |
| ---------------------------------------- | --------------- |
| `bun.lockb` / `bun.lock`                 | bun             |
| `pnpm-lock.yaml`                         | pnpm            |
| `yarn.lock`                              | yarn            |
| `package-lock.json`                      | npm             |
| `packageManager` field in `package.json` | as specified    |
| _(none)_                                 | npm (default)   |

## mise Support

If any of `mise.toml`, `.mise.toml`, `.tool-versions`, `tool-versions`, or a `mise/` directory is present at the workspace root, all install commands are prefixed with `mise exec -- ` so the correct Node/Bun version is used.

Tools pinned in the project's mise config that have a newer release (for example `node = "20"` when Node 26 is out) appear in the **Toolchain** group. Selecting one runs `mise upgrade --bump` before the install, so the install already uses the new version. Your global mise config is never changed.

The `mise` binary is located by checking common install paths (`~/.local/bin/mise`, `/opt/homebrew/bin/mise`, `/usr/local/bin/mise`) before falling back to `which mise`, so this works correctly even when VS Code is launched outside of a terminal.

## Commands

**Update Node/Bun Dependencies** (`update-npm-dependencies.updateDependencies`)

## Requirements

- VS Code 1.123 or later
- A workspace with a `package.json` file
- Your package manager (`npm`, `yarn`, `pnpm`, or `bun`) accessible in your PATH

## Feedback and Contributions

Issues and pull requests welcome on [GitHub](https://github.com/arka-bhat/update-npm-dependencies).

## License

[MIT](LICENSE)
