# Update Dependencies

## Overview

**Update Dependencies** is a Visual Studio Code extension for selectively upgrading packages in Node.js projects. It detects your package manager automatically, shows outdated packages grouped and color-coded by risk, and runs the install for you — all from the Command Palette.

## Features

- **Auto-detects your package manager** — supports npm, yarn, pnpm, and bun (lockfile-based detection with `packageManager` field fallback)
- **mise support** — if your project uses [mise](https://mise.jdx.dev/) (`mise.toml`, `.mise.toml`, `.tool-versions`, `tool-versions`, or a `mise/` directory), commands are automatically prefixed with `mise exec --`
- **Color-coded, grouped picker** — outdated packages are sorted by upgrade risk, separated into groups with a "Select all `patch`/`minor`/`major`" toggle at the top of each:
    - Patch (green) — safe, bug fixes
    - Minor (yellow) — new features, backwards-compatible
    - Major (red) — breaking changes
- **Live install output** — an "Update Dependencies" output panel shows the package manager's output in real time
- **Selective updates** — pick exactly which packages to upgrade; `package.json` is updated and the install runs only for your selection

## How It Works

1. Open a Node.js project in VS Code containing a `package.json`.
2. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux).
3. Run **Update Dependencies**.
4. The extension checks for outdated packages and shows a grouped, color-coded picker.
5. Select the packages you want to upgrade and confirm.
6. `package.json` is updated and your package manager installs the new versions.

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

The `mise` binary is located by checking common install paths (`~/.local/bin/mise`, `/opt/homebrew/bin/mise`, `/usr/local/bin/mise`) before falling back to `which mise`, so this works correctly even when VS Code is launched outside of a terminal.

## Commands

**Update Dependencies** (`update-npm-dependencies.updateDependencies`)

## Requirements

- A workspace with a `package.json` file
- Your package manager (`npm`, `yarn`, `pnpm`, or `bun`) accessible in your PATH

## Feedback and Contributions

Issues and pull requests welcome on [GitHub](https://github.com/arka-bhat/update-npm-dependencies).

## License

[MIT](LICENSE)
