import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { applyUpdates, findUpdates } from "../deps";

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
			pnpm: "? → 12.14.0",
		});
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
