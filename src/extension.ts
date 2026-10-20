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
	type Project,
	detectPackageManager,
	findMiseUpdates,
	findProjects,
	findUpdates,
	lockfiles,
	pnpmIgnoredDependencies,
	readNcurc,
	snapshot,
} from "./deps";
import { startOutdatedIndicator } from "./status";

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

const npmButton: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon("link-external"),
	tooltip: "Open on npm",
};

/**
 * Builds the picker rows: a Toolchain group first (package manager and mise pins, no
 * Select-all toggle), then Patch, Minor and Major groups, each with a Select-all row, and
 * last an Overridden group (no toggle) for dependencies forced by overrides / resolutions.
 */
export function buildPickItems(updates: Update[]): DepQuickPickItem[] {
	const row = (update: Update, groupKey?: BumpType): DepQuickPickItem => {
		return {
			label: update.name,
			description: [
				`${update.current} → ${update.latest}`,
				update.bump,
				update.where,
				update.pinned && "pinned",
				update.overriddenTo && `forced to ${update.overriddenTo} by overrides`,
			]
				.filter(Boolean)
				.join(" · "),
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
	const dependencies = updates.filter((u) => !u.toolchain && !u.overriddenTo);
	for (const [bump, label] of groups) {
		const group = dependencies.filter((u) => u.bump === bump);
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
	// Last and outside the Select-all toggles: while the override stands, updating changes nothing installed
	const overridden = updates.filter((u) => !u.toolchain && u.overriddenTo);
	if (overridden.length > 0) {
		items.push({ label: "Overridden", kind: vscode.QuickPickItemKind.Separator });
		items.push(...overridden.map((u) => row(u)));
	}
	return items;
}

/**
 * Shows a grouped, multi-select QuickPick with group-level toggle headers.
 * Selecting a group header selects/deselects all packages in that group.
 * Group headers auto-check when all their packages are individually selected.
 * Returns only the dep items (not headers), undefined if cancelled, or BACK when `title` is
 * given (several projects) and the user presses the Back button.
 */
function showDependencyPicker(
	pickItems: DepQuickPickItem[],
	placeholder: string,
	title?: string,
): Promise<DepQuickPickItem[] | undefined | typeof BACK> {
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

		if (title) {
			// Several projects: name the one shown and offer a way back to the project list
			qp.title = title;
			qp.buttons = [vscode.QuickInputButtons.Back];
			qp.onDidTriggerButton(() => {
				if (settled) {
					return;
				}
				settled = true;
				qp.dispose();
				resolve(BACK);
			});
		}

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
		const child =
			process.platform === "win32"
				? // npm/pnpm/yarn are .cmd shims on Windows and need cmd.exe; quote each part so paths with spaces survive
					spawn([command, ...args].map((part) => `"${part}"`).join(" "), { cwd, shell: true })
				: // No shell elsewhere: arguments (e.g. tool names from a mise config) are never shell-parsed
					spawn(command, args, { cwd });
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
	const rc = readNcurc(rootPath);
	const list = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []);
	return {
		target: config.get<"latest" | "minor" | "patch">("target", "latest"),
		peer: config.get<boolean>("peer", false),
		// Left unset when empty so ncu falls back to the package manager's own release-age setting
		...(cooldown ? { cooldown: /^\d+$/.test(cooldown) ? Number(cooldown) : cooldown } : {}),
		...rc,
		// pnpm's ignoreDependencies always applies, on top of the rc's or the setting's reject list
		reject: [
			...list(rc.reject ?? config.get<string[]>("reject", [])),
			...pnpmIgnoredDependencies(rootPath),
		],
	};
}

/** Projects in the open workspace folders (see findProjects). */
function workspaceProjects(): Project[] {
	return findProjects(
		(vscode.workspace.workspaceFolders ?? []).map((folder) => ({
			name: folder.name,
			root: folder.uri.fsPath,
		})),
	);
}

const BACK = Symbol("back");

async function updateDependencies(
	output: vscode.OutputChannel,
	refresh: (rootPath: string) => Promise<void>,
): Promise<void> {
	const projects = workspaceProjects();
	if (projects.length === 0) {
		vscode.window.showErrorMessage(
			"No package.json found in the workspace folders or the folders directly inside them.",
		);
		return;
	}
	// With several projects, the dependency picker's Back button returns to this list.
	// Results are kept for this run so switching back and forth doesn't re-query the registry.
	const checked = new Map<string, Update[]>();
	for (;;) {
		const project =
			projects.length === 1
				? projects[0]
				: (
						await vscode.window.showQuickPick(
							projects.map((p) => ({ label: p.name, description: p.root, project: p })),
							{ placeHolder: "Select a project to check" },
						)
					)?.project;
		if (!project) {
			return;
		}
		const result = await updateProject(project, projects.length > 1, checked, output, refresh);
		if (result !== BACK) {
			return;
		}
	}
}

async function updateProject(
	project: Project,
	canGoBack: boolean,
	checked: Map<string, Update[]>,
	output: vscode.OutputChannel,
	refresh: (rootPath: string) => Promise<void>,
): Promise<typeof BACK | void> {
	const rootPath = project.root;

	const pm = detectPackageManager(rootPath);
	const misePath = await detectMise(rootPath);
	const via = misePath ? " via mise" : "";
	const options = ncuOptions(rootPath);

	const check = () =>
		vscode.window.withProgress(
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
	const updates = checked.get(rootPath) ?? (await check());
	checked.set(rootPath, updates);

	if (updates.length === 0) {
		vscode.window.showInformationMessage("All dependencies are up to date.");
		return;
	}
	vscode.window.showInformationMessage(`Found ${updates.length} outdated packages`);

	const cooldown = options.cooldown ? ` · cooldown ${options.cooldown}` : "";
	// Ignore rules (reject setting, .ncurc, pnpm ignoreDependencies); a wildcard counts once
	const rules = (options.reject as unknown[]).length;
	const ignored = rules > 0 ? ` · ${rules} ignored` : "";
	const selected = await showDependencyPicker(
		buildPickItems(updates),
		`Select dependencies to update (${pm}${via}${cooldown}${ignored})`,
		canGoBack ? project.name : undefined,
	);
	if (selected === BACK) {
		return BACK;
	}
	if (!selected) {
		vscode.window.showInformationMessage("No dependencies selected for update.");
		return;
	}

	const chosen = selected.map((item) => item.update!);
	const packageNames = chosen.filter((u) => u.toolchain !== "mise").map((u) => u.name);
	const miseTools = chosen.filter((u) => u.toolchain === "mise");

	// Everything the update may change, so a failed update, install or test run can be undone
	const files = [...new Set(chosen.flatMap((u) => u.files)), ...lockfiles(rootPath)];
	const before = snapshot(files);
	const packageManager = (...args: string[]) =>
		misePath
			? runCommand(output, misePath, ["exec", "--", pm, ...args], rootPath)
			: runCommand(output, pm, args, rootPath);
	const progress = (title: string, task: () => Promise<void>) =>
		vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
			task,
		);

	const installed = await exclusively(async () => {
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
			return true;
		} catch (error: any) {
			before.restore();
			vscode.window.showErrorMessage(
				`Update failed: ${error.message}. Your files have been restored. See the "Update Dependencies" output panel for details.`,
			);
			return false;
		}
	});
	if (!installed) {
		return;
	}
	const after = snapshot(files);
	void refresh(rootPath);

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
	const passed = await exclusively(async () => {
		try {
			// `run test`, not `test`: `bun test` would start Bun's own runner instead of the script
			await progress("Running tests...", () => packageManager("run", "test"));
			return true;
		} catch {
			return false;
		}
	});
	if (passed === undefined) {
		return;
	}
	if (passed) {
		vscode.window.showInformationMessage("Tests passed with the updated dependencies.");
		return;
	}

	const revert = await vscode.window.showWarningMessage(
		'Tests failed after the update. Revert it? See the "Update Dependencies" output panel for the test output.',
		"Revert",
		"Keep",
	);
	if (revert !== "Revert") {
		return;
	}
	// The prompt may have sat for a while; don't silently drop edits made since the update
	const edited = after.changed().map((file) => path.relative(rootPath, file));
	if (edited.length > 0) {
		const proceed = await vscode.window.showWarningMessage(
			`${edited.join(", ")} changed since the update. Reverting restores the version from before the update and discards those changes.`,
			{ modal: true },
			"Revert anyway",
		);
		if (proceed !== "Revert anyway") {
			return;
		}
	}
	await exclusively(async () => {
		before.restore();
		await progress("Reverting...", () => packageManager("install"));
		vscode.window.showInformationMessage("Update reverted.");
		void refresh(rootPath);
	});
}

let busy = false;

/**
 * Runs `task` unless another install, test run or revert is in progress (they'd share the
 * same files and lockfile). Resolves to undefined when skipped. Prompts waiting on the user
 * don't hold the lock, so a forgotten notification can't block the command.
 */
async function exclusively<T>(task: () => Promise<T>): Promise<T | undefined> {
	if (busy) {
		vscode.window.showWarningMessage(
			"Another dependency update is still running. Try again when it finishes.",
		);
		return undefined;
	}
	busy = true;
	try {
		return await task();
	} finally {
		busy = false;
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

	const refresh = startOutdatedIndicator(
		context,
		outputChannel,
		() => workspaceProjects().map((project) => project.root),
		ncuOptions,
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("update-npm-dependencies.updateDependencies", () =>
			updateDependencies(outputChannel, refresh).catch((error: Error) => {
				vscode.window.showErrorMessage("Error: " + error.message);
			}),
		),
	);

	// Lets the test suite exercise the webpack bundle, not just the tsc output (read-only on purpose)
	return { findUpdates };
}

export function deactivate() {}
