# Extension Modernization Plan

## Context
The extension was written in 2024 and only supports npm. This plan covers adding multi-package-manager support, mise version manager integration, visual version-change indicators + grouping in the picker UI, and several quality improvements.

All logic lives in a single 142-line file: `src/extension.ts`.

---

## Features

### 1. Package Manager Detection
Add `detectPackageManager(rootPath: string): PackageManager` where `PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'`.

Detection priority (lockfiles first — most reliable):
1. `bun.lockb` or `bun.lock` → `bun`
2. `pnpm-lock.yaml` → `pnpm`
3. `yarn.lock` → `yarn`
4. `package-lock.json` → `npm`
5. `packageManager` field in `package.json` (e.g. `"packageManager": "pnpm@9.0.0"`)
6. Default → `npm`

### 2. mise Integration
Add `detectMise(rootPath: string): Promise<boolean>`.

- Check if `.mise.toml` or `.tool-versions` exists in workspace root **AND** `mise` binary is in PATH (run `mise --version` to verify)
- Both must be true — config file without installed binary = `false`
- When mise is active, prefix install command: `mise exec -- <pm> install`

### 3. Simplified Install Command
Current code runs `npm update <package-list>` after writing versions to `package.json`. Since the file is already updated with exact target versions, just run the package manager's install:

| PM | Command | With mise |
|---|---|---|
| npm | `npm install` | `mise exec -- npm install` |
| yarn | `yarn install` | `mise exec -- yarn install` |
| pnpm | `pnpm install` | `mise exec -- pnpm install` |
| bun | `bun install` | `mise exec -- bun install` |

This eliminates the shell injection risk (no more interpolating package names into a shell string) and works uniformly across all package managers.

Switch from `child_process.exec` (buffered, invisible output) to `child_process.spawn` (streaming) so output can be forwarded to a VS Code Output Channel.

### 4. Semver-colored + Grouped QuickPick
Classify each package by bump type (compare current vs new version), then group with `QuickPickItemKind.Separator` dividers. Order: **Patch → Minor → Major** (safest first).

Picker structure:
```
─── Patch ────────────────────────────────
✅ lodash          4.17.20 → 4.17.21 · patch
─── Minor ────────────────────────────────
⚠️  express         4.18.0 → 4.19.0 · minor
─── Major ────────────────────────────────
🔴 react           17.0.2 → 18.0.0 · MAJOR
```

Implementation:
- Separators: `{ label: 'Patch', kind: vscode.QuickPickItemKind.Separator }`
- Icons via `iconPath`:
  - Patch → `new vscode.ThemeIcon('pass')` (green)
  - Minor → `new vscode.ThemeIcon('warning')` (yellow)
  - Major → `new vscode.ThemeIcon('error')` (red)
- Description: `"1.2.3 → 2.0.0 · MAJOR"`

Note: `ThemeIcon.color` is ignored in QuickPick, but icons with semantic meaning (error/warning/pass) retain their inherent theme color. Explicit `ThemeColor` is not needed.

Groups with no packages are omitted (no empty separators).

### 5. Output Channel
Create `vscode.window.createOutputChannel("Update Dependencies")` at activation. Forward `spawn` stdout/stderr to it and reveal it during install. Helps users debug install failures.

### 6. Progress & Notification Improvements
- Include detected package manager in progress message: `"Updating with pnpm..."`
- Include package manager in success notification: `"Dependencies updated successfully (pnpm)"`

---

## Out of Scope
- Monorepo/workspace support
- Rollback/backup mechanism
- Dry-run mode (ncu check already previews changes)
- `peerDependencies` / `optionalDependencies` handling

---

## Files to Modify
- **`src/extension.ts`** — all logic changes
- **`package.json`** — update `displayName`, `description`, `keywords` to reflect multi-PM support

---

## Verification
1. `npm run compile` — must compile with no TypeScript errors
2. Launch Extension Development Host (F5) and test against:
   - Project with `package-lock.json` → should use npm
   - Project with `yarn.lock` → should use yarn
   - Project with `pnpm-lock.yaml` → should use pnpm
   - Project with `.mise.toml` + any lockfile → command should be prefixed with `mise exec -- `
3. Confirm Output Channel appears and shows live install output
4. Confirm QuickPick shows: colored icons, `old → new · TYPE` descriptions, grouped with Patch/Minor/Major separators in that order
