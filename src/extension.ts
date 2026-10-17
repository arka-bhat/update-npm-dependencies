import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { RunOptions } from "npm-check-updates";
import {
	type BumpType,
	type Update,
	applyUpdates,
	detectMise,
	detectPackageManager,
	findMiseUpdates,
	findUpdates,
	lockfiles,
	readNcurc,
	snapshot,
} from "./deps";

export type DepQuickPickItem = vscode.QuickPickItem & {
	update?: Update;
	groupKey?: BumpType;
	isGroupHeader?: boolean;
};

function bumpIcon(bump: BumpType): vscode.ThemeIcon {
	switch (bump) {
		case "major":
			return new vscode.ThemeIcon("error");
		case "minor":
			return new vscode.ThemeIcon("warning");
		case "patch":
			return new vscode.ThemeIcon("pass");
	}
}

/**
 * Builds the picker rows: a Toolchain group first (package manager and mise pins, no
 * Select-all toggle), then Patch, Minor and Major groups, each with a Select-all row.
 */
const npmButton: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon("link-external"),
	tooltip: "Open on npm",
};

export function buildPickItems(updates: Update[]): DepQuickPickItem[] {
	const row = (update: Update, groupKey?: BumpType): DepQuickPickItem => {
		return {
			label: update.name,
			description: `${update.current} → ${update.latest} · ${update.bump}${update.where ? ` · ${update.where}` : ""}`,
			iconPath: update.toolchain ? new vscode.ThemeIcon("tools") : bumpIcon(update.bump),
			// mise tools (node, python, …) aren't npm packages
			buttons: update.toolchain === "mise" ? [] : [npmButton],
			update,
			groupKey,
		};
	};

	const items: DepQuickPickItem[] = [];
	const toolchain = updates.filter((u) => u.toolchain);
	if (toolchain.length > 0) {
		items.push({ label: "Toolchain", kind: vscode.QuickPickItemKind.Separator });
		items.push(...toolchain.map((u) => row(u)));
	}
	const groups = [
		["patch", "Patch"],
		["minor", "Minor"],
		["major", "Major"],
	] as const;
	for (const [bump, label] of groups) {
		const group = updates.filter((u) => !u.toolchain && u.bump === bump);
		if (group.length === 0) {
			continue;
		}
		items.push({ label, kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: `Select all \`${bump}\``,
			description: `${group.length} ${group.length === 1 ? "package" : "packages"}`,
			iconPath: bumpIcon(bump),
			isGroupHeader: true,
			groupKey: bump,
		});
		items.push(...group.map((u) => row(u, bump)));
	}
	return items;
}

/**
 * Shows a grouped, multi-select QuickPick with group-level toggle headers.
 * Selecting a group header selects/deselects all packages in that group.
 * Group headers auto-check when all their packages are individually selected.
 * Returns only the dep items (not headers), or undefined if cancelled.
 */
function showDependencyPicker(
	pickItems: DepQuickPickItem[],
	placeholder: string,
): Promise<DepQuickPickItem[] | undefined> {
	return new Promise((resolve) => {
		const qp = vscode.window.createQuickPick<DepQuickPickItem>();
		qp.canSelectMany = true;
		qp.items = pickItems;
		qp.placeholder = placeholder;
		// Opening a link moves focus to the browser; without this the picker would close and cancel
		qp.ignoreFocusOut = true;

		qp.onDidTriggerItemButton(({ item }) => {
			vscode.env.openExternal(
				vscode.Uri.parse(`https://www.npmjs.com/package/${item.update!.name}?activeTab=versions`),
			);
		});

		let prevSelected = new Set<DepQuickPickItem>();
		let isUpdating = false;

		qp.onDidChangeSelection((newSelected) => {
			if (isUpdating) {
				return;
			}
			isUpdating = true;
			try {
				const added = newSelected.filter((i) => !prevSelected.has(i));
				const removed = [...prevSelected].filter((i) => !new Set(newSelected).has(i));

				const result = new Set(newSelected);

				// Group header toggled → cascade to all deps in that group
				for (const item of added) {
					if (item.isGroupHeader) {
						for (const dep of pickItems) {
							if (!dep.isGroupHeader && dep.groupKey === item.groupKey) {
								result.add(dep);
							}
						}
					}
				}
				for (const item of removed) {
					if (item.isGroupHeader) {
						for (const dep of pickItems) {
							if (!dep.isGroupHeader && dep.groupKey === item.groupKey) {
								result.delete(dep);
							}
						}
					}
				}

				// Auto-sync group headers: check iff all their deps are selected
				for (const item of pickItems.filter((i) => i.isGroupHeader)) {
					const groupDeps = pickItems.filter(
						(i) => !i.isGroupHeader && i.groupKey === item.groupKey && i.update,
					);
					const allSelected =
						groupDeps.length > 0 && groupDeps.every((d) => result.has(d));
					if (allSelected) {
						result.add(item);
					} else {
						result.delete(item);
					}
				}

				prevSelected = result;
				qp.selectedItems = [...result];
			} finally {
				isUpdating = false;
			}
		});

		let settled = false;

		qp.onDidAccept(() => {
			if (settled) {
				return;
			}
			settled = true;
			const deps = qp.selectedItems.filter((i) => !!i.update);
			qp.dispose();
			resolve(deps.length > 0 ? deps : undefined);
		});

		qp.onDidHide(() => {
			if (settled) {
				return;
			}
			settled = true;
			qp.dispose();
			resolve(undefined);
		});

		qp.show();
	});
}

/** Runs a command in `cwd`, streaming its output to the channel; rejects on a non-zero exit. */
function runCommand(
	output: vscode.OutputChannel,
	command: string,
	args: string[],
	cwd: string,
): Promise<void> {
	output.appendLine(`Running: ${command} ${args.join(" ")}\n`);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, shell: true });
		child.stdout.on("data", (data: Buffer) => output.append(data.toString()));
		child.stderr.on("data", (data: Buffer) => output.append(data.toString()));
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
		);
		child.on("error", reject);
	});
}

/** npm-check-updates options from the extension's settings; a project `.ncurc.json` wins per key. */
function ncuOptions(rootPath: string): RunOptions {
	const config = vscode.workspace.getConfiguration("updateDependencies", vscode.Uri.file(rootPath));
	const cooldown = config.get<string>("cooldown", "");
	return {
		target: config.get<"latest" | "minor" | "patch">("target", "latest"),
		reject: config.get<string[]>("reject", []),
		peer: config.get<boolean>("peer", false),
		// Left unset when empty so ncu falls back to the package manager's own release-age setting
		...(cooldown ? { cooldown: /^\d+$/.test(cooldown) ? Number(cooldown) : cooldown } : {}),
		...readNcurc(rootPath),
	};
}

/**
 * The workspace folder to update. With several folders that have a package.json, asks
 * which one; resolves to undefined if there are none or the user cancels.
 */
async function pickProject(): Promise<string | undefined> {
	const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
		fs.existsSync(path.join(folder.uri.fsPath, "package.json")),
	);
	if (folders.length === 0) {
		vscode.window.showErrorMessage("Please open a workspace with a package.json file.");
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0].uri.fsPath;
	}
	const picked = await vscode.window.showQuickPick(
		folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath })),
		{ placeHolder: "Select a project to check" },
	);
	return picked?.description;
}

async function updateDependencies(output: vscode.OutputChannel): Promise<void> {
	const rootPath = await pickProject();
	if (!rootPath) {
		return;
	}

	const pm = detectPackageManager(rootPath);
	const misePath = await detectMise(rootPath);
	const via = misePath ? " via mise" : "";
	const options = ncuOptions(rootPath);

	const updates = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Checking for new dependency versions...",
			cancellable: false,
		},
		async () => {
			const [packageUpdates, miseUpdates] = await Promise.all([
				findUpdates(rootPath, options),
				misePath
					? findMiseUpdates(misePath, rootPath).catch((error: Error) => {
							output.appendLine(`Could not check mise tools: ${error.message}`);
							return [];
						})
					: [],
			]);
			return [...packageUpdates, ...miseUpdates];
		},
	);

	if (updates.length === 0) {
		vscode.window.showInformationMessage("All dependencies are up to date.");
		return;
	}
	vscode.window.showInformationMessage(`Found ${updates.length} outdated packages`);

	const cooldown = options.cooldown ? ` · cooldown ${options.cooldown}` : "";
	const selected = await showDependencyPicker(
		buildPickItems(updates),
		`Select dependencies to update (${pm}${via}${cooldown})`,
	);
	if (!selected) {
		vscode.window.showInformationMessage("No dependencies selected for update.");
		return;
	}

	const chosen = selected.map((item) => item.update!);
	const packageNames = chosen.filter((u) => u.toolchain !== "mise").map((u) => u.name);
	const miseTools = chosen.filter((u) => u.toolchain === "mise");

	// Everything the update may change, so a failed update, install or test run can be undone
	const restore = snapshot([...new Set(chosen.flatMap((u) => u.files)), ...lockfiles(rootPath)]);
	const packageManager = (...args: string[]) =>
		misePath
			? runCommand(output, misePath, ["exec", "--", pm, ...args], rootPath)
			: runCommand(output, pm, args, rootPath);
	const progress = (title: string, task: () => Promise<void>) =>
		vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
			task,
		);

	try {
		await progress(`Updating with ${pm}${misePath ? " (mise)" : ""}...`, async () => {
			output.clear();
			output.show(true);
			if (packageNames.length > 0) {
				await applyUpdates(rootPath, packageNames, options);
			}
			if (misePath && miseTools.length > 0) {
				// Bump mise pins first so the install runs on the new tool versions
				const tools = miseTools.map((u) => u.name);
				await runCommand(output, misePath, ["upgrade", "--bump", ...tools], rootPath);
			}
			await packageManager("install");
		});
	} catch (error: any) {
		restore();
		vscode.window.showErrorMessage(
			`Update failed: ${error.message}. Your files have been restored. See the "Update Dependencies" output panel for details.`,
		);
		return;
	}

	const updated = `Dependencies updated successfully (${pm}${via}).`;
	if (!hasTestScript(rootPath)) {
		vscode.window.showInformationMessage(updated);
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		`${updated} Run the test script to check them?`,
		"Run test",
		"Skip",
	);
	if (choice !== "Run test") {
		return;
	}
	try {
		// `run test`, not `test`: `bun test` would start Bun's own runner instead of the script
		await progress("Running tests...", () => packageManager("run", "test"));
		vscode.window.showInformationMessage("Tests passed with the updated dependencies.");
	} catch {
		const revert = await vscode.window.showWarningMessage(
			"Tests failed after the update. Revert it? See the \"Update Dependencies\" output panel for the test output.",
			"Revert",
			"Keep",
		);
		if (revert === "Revert") {
			restore();
			await progress("Reverting...", () => packageManager("install"));
			vscode.window.showInformationMessage("Update reverted.");
		}
	}
}

/** True when package.json has a real test script (not npm's "no test specified" placeholder). */
function hasTestScript(rootPath: string): boolean {
	const test = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf-8")).scripts
		?.test;
	return typeof test === "string" && !test.includes("no test specified");
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Update Dependencies");
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(
		vscode.commands.registerCommand("update-npm-dependencies.updateDependencies", () =>
			updateDependencies(outputChannel).catch((error: Error) => {
				vscode.window.showErrorMessage("Error: " + error.message);
			}),
		),
	);

	// Lets the test suite exercise the webpack bundle, not just the tsc output
	return { findUpdates, applyUpdates };
}

export function deactivate() {}
