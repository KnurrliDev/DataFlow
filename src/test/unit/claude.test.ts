import * as assert from 'assert';
import * as path from 'path';
import {
	connectionOf, connectSettings, disconnectSettings, MARKETPLACE_NAME, marketplacePathOf, PLUGIN_ID, pluginFiles,
} from '../../mcp/claude';

// The connection to Claude Code: the settings of Claude Code and the files of the plugin
suite('Connection to Claude Code', () => {
	const dir = path.resolve('/home/user/.dataflow/mcp/claude');

	test('Connect adds the marketplace and turns the plugin on, and the other keys stay', () => {
		const old = '{\n    "model": "opus",\n    "enabledPlugins": {\n        "other@market": false\n    }\n}\n';
		const text = connectSettings(old, dir);
		const settings = JSON.parse(text);
		assert.strictEqual(settings.model, 'opus');
		assert.deepStrictEqual(settings.enabledPlugins, { 'other@market': false, [PLUGIN_ID]: true });
		assert.deepStrictEqual(settings.extraKnownMarketplaces, { [MARKETPLACE_NAME]: { source: { source: 'directory', path: dir } } });
		// the indent and the end of the old text stay
		assert.ok(text.startsWith('{\n    "model"') && text.endsWith('}\n'), text);
		assert.strictEqual(connectionOf(text), 'connected');
		assert.strictEqual(marketplacePathOf(text), dir);

		// no settings file, a file with tabs and Windows line ends
		assert.strictEqual(connectionOf(connectSettings(undefined, dir)), 'connected');
		const tabs = connectSettings('{\r\n\t"theme": "dark"\r\n}', dir);
		assert.ok(tabs.startsWith('{\r\n\t"theme"') && !tabs.endsWith('\n'), JSON.stringify(tabs));
	});

	test('Disconnect removes only the keys of DataFlow, and invalid settings are not changed', () => {
		const text = connectSettings('{ "enabledPlugins": { "other@market": true } }', dir);
		const after = JSON.parse(disconnectSettings(text)!);
		assert.deepStrictEqual(after, { enabledPlugins: { 'other@market': true } });
		// a key that has no other value goes away
		assert.deepStrictEqual(JSON.parse(disconnectSettings(connectSettings('{}', dir))!), {});
		assert.strictEqual(disconnectSettings('{ "model": "opus" }'), undefined);
		assert.strictEqual(disconnectSettings(undefined), undefined);
		assert.throws(() => connectSettings('{ "model": "opus", }', dir));
		assert.throws(() => connectSettings('[1]', dir), /not a JSON object/);
	});

	test('A plugin that the user turned off in Claude Code is disabled, not connected', () => {
		const off = connectSettings(undefined, dir).replace(`"${PLUGIN_ID}": true`, `"${PLUGIN_ID}": false`);
		assert.strictEqual(connectionOf(off), 'disabled');
		assert.strictEqual(connectionOf(`{ "enabledPlugins": { "${PLUGIN_ID}": false } }`), 'disabled');
		assert.strictEqual(connectionOf('{}'), 'none');
		assert.strictEqual(connectionOf('not json'), 'none');
		assert.strictEqual(connectionOf(undefined), 'none');
	});

	test('The plugin has the MCP server of the bridge, which VS Code runs as Node.js', () => {
		const registry = path.resolve('/home/user/.dataflow/mcp');
		const files = pluginFiles(registry, '/opt/vscode/code', '0.1.0');
		const market = JSON.parse(files[path.join('.claude-plugin', 'marketplace.json')]);
		assert.deepStrictEqual([market.name, market.owner.name, market.plugins.map((p: { name: string; source: string }) => `${p.name} ${p.source}`)],
			[MARKETPLACE_NAME, 'DataFlow', ['dataflow ./plugins/dataflow']]);
		const plugin = JSON.parse(files[path.join('plugins', 'dataflow', '.claude-plugin', 'plugin.json')]);
		assert.deepStrictEqual([plugin.name, plugin.version], ['dataflow', '0.1.0']);
		assert.deepStrictEqual(plugin.mcpServers.dataflow, {
			command: '/opt/vscode/code',
			args: [path.join(registry, 'bridge.js')],
			env: { ELECTRON_RUN_AS_NODE: '1', DATAFLOW_MCP_REGISTRY: registry },
		});
	});
});
