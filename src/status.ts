import * as vscode from "vscode";
import * as path from "path";
import type { RunOptions } from "npm-check-updates";
import { type Update, findUpdates } from "./deps";

export type Hint = { line: number; text: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where to show each update inside one package file: the line holding the dependency (or
 * the packageManager field) and the text to append after it.
 */
export function hintsFor(file: string, text: string, updates: Update[]): Hint[] {
	const lines = text.split("\n");
	return updates
		.filter((update) => update.files.includes(file))
		.flatMap((update) => {
			const isPackageManager = update.toolchain === "packageManager";
			const key = escape(isPackageManager ? "packageManager" : update.name);
			// The value must be the current version, so a same-named scripts entry or top-level
			// config key ("prettier": "@acme/prettier-config") doesn't take the hint
			const values = (isPackageManager ? [`${update.name}@`] : update.current.split(", ")).map(escape);
			// Key at a word boundary, quoted (JSON) or bare (YAML catalog): "ms": / ms: but not "@types/ms":
			const pattern = new RegExp(`(?<=^|[\\s{,"'])${key}["']?\\s*:\\s*["']?(?:${values.join("|")})`);
			// ponytail: first match wins; the same name and range in peerDependencies above would get it
			const line = lines.findIndex((l) => pattern.test(l));
			return line === -1 ? [] : [{ line, text: `→ ${update.latest} · ${update.bump}` }];
		});
}

/**
 * Checks projects in the background and shows the result as a status bar count and as
 * faded hints after outdated lines in open package files. Returns a function that
 * re-checks one project (call it after updating).
 */
export function startOutdatedIndicator(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	projectRoots: () => string[],
	ncuOptions: (rootPath: string) => RunOptions,
): (rootPath: string) => Promise<void> {
	const results = new Map<string, Update[]>();
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBar.command = "update-npm-dependencies.updateDependencies";
	statusBar.tooltip = "Dependency updates available. Click to choose which to install.";
	const hint = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor("editorInlayHint.foreground"), margin: "0 0 0 2em" },
	});
	context.subscriptions.push(statusBar, hint);

	const enabled = () =>
		vscode.workspace.getConfiguration("updateDependencies").get<boolean>("backgroundCheck", true);

	const render = () => {
		const updates = [...results.values()].flat();
		statusBar.text = `$(package) ${updates.length} outdated`;
		if (updates.length > 0) {
			statusBar.show();
		} else {
			statusBar.hide();
		}
		for (const editor of vscode.window.visibleTextEditors) {
			const { document } = editor;
			const hints = hintsFor(document.uri.fsPath, document.getText(), updates);
			editor.setDecorations(
				hint,
				hints.map(({ line, text }) => ({
					range: document.lineAt(line).range,
					renderOptions: { after: { contentText: text } },
				})),
			);
		}
	};

	// Bumped per project on every check, so a slow, older check can't overwrite a newer result
	const generations = new Map<string, number>();

	const check = async (rootPath: string) => {
		if (!enabled()) {
			return;
		}
		const generation = (generations.get(rootPath) ?? 0) + 1;
		generations.set(rootPath, generation);
		let updates: Update[] | undefined;
		try {
			updates = await findUpdates(rootPath, ncuOptions(rootPath));
		} catch (error) {
			output.appendLine(`Background check failed for ${rootPath}: ${(error as Error).message}`);
		}
		// Drop the result if a newer check started, checks were turned off or the folder was removed meanwhile
		if (
			generations.get(rootPath) !== generation ||
			!enabled() ||
			!projectRoots().includes(rootPath)
		) {
			return;
		}
		if (updates) {
			results.set(rootPath, updates);
		} else {
			results.delete(rootPath);
		}
		render();
	};

	const checkAll = () => {
		results.clear();
		render();
		for (const rootPath of projectRoots()) {
			void check(rootPath);
		}
	};

	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(render),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (!/(^|[\\/])(package\.json|pnpm-workspace\.yaml)$/.test(document.fileName)) {
				return;
			}
			const rootPath = projectRoots().find((root) =>
				document.uri.fsPath.startsWith(root + path.sep),
			);
			if (rootPath) {
				void check(rootPath);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("updateDependencies")) {
				checkAll();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(checkAll),
	);

	checkAll();
	return check;
}
