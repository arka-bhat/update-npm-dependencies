import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { run } from "npm-check-updates";
import { spawn, exec } from "child_process";

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
type BumpType = "major" | "minor" | "patch";

type DepQuickPickItem = vscode.QuickPickItem & {
	depName?: string;
	groupKey?: BumpType;
	isGroupHeader?: boolean;
};

function detectPackageManager(rootPath: string): PackageManager {
	if (
		fs.existsSync(path.join(rootPath, "bun.lockb")) ||
		fs.existsSync(path.join(rootPath, "bun.lock"))
	) {
		return "bun";
	}
	if (fs.existsSync(path.join(rootPath, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (fs.existsSync(path.join(rootPath, "yarn.lock"))) {
		return "yarn";
	}
	if (fs.existsSync(path.join(rootPath, "package-lock.json"))) {
		return "npm";
	}
	try {
		const pkgJson = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf-8"));
		if (typeof pkgJson.packageManager === "string") {
			const pm = pkgJson.packageManager.split("@")[0] as PackageManager;
			if (["npm", "yarn", "pnpm", "bun"].includes(pm)) {
				return pm;
			}
		}
	} catch {}
	return "npm";
}

/**
 * Returns the full path to the mise binary if the project uses mise, otherwise false.
 * Checks known install locations directly rather than relying on shell PATH, since the
 * extension host process may not have the user's full shell environment.
 */
async function detectMise(rootPath: string): Promise<string | false> {
	const hasMiseConfig =
		fs.existsSync(path.join(rootPath, "mise.toml")) ||
		fs.existsSync(path.join(rootPath, ".mise.toml")) ||
		fs.existsSync(path.join(rootPath, ".tool-versions")) ||
		fs.existsSync(path.join(rootPath, "tool-versions")) ||
		fs.existsSync(path.join(rootPath, "mise"));
	if (!hasMiseConfig) {
		return false;
	}

	// Check known install locations before falling back to PATH lookup
	const candidates: string[] = [
		process.env.HOME ? `${process.env.HOME}/.local/bin/mise` : "",
		"/opt/homebrew/bin/mise",
		"/usr/local/bin/mise",
	].filter(Boolean);

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	// Fall back to which/where via the process environment
	return new Promise((resolve) => {
		const whichCmd = process.platform === "win32" ? "where mise" : "which mise";
		exec(whichCmd, { env: process.env }, (err, stdout) => {
			const found = !err && stdout.trim().length > 0;
			resolve(found ? stdout.trim().split("\n")[0] : false);
		});
	});
}

function getBumpType(currentVersion: string, newVersion: string): BumpType {
	const clean = (v: string) => v.replace(/^[^0-9]*/, "");
	const parts = (v: string) =>
		clean(v)
			.split(".")
			.map((n) => parseInt(n, 10) || 0);
	const [curMajor, curMinor] = parts(currentVersion);
	const [newMajor, newMinor] = parts(newVersion);
	if (newMajor > curMajor) {
		return "major";
	}
	if (newMinor > curMinor) {
		return "minor";
	}
	return "patch";
}

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

				const updatedDependencies = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Checking for new dependency versions...",
						cancellable: false,
					},
					async (progress) => {
						const result: Record<string, string> = (await run({
							packageFile: packageJsonPath,
							jsonUpgraded: true,
							upgrade: false,
						})) as Record<string, string>;
						progress.report({
							increment: 100,
							message: "Dependencies check complete.",
						});
						vscode.window.showInformationMessage(
							`Found ${Object.keys(result).length} outdated packages`,
						);
						return result;
					},
				);

				if (Object.keys(updatedDependencies).length === 0) {
					vscode.window.showInformationMessage("All dependencies are up to date.");
					return;
				}

				// Read current versions for bump classification
				const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
				const allDeps: Record<string, string> = {
					...packageJson.dependencies,
					...packageJson.devDependencies,
				};

				// Classify packages by bump type
				const byBump: Record<BumpType, string[]> = {
					patch: [],
					minor: [],
					major: [],
				};
				for (const dep of Object.keys(updatedDependencies)) {
					const bump = getBumpType(allDeps[dep] ?? "0.0.0", updatedDependencies[dep]);
					byBump[bump].push(dep);
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
					for (const dep of byBump[bump]) {
						pickItems.push({
							label: dep,
							description: `${allDeps[dep] ?? "?"} → ${updatedDependencies[dep]} · ${bump}`,
							iconPath: bumpIcon(bump),
							depName: dep,
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

				// Snapshot original content so we can roll back if the install fails
				const originalContent = fs.readFileSync(packageJsonPath, "utf-8");

				// Write updated versions to package.json
				for (const dep of selectedDeps) {
					const name = dep.depName ?? dep.label;
					if (packageJson.dependencies?.[name]) {
						packageJson.dependencies[name] = updatedDependencies[name];
					} else if (packageJson.devDependencies?.[name]) {
						packageJson.devDependencies[name] = updatedDependencies[name];
					}
				}
				fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf-8");

				// Build install command — use full mise path when detected
				const command = useMise ? (misePath as string) : pm;
				const args = useMise ? ["exec", "--", pm, "install"] : ["install"];

				try {
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
}

export function deactivate() {}
