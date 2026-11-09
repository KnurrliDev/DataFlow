import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';

// The "npm test" command reads this file.
// The "vscode-test" tool downloads a copy of VS Code into the ".vscode-test" folder.
// It starts that copy with this extension loaded, one time for each configuration.
// Then it runs the compiled Mocha tests that agree with the pattern of the configuration.
// The MCP server of a test writes its file for the bridge into the build folder, not into the home folder of the user.
// The connection to Claude Code of a test changes the settings in the build folder, not the settings of the user.
const common = {
	launchArgs: ['--disable-workspace-trust'],
	mocha: { timeout: 120000 },
	env: {
		DATAFLOW_MCP_REGISTRY: path.resolve(import.meta.dirname, 'build', 'mcp-registry'),
		CLAUDE_CONFIG_DIR: path.resolve(import.meta.dirname, 'build', 'claude-config'),
	},
};

export default defineConfig([
	// Tests with no workspace
	{ label: 'unit', files: 'out/test/unit/**/*.test.js', ...common },
	// The P1 exit check, the tests of Flow Lens, and the tests of the side view with acceptance scenarios 1 to 3. Each
	// fixture opens as the workspace, as in a real project. The side view tests come last: their last test of Call
	// Hierarchy stops all requests of the window to the call hierarchy of VS Code, and the MCP tests use it.
	{
		label: 'cmake',
		files: ['out/test/fixtures/cmake.test.js', 'out/test/fixtures/flow.test.js', 'out/test/fixtures/mcp.test.js', 'out/test/fixtures/side.test.js'],
		workspaceFolder: 'test/fixtures/battery',
		...common,
	},
	{ label: 'qmake', files: 'out/test/fixtures/qmake.test.js', workspaceFolder: 'test/fixtures/battery-qmake', ...common },
	// A project that is not open in VS Code: the window has no folder
	{ label: 'project', files: 'out/test/fixtures/project.test.js', ...common },
	// A folder with no compile database at the start. scripts/prepare-fixtures.mjs makes it from the CMake fixture.
	{ label: 'late-db', files: 'out/test/fixtures/latedb.test.js', workspaceFolder: 'build/fixtures/late-db', ...common },
	// The acceptance test of P5, the test of the story of S5 and the tests of the diff walk need a git repository.
	// scripts/prepare-fixtures.mjs makes it from the CMake fixture.
	{
		label: 'review',
		files: ['out/test/fixtures/ripple.test.js', 'out/test/fixtures/side-ripple.test.js', 'out/test/fixtures/walk.test.js'],
		workspaceFolder: 'build/fixtures/battery-review',
		...common,
	},
	// An Unreal project with no compile database. scripts/prepare-fixtures.mjs makes it from test/fixtures/unreal. The test
	// needs an installed Unreal Engine 5, else it is skipped.
	{ label: 'unreal', files: 'out/test/fixtures/unreal.test.js', workspaceFolder: 'build/fixtures/unreal/BatteryPlant', ...common },
]);
