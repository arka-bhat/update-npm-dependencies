import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Latest stable by default; run the oldest supported VS Code with VSCODE_TEST_VERSION=1.100.0 npm test
	version: process.env.VSCODE_TEST_VERSION ?? 'stable',
});
