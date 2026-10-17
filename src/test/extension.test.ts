import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
	type BumpType,
	type Update,
	applyUpdates,
	findUpdates,
	getBumpType,
	parseMiseOutdated,
	readNcurc,
} from "../deps";
import { buildPickItems } from "../extension";

// Offline registry: npm-check-updates reads latest versions from this file instead of npm
const REGISTRY = { semver: "7.8.5", ms: "2.1.3", pnpm: "12.14.0" };

const PACKAGE_JSON = `{
	"name": "fixture",
	"packageManager": "pnpm@9.0.0",
	"dependencies": { "semver": "^6.0.0" },
	"optionalDependencies": { "ms": "^1.0.0" }
}
`;

function fixture(packageJson = PACKAGE_JSON) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-deps-"));
	fs.writeFileSync(path.join(dir, "package.json"), packageJson);
	fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(REGISTRY));
	const options = { registryType: "json" as const, registry: path.join(dir, "registry.json") };
	return { dir, options, read: () => fs.readFileSync(path.join(dir, "package.json"), "utf-8") };
}

suite("getBumpType", () => {
	const cases: [string, string, BumpType][] = [
		["^1.2.3", "^1.2.4", "patch"],
		["^1.2.3", "^1.3.0", "minor"],
		["^1.2.3", "^2.0.0", "major"],
		["^0.3.1", "^0.3.2", "patch"],
		["^0.3.1", "^0.4.0", "major"],
		["^0.0.3", "^0.0.4", "major"],
		["~6.0.2", "~6.0.3", "patch"],
		["25.x", "26.x", "major"],
		["?", "12.14.0", "major"],
	];
	for (const [from, to, expected] of cases) {
		test(`${from} → ${to} is ${expected}`, () => {
			assert.strictEqual(getBumpType(from, to), expected);
		});
	}
});

suite("applyUpdates", () => {
	test("keeps formatting and writes packageManager and optionalDependencies", async () => {
		const { dir, options, read } = fixture();
		await applyUpdates(dir, ["pnpm", "ms"], options);
		assert.strictEqual(
			read(),
			PACKAGE_JSON.replace("pnpm@9.0.0", "pnpm@12.14.0").replace("^1.0.0", "^2.1.3"),
		);
	});
});

suite("findUpdates", () => {
	test("reports current and latest versions from every checked section", async () => {
		const { dir, options } = fixture();
		const updates = await findUpdates(dir, options);
		const byName = Object.fromEntries(updates.map((u) => [u.name, `${u.current} → ${u.latest}`]));
		assert.deepStrictEqual(byName, {
			semver: "^6.0.0 → ^7.8.5",
			ms: "^1.0.0 → ^2.1.3",
			pnpm: "9.0.0 → 12.14.0",
		});
		assert.deepStrictEqual(
			updates.filter((u) => u.toolchain).map((u) => [u.name, u.toolchain]),
			[["pnpm", "packageManager"]],
		);
	});

	test("reads the packageManager version past a corepack hash", async () => {
		const { dir, options } = fixture(PACKAGE_JSON.replace("pnpm@9.0.0", "pnpm@9.0.0+sha512.abc"));
		const pnpm = (await findUpdates(dir, options)).find((u) => u.name === "pnpm");
		assert.strictEqual(pnpm?.current, "9.0.0");
	});
});

suite("options", () => {
	test("the default settings don't filter anything", async () => {
		const { dir, options } = fixture();
		const updates = await findUpdates(dir, { ...options, target: "latest", reject: [], peer: false });
		assert.strictEqual(updates.length, 3);
	});

	test("rejected packages are left out", async () => {
		const { dir, options } = fixture();
		const names = (await findUpdates(dir, { ...options, reject: ["semver"] })).map((u) => u.name);
		assert.deepStrictEqual(names.sort(), ["ms", "pnpm"]);
	});

	test("a project .ncurc.json is read", () => {
		const { dir } = fixture();
		fs.writeFileSync(path.join(dir, ".ncurc.json"), '{ "reject": ["semver"], "cooldown": 3 }');
		assert.deepStrictEqual(readNcurc(dir), { reject: ["semver"], cooldown: 3 });
	});

	test("no .ncurc means no extra options", () => {
		assert.deepStrictEqual(readNcurc(fixture().dir), {});
	});
});

suite("parseMiseOutdated", () => {
	const root = "/work/app";
	const tool = (requested: string, bump: string | null, file: string) => ({
		requested,
		bump,
		latest: bump,
		source: { type: path.basename(file), path: file },
	});

	test("keeps only project pins with a newer release", () => {
		const json = JSON.stringify({
			node: tool("20", "26", `${root}/mise.toml`),
			pnpm: tool("9.0.0", "12.14.0", `${root}/.tool-versions`),
			bun: tool("1.3.0", "1.3.0", `${root}/mise.toml`),
			go: tool("1.22", null, `${root}/mise.toml`),
			python: tool("3.12", "3.14", "/home/me/.config/mise/config.toml"),
		});
		assert.deepStrictEqual(parseMiseOutdated(json, root), [
			{ name: "node", current: "20", latest: "26", bump: "major", toolchain: "mise", file: `${root}/mise.toml` },
			{ name: "pnpm", current: "9.0.0", latest: "12.14.0", bump: "major", toolchain: "mise", file: `${root}/.tool-versions` },
		]);
	});
});

suite("buildPickItems", () => {
	const update = (name: string, bump: BumpType, toolchain?: Update["toolchain"]): Update => ({
		name,
		current: "1.0.0",
		latest: "2.0.0",
		bump,
		toolchain,
	});

	test("puts the toolchain first with no Select-all row, then bump groups", () => {
		const items = buildPickItems([
			update("react", "major"),
			update("pnpm", "major", "packageManager"),
			update("lodash", "patch"),
		]);
		assert.deepStrictEqual(
			items.map((i) => (i.kind === vscode.QuickPickItemKind.Separator ? `--${i.label}` : i.label)),
			["--Toolchain", "pnpm", "--Patch", "Select all `patch`", "lodash", "--Major", "Select all `major`", "react"],
		);
		assert.strictEqual(items.find((i) => i.label === "pnpm")?.groupKey, undefined);
	});
});

suite("bundle", () => {
	test("npm-check-updates runs from the packaged extension", async () => {
		const extension = vscode.extensions.getExtension("arka-bhattacharya.update-npm-dependencies")!;
		const api = (await extension.activate()) as { findUpdates: typeof findUpdates };
		const { dir, options } = fixture();
		const names = (await api.findUpdates(dir, options)).map((u) => u.name).sort();
		assert.deepStrictEqual(names, ["ms", "pnpm", "semver"]);
	});
});
