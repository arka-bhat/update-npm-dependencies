import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import {
	type BumpType,
	type Update,
	applyUpdates,
	detectMise,
	detectPackageManager,
	findUpdates,
} from "./deps";

type DepQuickPickItem = vscode.QuickPickItem & {
	depName?: string;
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
						(i) => !i.isGroupHeader && i.groupKey === item.groupKey && i.depName,
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
			const deps = qp.selectedItems.filter((i) => !!i.depName);
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

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Update Dependencies");
	context.subscriptions.push(outputChannel);

	const disposable = vscode.commands.registerCommand(
		"update-npm-dependencies.updateDependencies",
		async () => {
			const rootPath = vscode.workspace.workspaceFolders
				? vscode.workspace.workspaceFolders[0].uri.fsPath
				: undefined;

			if (!rootPath) {
				vscode.window.showErrorMessage("Please open a workspace with a package.json file.");
				return;
			}

			const packageJsonPath = path.join(rootPath, "package.json");

			if (!fs.existsSync(packageJsonPath)) {
				vscode.window.showErrorMessage(
					"No package.json found in the root of the workspace.",
				);
				return;
			}

			try {
				const [pm, misePath] = await Promise.all([
					Promise.resolve(detectPackageManager(rootPath)),
					detectMise(rootPath),
				]);
				const useMise = misePath !== false;

				const updates = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Checking for new dependency versions...",
						cancellable: false,
					},
					async (progress) => {
						const result = await findUpdates(rootPath);
						progress.report({
							increment: 100,
							message: "Dependencies check complete.",
						});
						vscode.window.showInformationMessage(
							`Found ${result.length} outdated packages`,
						);
						return result;
					},
				);

				if (updates.length === 0) {
					vscode.window.showInformationMessage("All dependencies are up to date.");
					return;
				}

				// Classify packages by bump type
				const byBump: Record<BumpType, Update[]> = {
					patch: [],
					minor: [],
					major: [],
				};
				for (const update of updates) {
					byBump[update.bump].push(update);
				}

				// Build grouped items with selectable group headers
				const pickItems: DepQuickPickItem[] = [];
				const addGroup = (bump: BumpType, label: string) => {
					if (byBump[bump].length === 0) {
						return;
					}
					const count = byBump[bump].length;
					pickItems.push({
						label,
						kind: vscode.QuickPickItemKind.Separator,
					});
					pickItems.push({
						label: `Select all \`${bump}\``,
						description: `${count} ${count === 1 ? "package" : "packages"}`,
						iconPath: bumpIcon(bump),
						isGroupHeader: true,
						groupKey: bump,
					});
					for (const update of byBump[bump]) {
						pickItems.push({
							label: update.name,
							description: `${update.current} → ${update.latest} · ${bump}`,
							iconPath: bumpIcon(bump),
							depName: update.name,
							groupKey: bump,
						});
					}
				};
				addGroup("patch", "Patch");
				addGroup("minor", "Minor");
				addGroup("major", "Major");

				const selectedDeps = await showDependencyPicker(
					pickItems,
					`Select dependencies to update (${pm}${useMise ? " via mise" : ""})`,
				);

				if (!selectedDeps || selectedDeps.length === 0) {
					vscode.window.showInformationMessage("No dependencies selected for update.");
					return;
				}

				// Snapshot original content so we can roll back if the update or install fails
				const originalContent = fs.readFileSync(packageJsonPath, "utf-8");

				// Build install command — use full mise path when detected
				const command = useMise ? (misePath as string) : pm;
				const args = useMise ? ["exec", "--", pm, "install"] : ["install"];

				try {
					await applyUpdates(
						rootPath,
						selectedDeps.map((dep) => dep.depName!),
					);
					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: `Updating with ${pm}${useMise ? " (mise)" : ""}...`,
							cancellable: false,
						},
						(progress) =>
							new Promise<void>((resolve, reject) => {
								outputChannel.clear();
								outputChannel.show(true);
								outputChannel.appendLine(`Running: ${command} ${args.join(" ")}\n`);

								const child = spawn(command, args, {
									cwd: rootPath,
									shell: true,
								});

								child.stdout.on("data", (data: Buffer) => {
									outputChannel.append(data.toString());
								});
								child.stderr.on("data", (data: Buffer) => {
									outputChannel.append(data.toString());
								});
								child.on("close", (code) => {
									if (code !== 0) {
										reject(new Error(`Exit code ${code}`));
									} else {
										progress.report({ increment: 100, message: "Done." });
										resolve();
									}
								});
								child.on("error", reject);
							}),
					);
					vscode.window.showInformationMessage(
						`Dependencies updated successfully (${pm}${useMise ? " via mise" : ""}).`,
					);
				} catch (installError: any) {
					// Roll back package.json — the install never completed
					fs.writeFileSync(packageJsonPath, originalContent, "utf-8");
					vscode.window.showErrorMessage(
						`Update failed: ${installError.message}. package.json has been restored. See the "Update Dependencies" output panel for details.`,
					);
				}
			} catch (error: any) {
				vscode.window.showErrorMessage("Error: " + error.message);
			}
		},
	);

	context.subscriptions.push(disposable);

	// Lets the test suite exercise the webpack bundle, not just the tsc output
	return { findUpdates, applyUpdates };
}

export function deactivate() {}
