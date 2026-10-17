import * as fs from "fs";
import * as path from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { run, type RunOptions } from "npm-check-updates";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type BumpType = "major" | "minor" | "patch";

export type Update = {
	name: string;
	current: string;
	latest: string;
	bump: BumpType;
	/** Set for package manager / runtime versions rather than dependencies */
	toolchain?: "packageManager" | "mise";
	/** Config file holding a mise pin */
	file?: string;
};

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
			resolve(found ? stdout.trim().split("\n")[0] : false);
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

/** Checks the registry for newer versions of everything in `rootPath`'s package.json. */
export async function findUpdates(rootPath: string, options: RunOptions = {}): Promise<Update[]> {
	const packageFile = path.join(rootPath, "package.json");
	const upgraded = (await run({
		...options,
		cwd: rootPath,
		packageFile,
		jsonUpgraded: true,
	})) as Record<string, string>;

	const pkg = JSON.parse(fs.readFileSync(packageFile, "utf-8"));
	const current: Record<string, string> = {
		...pkg.optionalDependencies,
		...pkg.devDependencies,
		...pkg.dependencies,
	};
	// "pnpm@9.0.0+sha512.abc" → ["pnpm", "9.0.0"]; ncu reports it under the bare name
	const [pmName, pmVersion] = String(pkg.packageManager ?? "").split("+")[0].split("@");
	return Object.entries(upgraded).map(([name, latest]): Update => {
		const isPackageManager = name === pmName && !(name in current);
		const from = isPackageManager ? pmVersion : (current[name] ?? "?");
		return {
			name,
			current: from,
			latest,
			bump: getBumpType(from, latest),
			toolchain: isPackageManager ? "packageManager" : undefined,
		};
	});
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
			file: tool.source!.path,
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

/**
 * Writes the selected updates into package.json. npm-check-updates only replaces the
 * version strings, so indentation and layout are kept, and it covers every section it
 * checks (including optionalDependencies and the packageManager field).
 */
export async function applyUpdates(
	rootPath: string,
	names: string[],
	options: RunOptions = {},
): Promise<void> {
	// ponytail: re-resolves the selected names; a release landing between check and apply gets picked up
	await run({
		...options,
		cwd: rootPath,
		packageFile: path.join(rootPath, "package.json"),
		upgrade: true,
		filter: names,
		install: "never",
	});
}
