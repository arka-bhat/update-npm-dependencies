import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { run, type RunOptions } from "npm-check-updates";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type BumpType = "major" | "minor" | "patch";

export type Update = {
	name: string;
	current: string;
	latest: string;
	bump: BumpType;
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

export function getBumpType(currentVersion: string, newVersion: string): BumpType {
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
	return Object.entries(upgraded).map(([name, latest]) => {
		const from = current[name] ?? "?";
		return { name, current: from, latest, bump: getBumpType(from, latest) };
	});
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
