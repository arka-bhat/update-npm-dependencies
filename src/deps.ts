import * as fs from "fs";
import * as path from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { run, type RunOptions } from "npm-check-updates";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type BumpType = "major" | "minor" | "patch";

export type Update = {
	name: string;
	/** Current version range; several when workspace packages disagree, e.g. "^6.0.0, ^6.1.0" */
	current: string;
	latest: string;
	bump: BumpType;
	/** Set for package manager / runtime versions rather than dependencies */
	toolchain?: "packageManager" | "mise";
	/** Every file that changes when this update is applied */
	files: string[];
	/** Where the version lives, for the picker: "packageManager", "mise.toml", "apps/web, root" */
	where?: string;
};

const BUMP_ORDER: BumpType[] = ["patch", "minor", "major"];

export function detectPackageManager(rootPath: string): PackageManager {
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
export async function detectMise(rootPath: string): Promise<string | false> {
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
			// `where` on Windows ends lines with \r\n
			resolve(found ? stdout.trim().split(/\r?\n/)[0] : false);
		});
	});
}

/**
 * Classifies an update the way a caret range does: anything `^current` wouldn't accept is
 * major, so below 1.0 a minor bump (0.3 → 0.4) and below 0.1 a patch bump (0.0.3 → 0.0.4)
 * count as breaking.
 */
export function getBumpType(currentVersion: string, newVersion: string): BumpType {
	const parts = (v: string) =>
		v
			.replace(/^[^0-9]*/, "")
			.split(".")
			.map((n) => parseInt(n, 10) || 0);
	const [curMajor = 0, curMinor = 0, curPatch = 0] = parts(currentVersion);
	const [newMajor = 0, newMinor = 0, newPatch = 0] = parts(newVersion);
	if (
		newMajor !== curMajor ||
		(curMajor === 0 && (newMinor !== curMinor || (curMinor === 0 && newPatch !== curPatch)))
	) {
		return "major";
	}
	return newMinor !== curMinor ? "minor" : "patch";
}

/**
 * The project's npm-check-updates config. npm-check-updates only reads it itself when run
 * from the command line, so the extension loads it.
 */
export function readNcurc(rootPath: string): RunOptions {
	for (const name of [".ncurc.json", ".ncurc"]) {
		let rc: Record<string, unknown>;
		try {
			rc = JSON.parse(fs.readFileSync(path.join(rootPath, name), "utf-8"));
		} catch {
			// ponytail: JSON only; YAML and JS config files need ncu's own loader, which isn't exported
			continue;
		}
		return Object.fromEntries(Object.entries(rc).filter(([key]) => RC_OPTIONS.includes(key)));
	}
	return {};
}

/**
 * rc options that only narrow which versions are offered. Anything else (upgrade,
 * interactive, errorLevel, deep, …) would let a background check write files, block on a
 * prompt or change the shape of the result.
 */
const RC_OPTIONS = [
	"cooldown",
	"dep",
	"deprecated",
	"enginesNode",
	"filter",
	"filterVersion",
	"peer",
	"pre",
	"registry",
	"registryType",
	"reject",
	"rejectVersion",
	"target",
];

export type Project = { name: string; root: string };

/**
 * The projects in a set of workspace folders: each folder with a package.json, or, for a
 * folder without one (e.g. a folder holding several repos), each direct subfolder that has one.
 */
export function findProjects(folders: Project[]): Project[] {
	return folders.flatMap((folder) => {
		if (fs.existsSync(path.join(folder.root, "package.json"))) {
			return [folder];
		}
		try {
			// ponytail: one level deep; deeper layouts can open the project folder itself
			return fs
				.readdirSync(folder.root, { withFileTypes: true })
				.filter(
					(entry) =>
						entry.isDirectory() &&
						entry.name !== "node_modules" &&
						fs.existsSync(path.join(folder.root, entry.name, "package.json")),
				)
				.map((entry) => ({ name: entry.name, root: path.join(folder.root, entry.name) }));
		} catch {
			return []; // unreadable or not on disk (e.g. a virtual workspace folder)
		}
	});
}

/** A monorepo is checked and updated as a whole: every workspace package plus pnpm catalogs. */
export function isMonorepo(rootPath: string): boolean {
	const pnpmWorkspace = path.join(rootPath, "pnpm-workspace.yaml");
	// pnpm 10 also keeps plain settings here (onlyBuiltDependencies, overrides); only `packages:` makes a workspace
	if (
		fs.existsSync(pnpmWorkspace) &&
		/^packages\s*:/m.test(fs.readFileSync(pnpmWorkspace, "utf-8"))
	) {
		return true;
	}
	try {
		return !!JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf-8")).workspaces;
	} catch {
		return false;
	}
}

/** Which files npm-check-updates should read and write for this project. */
function scope(rootPath: string): RunOptions {
	return isMonorepo(rootPath)
		? { cwd: rootPath, workspaces: true }
		: { cwd: rootPath, packageFile: path.join(rootPath, "package.json") };
}

type Current = { version: string; packageManager?: boolean };

/** Looks up a dependency's current version in a package.json or a pnpm-workspace.yaml catalog. */
function currentVersions(file: string): (name: string) => Current | undefined {
	const text = fs.readFileSync(file, "utf-8");
	if (!file.endsWith(".json")) {
		// Search from catalog:/catalogs: on, so an overrides: entry for the same name doesn't match
		const catalogs = text.slice(Math.max(0, text.search(/^catalogs?\s*:/m)));
		// ponytail: line match instead of a YAML parser; catalog entries are one `name: range` per line
		return (name) => {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`^\\s+['"]?${escaped}['"]?:\\s*['"]?([^'"\\s#]+)`, "m");
			const match = catalogs.match(pattern);
			return match ? { version: match[1] } : undefined;
		};
	}
	const pkg = JSON.parse(text);
	const deps: Record<string, string> = {
		...pkg.optionalDependencies,
		...pkg.devDependencies,
		...pkg.dependencies,
	};
	// "pnpm@9.0.0+sha512.abc" → ["pnpm", "9.0.0"]; ncu reports it under the bare name
	const [pmName, pmVersion] = String(pkg.packageManager ?? "").split("+")[0].split("@");
	return (name) =>
		name in deps
			? { version: deps[name] }
			: name === pmName
				? { version: pmVersion, packageManager: true }
				: undefined;
}

/**
 * Checks the registry for newer versions of the project's dependencies (every workspace
 * package in a monorepo). A dependency used in several packages becomes one update that
 * covers all of them.
 */
export async function findUpdates(rootPath: string, options: RunOptions = {}): Promise<Update[]> {
	const monorepo = isMonorepo(rootPath);
	const result = await run({ ...options, ...scope(rootPath), jsonUpgraded: true });
	// In workspace mode ncu keys results by file, relative to the root
	const byFile = (monorepo ? result : { "package.json": result }) as Record<
		string,
		Record<string, string>
	>;

	const updates = new Map<string, Update>();
	// ncu returns workspace packages in no fixed order; sort so rows and labels are stable
	const entries = Object.entries(byFile).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	for (const [relativeFile, upgraded] of entries) {
		const file = path.join(rootPath, relativeFile);
		const lookup = currentVersions(file);
		for (const [name, latest] of Object.entries(upgraded)) {
			const found = lookup(name);
			const current = found?.version ?? "?";
			const bump = getBumpType(current, latest);
			const existing = updates.get(name);
			if (!existing) {
				updates.set(name, {
					name,
					current,
					latest,
					bump,
					toolchain: found?.packageManager ? "packageManager" : undefined,
					files: [file],
				});
				continue;
			}
			existing.files.push(file);
			if (!existing.current.split(", ").includes(current)) {
				existing.current += `, ${current}`;
			}
			if (BUMP_ORDER.indexOf(bump) > BUMP_ORDER.indexOf(existing.bump)) {
				existing.bump = bump;
			}
		}
	}

	const label = (file: string) =>
		file.endsWith(".yaml") ? "catalog" : path.relative(rootPath, path.dirname(file)) || "root";
	for (const update of updates.values()) {
		update.where = update.toolchain
			? "packageManager"
			: monorepo
				? update.files.map(label).join(", ")
				: undefined;
	}
	return [...updates.values()];
}

/**
 * Writes the selected updates. npm-check-updates only replaces the version strings, so
 * indentation and layout are kept, and it covers every section and file it checks
 * (optionalDependencies, the packageManager field, workspace packages, pnpm catalogs).
 */
export async function applyUpdates(
	rootPath: string,
	names: string[],
	options: RunOptions = {},
): Promise<void> {
	// ponytail: re-resolves the selected names; a release landing between check and apply gets picked up
	await run({ ...options, ...scope(rootPath), upgrade: true, filter: names, install: "never" });
}

export type Snapshot = {
	/** Writes the saved bytes back */
	restore: () => void;
	/** Files whose content no longer matches what was saved */
	changed: () => string[];
};

/** Saves the files' current bytes (lockfiles like bun.lockb are binary). */
export function snapshot(files: string[]): Snapshot {
	const saved = files.map((file) => [file, fs.readFileSync(file)] as const);
	return {
		restore: () => saved.forEach(([file, data]) => fs.writeFileSync(file, data)),
		changed: () =>
			saved
				.filter(([file, data]) => !fs.existsSync(file) || !fs.readFileSync(file).equals(data))
				.map(([file]) => file),
	};
}

/** The project's existing lockfiles, mise's included (`mise upgrade` may write it). */
export function lockfiles(rootPath: string): string[] {
	return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "mise.lock"]
		.map((name) => path.join(rootPath, name))
		.filter((file) => fs.existsSync(file));
}

type MiseOutdated = Record<
	string,
	{ requested: string; bump: string | null; source?: { path?: string } }
>;

/**
 * Turns `mise outdated --bump --json` output into updates, keeping only tools pinned in
 * the project's own config files (never the user's global mise config).
 */
export function parseMiseOutdated(json: string, rootPath: string): Update[] {
	return Object.entries(JSON.parse(json) as MiseOutdated)
		.filter(
			([, tool]) =>
				tool.bump &&
				tool.bump !== tool.requested &&
				tool.source?.path?.startsWith(rootPath + path.sep),
		)
		.map(([name, tool]): Update => ({
			name,
			current: tool.requested,
			latest: tool.bump!,
			bump: getBumpType(tool.requested, tool.bump!),
			toolchain: "mise",
			files: [tool.source!.path!],
			where: path.basename(tool.source!.path!),
		}));
}

/** Tools pinned in the project's mise config that have a release past the pinned version. */
export async function findMiseUpdates(misePath: string, rootPath: string): Promise<Update[]> {
	const { stdout } = await promisify(execFile)(misePath, ["outdated", "--bump", "--json"], {
		cwd: rootPath,
	});
	// mise reports real paths (e.g. /private/tmp on macOS), so compare against the real root
	return parseMiseOutdated(stdout, fs.realpathSync(rootPath));
}
