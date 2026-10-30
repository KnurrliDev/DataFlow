import * as assert from 'assert';
import { HomeItem, homeItems } from '../../home';

// The DataFlow view in the activity bar. It has no controls of the lenses.
suite('DataFlow view', () => {
	const text = (items: HomeItem[]): string[] => items.flatMap((i) => [
		`${i.label}${i.description ? ` (${i.description})` : ''}${i.command ? ` -> ${i.command}` : ''}`,
		...(i.children ?? []).map((c) => `  ${c.label} (${c.description}) -> ${c.command} ${JSON.stringify(c.arguments)}`),
	]);

	test('With no project, the view has the commands to open a file, a project and the side view, and the commands of the engine', () => {
		assert.deepStrictEqual(text(homeItems({ recent: [], engine: 'stopped' })), [
			'Open File… -> dataflow.openProjectFile',
			'Open Project Folder… -> dataflow.openProjectFolder',
			'Open Side View -> dataflow.openSideView',
			'Compile Database (none) -> dataflow.selectCompileCommands',
			'Show Log -> dataflow.showLog',
			'Restart Engine (stopped) -> dataflow.restartEngine',
		]);
	});

	test('With a project, the view also has the other last projects and Close Project', () => {
		const items = homeItems({
			project: { name: 'App', root: 'C:/src/App' },
			recent: [{ name: 'App', root: 'C:/src/App' }, { name: 'Tool', root: 'C:/src/Tool' }],
			engine: 'ready',
			database: { text: 'build/compile_commands.json', path: 'C:/src/App/build/compile_commands.json' },
		});
		assert.deepStrictEqual(text(items), [
			'Open File… (App) -> dataflow.openProjectFile',
			'Open Project Folder… -> dataflow.openProjectFolder',
			'Recent Projects',
			'  Tool (C:/src/Tool) -> dataflow.openRecentProject ["C:/src/Tool"]',
			'Close Project (App) -> dataflow.closeProject',
			'Open Side View -> dataflow.openSideView',
			'Compile Database (build/compile_commands.json) -> dataflow.selectCompileCommands',
			'Show Log -> dataflow.showLog',
			'Restart Engine (ready) -> dataflow.restartEngine',
		]);
	});
});
