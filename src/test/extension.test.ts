import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
	type BumpType,
	type Update,
	applyUpdates,
	findProjects,
	findUpdates,
	getBumpType,
	lockfiles,
	parseMiseOutdated,
	pnpmIgnoredDependencies,
	readNcurc,
	readOverrides,
	snapshot,
} from "../deps";
import { buildPickItems } from "../extension";
import { hintsFor } from "../status";

// Offline registry: npm-check-updates reads latest versions from this file instead of npm
const REGISTRY = { semver: "7.8.5", ms: "2.1.3", pnpm: "12.14.0" };

const PACKAGE_JSON = `{
	"name": "fixture",
	"packageManager": "pnpm@9.0.0",
	"dependencies": { "semver": "^6.0.0" },
	"optionalDependencies": { "ms": "^1.0.0" }
}
`;

/** A temp project made of the given files (relative path → content) plus the offline registry. */
function fixture(files: Record<string, string> = { "package.json": PACKAGE_JSON }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-deps-"));
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), content);
	}
	fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(REGISTRY));
	const options = { registryType: "json" as const, registry: path.join(dir, "registry.json") };
	const read = (file = "package.json") => fs.readFileSync(path.join(dir, file), "utf-8");
	return { dir, options, read };
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
		const { dir, options } = fixture({
			"package.json": PACKAGE_JSON.replace("pnpm@9.0.0", "pnpm@9.0.0+sha512.abc"),
		});
		const pnpm = (await findUpdates(dir, options)).find((u) => u.name === "pnpm");
		assert.strictEqual(pnpm?.current, "9.0.0");
	});
});

suite("pins and overrides", () => {
	test("pnpm ignoreDependencies is read from package.json and pnpm-workspace.yaml", () => {
		const { dir } = fixture({
			"package.json": '{ "pnpm": { "updateConfig": { "ignoreDependencies": ["react"] } } }',
			"pnpm-workspace.yaml":
				"packages:\n  - packages/*\nupdateConfig:\n  ignoreDependencies:\n    - '@types/*'\n    - expo\ncatalog:\n  - nope\n",
		});
		assert.deepStrictEqual(pnpmIgnoredDependencies(dir), ["react", "@types/*", "expo"]);
	});

	test("overrides and resolutions are collected by package name", () => {
		const { dir } = fixture({
			"package.json": JSON.stringify({
				overrides: { semver: "7.0.0", foo: { ".": "1.0.0", bar: "2.0.0" } },
				resolutions: { "**/ms": "2.0.0" },
			}),
			"pnpm-workspace.yaml": "overrides:\n  lodash: 4.17.21\n",
		});
		assert.deepStrictEqual(readOverrides(dir), {
			semver: "7.0.0",
			foo: "1.0.0",
			ms: "2.0.0",
			lodash: "4.17.21",
		});
	});

	test("updates note exact pins and overrides", async () => {
		const { dir, options } = fixture({
			"package.json": JSON.stringify({
				dependencies: { semver: "6.0.0", ms: "^1.0.0" },
				overrides: { ms: "1.0.0" },
			}),
		});
		const notes = (await findUpdates(dir, options)).map((u) => [u.name, u.pinned, u.overriddenTo]);
		assert.deepStrictEqual(notes, [
			["semver", true, undefined],
			["ms", false, "1.0.0"],
		]);
	});
});

suite("findProjects", () => {
	test("a folder with a package.json is one project", () => {
		const { dir } = fixture();
		assert.deepStrictEqual(findProjects([{ name: "app", root: dir }]), [{ name: "app", root: dir }]);
	});

	test("a folder of repos yields each subfolder that has a package.json", () => {
		const { dir } = fixture({
			"api/package.json": "{}",
			"mobile/package.json": "{}",
			"docs/README.md": "",
			"node_modules/x/package.json": "{}",
		});
		assert.deepStrictEqual(
			findProjects([{ name: "fitflow", root: dir }]).map((p) => [p.name, p.root]),
			[
				["api", path.join(dir, "api")],
				["mobile", path.join(dir, "mobile")],
			],
		);
	});
});

suite("monorepo", () => {
	const workspace = {
		"package.json": `{
	"name": "root",
	"private": true,
	"workspaces": ["packages/*"],
	"packageManager": "pnpm@9.0.0",
	"devDependencies": { "ms": "^1.0.0" }
}
`,
		"packages/a/package.json": '{ "name": "a", "dependencies": { "semver": "^6.0.0", "ms": "^1.0.0" } }\n',
		"packages/b/package.json": '{ "name": "b", "dependencies": { "semver": "^6.1.0" } }\n',
	};

	test("one row per dependency across workspace packages", async () => {
		const { dir, options } = fixture(workspace);
		const rows = (await findUpdates(dir, options)).map((u) => [u.name, `${u.current} → ${u.latest}`, u.where]);
		assert.deepStrictEqual(rows, [
			["ms", "^1.0.0 → ^2.1.3", "root, packages/a"],
			["pnpm", "9.0.0 → 12.14.0", "packageManager"],
			["semver", "^6.0.0, ^6.1.0 → ^7.8.5", "packages/a, packages/b"],
		]);
	});

	test("applying a row updates every package that uses it", async () => {
		const { dir, options, read } = fixture(workspace);
		await applyUpdates(dir, ["semver"], options);
		assert.match(read("packages/a/package.json"), /"semver": "\^7\.8\.5", "ms": "\^1\.0\.0"/);
		assert.match(read("packages/b/package.json"), /"semver": "\^7\.8\.5"/);
		assert.strictEqual(read(), workspace["package.json"]);
	});

	test("pnpm catalog entries are found and written", async () => {
		const { dir, options, read } = fixture({
			"package.json": '{ "name": "root", "private": true }\n',
			"pnpm-workspace.yaml": "packages:\n  - packages/*\ncatalog:\n  ms: ^1.0.0\n",
			// ncu only reads pnpm-workspace.yaml once it detects pnpm from the lockfile
			"pnpm-lock.yaml": "",
			"packages/a/package.json": '{ "name": "a", "dependencies": { "ms": "catalog:" } }\n',
		});
		const ms = (await findUpdates(dir, options)).find((u) => u.name === "ms");
		assert.deepStrictEqual([ms?.current, ms?.latest, ms?.where], ["^1.0.0", "^2.1.3", "catalog"]);
		await applyUpdates(dir, ["ms"], options);
		assert.strictEqual(read("pnpm-workspace.yaml"), "packages:\n  - packages/*\ncatalog:\n  ms: ^2.1.3\n");
	});

	test("a catalog version is read from the catalog, not an earlier overrides entry", async () => {
		const { dir, options } = fixture({
			"package.json": '{ "name": "root", "private": true }\n',
			"pnpm-workspace.yaml":
				"packages:\n  - packages/*\noverrides:\n  ms: 0.7.0\ncatalog:\n  ms: ^1.0.0\n",
			"pnpm-lock.yaml": "",
			"packages/a/package.json": '{ "name": "a", "dependencies": { "ms": "catalog:" } }\n',
		});
		const ms = (await findUpdates(dir, options)).find((u) => u.name === "ms");
		assert.strictEqual(ms?.current, "^1.0.0");
	});

	test("a pnpm-workspace.yaml holding only settings is a single-package project", async () => {
		const { dir, options } = fixture({
			"package.json": PACKAGE_JSON,
			"pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n",
			"pnpm-lock.yaml": "",
		});
		const names = (await findUpdates(dir, options)).map((u) => u.name).sort();
		assert.deepStrictEqual(names, ["ms", "pnpm", "semver"]);
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

	test("rc options that would write files or prompt are ignored", async () => {
		const { dir, options, read } = fixture();
		fs.writeFileSync(
			path.join(dir, ".ncurc.json"),
			'{ "upgrade": true, "interactive": true, "errorLevel": 2, "reject": ["ms"] }',
		);
		assert.deepStrictEqual(readNcurc(dir), { reject: ["ms"] });
		await findUpdates(dir, { ...options, ...readNcurc(dir) });
		assert.strictEqual(read(), PACKAGE_JSON);
	});

	test("no .ncurc means no extra options", () => {
		assert.deepStrictEqual(readNcurc(fixture().dir), {});
	});
});

suite("snapshot", () => {
	test("restores text and binary files byte for byte", () => {
		const { dir, read } = fixture();
		const lockb = path.join(dir, "bun.lockb");
		const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]);
		fs.writeFileSync(lockb, binary);

		const saved = snapshot([path.join(dir, "package.json"), ...lockfiles(dir)]);
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		fs.writeFileSync(lockb, "changed");
		saved.restore();

		assert.strictEqual(read(), PACKAGE_JSON);
		assert.deepStrictEqual(fs.readFileSync(lockb), binary);
	});

	test("reports which files changed since it was taken", () => {
		const { dir } = fixture();
		fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
		const saved = snapshot([path.join(dir, "package.json"), ...lockfiles(dir)]);
		assert.deepStrictEqual(saved.changed(), []);
		fs.writeFileSync(path.join(dir, "package-lock.json"), '{ "edited": true }');
		assert.deepStrictEqual(saved.changed(), [path.join(dir, "package-lock.json")]);
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
		assert.deepStrictEqual(
			parseMiseOutdated(json, root).map((u) => [u.name, `${u.current} → ${u.latest}`, u.bump, u.files, u.where]),
			[
				["node", "20 → 26", "major", [`${root}/mise.toml`], "mise.toml"],
				["pnpm", "9.0.0 → 12.14.0", "major", [`${root}/.tool-versions`], ".tool-versions"],
			],
		);
	});
});

suite("buildPickItems", () => {
	const update = (name: string, bump: BumpType, toolchain?: Update["toolchain"]): Update => ({
		name,
		current: "1.0.0",
		latest: "2.0.0",
		bump,
		toolchain,
		files: [],
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

	test("npm rows get a link button, mise tools don't", () => {
		const items = buildPickItems([update("react", "major"), update("node", "major", "mise")]);
		const buttons = (name: string) => items.find((i) => i.label === name)?.buttons?.length;
		assert.strictEqual(buttons("react"), 1);
		assert.strictEqual(buttons("node"), 0);
	});
});

suite("hintsFor", () => {
	const file = "/work/app/package.json";
	const update = (name: string, toolchain?: Update["toolchain"], files = [file]): Update => ({
		name,
		current: "^1.0.0",
		latest: "^2.0.0",
		bump: "major",
		toolchain,
		files,
	});

	test("puts each hint on its dependency's line, packageManager included", () => {
		const text = [
			"{", // 0
			'\t"packageManager": "pnpm@9.0.0",', // 1
			'\t"dependencies": {', // 2
			'\t\t"@types/ms": "^1.0.0",', // 3
			'\t\t"ms": "^1.0.0"', // 4
			"\t}",
			"}",
		].join("\n");
		const hints = hintsFor(file, text, [
			update("ms"),
			update("pnpm", "packageManager"),
			update("semver", undefined, ["/work/app/packages/a/package.json"]),
		]);
		assert.deepStrictEqual(hints, [
			{ line: 4, text: "→ ^2.0.0 · major" },
			{ line: 1, text: "→ ^2.0.0 · major" },
		]);
	});

	test("skips same-named config keys and scripts", () => {
		const text = [
			"{", // 0
			'\t"prettier": "@acme/prettier-config",', // 1
			'\t"scripts": { "prettier": "prettier --write ." },', // 2
			'\t"devDependencies": {', // 3
			'\t\t"prettier": "^1.0.0"', // 4
			"\t}",
			"}",
		].join("\n");
		assert.deepStrictEqual(hintsFor(file, text, [update("prettier")]), [
			{ line: 4, text: "→ ^2.0.0 · major" },
		]);
	});

	test("finds bare keys in a pnpm catalog", () => {
		const yaml = "/work/app/pnpm-workspace.yaml";
		const hints = hintsFor(yaml, "catalog:\n  ms: ^1.0.0\n", [update("ms", undefined, [yaml])]);
		assert.deepStrictEqual(hints, [{ line: 1, text: "→ ^2.0.0 · major" }]);
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
