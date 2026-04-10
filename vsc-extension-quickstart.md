# Developer Quickstart

## Project structure

| Path                         | Purpose                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `package.json`               | Extension manifest — commands, activation events, metadata                            |
| `src/extension.ts`           | All extension logic (package manager detection, mise detection, picker, install)      |
| `src/test/extension.test.ts` | Test suite                                                                            |
| `webpack.config.js`          | Bundles `src/extension.ts` → `dist/extension.js`                                      |
| `tsconfig.json`              | TypeScript config — targets ES2022, Node16 modules, includes `node` and `mocha` types |

## Setup

1. Install dependencies: `npm install`
2. Install recommended VS Code extensions when prompted (ESLint, TypeScript Problem Matcher, Extension Test Runner)

## Run the extension locally

Press `F5` — this opens a new Extension Development Host window with the extension loaded.

In the host window, open a Node.js project and run **Update Dependencies** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).

## Build commands

```bash
npm run compile     # single build
npm run watch       # rebuild on save
npm run package     # production build (minified, hidden source maps)
npm run lint        # ESLint
npm test            # compile + lint + run tests
```

If `npm` is not in your PATH (e.g. you use mise), prefix with `mise exec --`:

```bash
mise exec -- npm run compile
```

## Reload after changes

After editing `src/extension.ts`, either:

- Re-run `F5` (full relaunch), or
- Reload the Extension Development Host window with `Ctrl+R` / `Cmd+R`

## Debugging

Set breakpoints in `src/extension.ts` and use the debug console in the host window. The "Update Dependencies" output channel (View > Output) shows live install output.

## Run tests

Open the Testing view in the activity bar and click **Run Tests**, or use `Ctrl/Cmd+; A`. Make sure the `watch` build task is running first so tests are discovered.

Test files must match `**/*.test.ts`.

## Publishing

```bash
npm run package          # build for release
npx @vscode/vsce publish # publish to Marketplace
```

See the [VS Code publishing docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for setup.
