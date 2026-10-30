// The tests of the webview of the side view. Each script of spikes/ui starts the test build of VS Code with the remote
// debugging protocol, works in the side view, reads its DOM and gives a result. These tests check the results. The
// scripts also make screenshots in a temporary folder.
// Run them with "npm run test:ui" after "npm run compile". The scripts use the fixtures of scripts/prepare-fixtures.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const out = mkdtempSync(path.join(os.tmpdir(), 'dataflow-ui-'));
after(() => rmSync(out, { recursive: true, force: true }));

// The keys of the command palette of the test build can go to a different element. Then a script does not find the side
// view, and one more run usually works
const RETRY = /side view was not found|command palette did not open/;

// Runs a script of spikes/ui and gives its result
async function run(script) {
	for (let attempt = 0; ; attempt++) {
		const result = await new Promise((resolve, reject) => {
			execFile(process.execPath, [path.join(repo, 'spikes', 'ui', script), path.join(out, `${script}-${attempt}`), 'dark'],
				{ cwd: repo, timeout: 300000, maxBuffer: 1 << 26 }, (error, stdout) => {
					try {
						resolve(JSON.parse(stdout));
					} catch {
						reject(error ?? new Error(`${script} gave no result: ${stdout.slice(0, 500)}`));
					}
				});
		});
		if (!result.error || attempt > 0 || !RETRY.test(result.error)) {
			assert.equal(result.error, undefined, `${script}: ${result.error}`);
			return result;
		}
	}
}

test('side view: the colors, the guides, the scroll sync in both directions, the cursor with no text editor, Show Calls and the restore after a reload', { timeout: 600000 }, async () => {
	const r = await run('side-snapshot.mjs');
	assert.ok(r.spans > 100, `${r.spans} spans`);
	assert.match(r.status, /^Engine: ready/);
	assert.ok(r.toolbar.startsWith('battery.cpp'), r.toolbar);
	// the switch of Change Ripple is back, and in the narrow side view of the test each button of the toolbar is visible
	assert.ok(r.toolbarButtons.some((b) => b.text === 'Change Ripple'), JSON.stringify(r.toolbarButtons));
	assert.ok(r.toolbarButtons.every((b) => b.isVisible), JSON.stringify(r.toolbarButtons));
	assert.match(r.guides, /^\d+ guides, \d+ active$/);
	for (const at of [r.start, r.afterEditorScroll, r.afterSideScroll]) {
		assert.equal(at.side, at.editor, JSON.stringify(at));
	}
	assert.ok(r.afterEditorScroll.editor > r.start.editor && r.afterSideScroll.editor > r.afterEditorScroll.editor);
	// with the Welcome page in front of the C++ editor, a click moves the cursor of the side view and the function. The
	// button of the file name opens the editor at the line
	const n = r.noEditor;
	assert.equal(n.tab, 'Welcome', JSON.stringify(n));
	assert.equal(n.cursor, n.line, JSON.stringify(n));
	assert.match(n.fn, /process$/, JSON.stringify(n));
	assert.notEqual(n.fn, n.fnBefore, JSON.stringify(n));
	assert.equal(n.after.tab, 'battery.cpp', JSON.stringify(n));
	assert.match(n.after.status, new RegExp(`^Ln ${n.line},`), JSON.stringify(n));
	// a right-click on a call of a function: the menu of VS Code has Show Calls, and the list shows the calls by file. A
	// click on a call moves the text editor to it, the list stays, and Escape closes it
	const c = r.calls;
	assert.equal(c.menu, 'Show Calls', JSON.stringify(c));
	assert.match(c.list?.title ?? '', /^Calls of fire_transition\(\)/, JSON.stringify(c));
	assert.ok(c.list.items >= 10 && c.list.files[0] === 'battery.cpp', JSON.stringify(c.list));
	assert.match(c.status, new RegExp(`^Ln ${c.target},`), JSON.stringify(c));
	assert.equal(c.isOpen, true);
	assert.equal(c.afterEscape, false);
	assert.match(r.afterReload, /^battery\.cpp, \d+ spans$/);
	assert.equal(r.dirty, false);
});

test('Model layers: five levels of blocks, comments in colors, the bar MODEL, a selection for get_view and the card of a detail', { timeout: 600000 }, async () => {
	const r = await run('side-model-snapshot.mjs');
	// one bar for each level on the deepest line. The line numbers get 5 px for each level after the second
	assert.deepEqual(r.bars, ['mbar lv-0', 'mbar lv-1', 'mbar lv-2', 'mbar lv-3', 'mbar lv-4']);
	assert.equal(r.lnWidth - r.lnWidthBefore, 15);
	// purple and green are chart colors of the theme. A comment with no color has the color dataflow.modelComment
	for (const c of [r.purple, r.green, r.plain]) {
		assert.equal(c.color, c.want, JSON.stringify(c));
	}
	assert.equal(r.plain.text, 'picks a new price slot and plans again');
	assert.deepEqual(r.details, { comments: 3, deepest: 1 });
	// the cursor on the line of a comment: the bar shows the blocks of the line and the comment
	assert.match(r.modelBar, /1a1Take the result of the solver/);
	assert.match(r.modelBar, /waits for the result of the solver/);
	// a selection of code in the side view goes to the text editor, so get_view gives it to the model
	assert.equal(r.selection?.text, 'converged', JSON.stringify(r.selection));
	// a detail: a symbol at the end of its line, also when the end is outside of the view. The mouse on the code opens no
	// card, so the user can click the code. The mouse on the symbol opens the card with the title and the Markdown text,
	// and the code of the detail gets a background until the card closes
	assert.equal(r.cardOnCode, false);
	assert.deepEqual(r.detailMark, { text: 'i', isVisible: true });
	assert.deepEqual(r.detailCard, { title: 'Examples of converged', items: 2, bold: 'new price slot' });
	assert.equal(r.activeCode, 'converged');
	assert.equal(r.cardAfterLeave, false);
	// the switch Model in the toolbar hides all layers of the model in the code and the bar MODEL, and shows them again
	assert.ok(r.switch.before > 0 && r.switch.hidden === 0 && r.switch.shown === r.switch.before, JSON.stringify(r.switch));
	assert.equal(r.switch.pressed, 'false');
	assert.equal(r.switch.isVisible, true);
	// blocks for two functions: the tab Model shows the blocks of the function at the cursor, and links to both functions
	assert.deepEqual(r.tabInSolve, { fn: 'solve_power_plan()', blocks: 1, fns: ['solve_power_plan()', 'process()'] });
	assert.deepEqual([r.tabInProcess?.fn, r.tabInProcess?.blocks], ['process()', 7], JSON.stringify(r.tabInProcess));
});

test('Flow Lens: the rails, the dimmed lines, the hover card with its curve, a click trace and the details column', { timeout: 600000 }, async () => {
	const r = await run('side-flow-snapshot.mjs');
	assert.ok(r.bestFit.rails > 0 && r.bestFit.dim > 0, JSON.stringify(r.bestFit).slice(0, 300));
	assert.ok(r.bestFit.marks.some((m) => m.includes('mk-def')) && r.bestFit.marks.some((m) => m.includes('mk-finding')));
	assert.match(r.card, /^bestFit: read, line \d+Value from line \d+/);
	assert.ok(r.curves >= 1);
	assert.ok(r.startPlans.rails > 0 && r.startPlans.marks.some((m) => m.includes('mk-def')));
	assert.ok(r.details.className.includes('details'), JSON.stringify(r.details));
	// the text editor gets no decorations of DataFlow
	assert.equal(r.editorDecorations, 0);
	assert.equal(r.dirty, false);
});

test('Logic Map: the path panel, the events, Play path, the card of a line number and the tabs', { timeout: 600000 }, async () => {
	const r = await run('side-logic-snapshot.mjs');
	assert.ok(r.default.events.some((e) => e.includes('"_planned"')), JSON.stringify(r.default.events));
	assert.ok(r.play.length > 0 && r.play.every((p) => p.rows.length === 1), JSON.stringify(r.play).slice(0, 300));
	assert.equal(r.playEnd.current, null);
	assert.match(r.why, /^Line \d+ runs if:/);
	assert.ok(r.both.tabs.includes('Logic Map (selected)'), JSON.stringify(r.both.tabs));
	assert.equal(r.dirty, false);
});

test('Hidden C++: the marks, the chips, the card of a lookup group with its connector, and the switches', { timeout: 600000 }, async () => {
	const r = await run('side-cost-snapshot.mjs');
	assert.match(r.default.marks, /lookup:7/);
	assert.ok(r.default.chips.length > 0 && r.chip.length > 0);
	// the group of the lookups of tapTopic: 5 lookups on one path, and a connector to the 6 other lookups
	assert.match(r.lookup.card, /5 lookups of tapTopic in last_read/);
	assert.equal(r.lookup.connector, 6);
	// the switch of the copies removes their marks
	assert.match(r.noCopies.marks, /^copy:0 /);
	assert.equal(r.dirty, false);
});

test('Change Ripple: the story, the wave, the cards with their notes and exits, and the file view', { timeout: 600000 }, async () => {
	const r = await run('side-ripple-snapshot.mjs');
	assert.ok(r.wave.lit > 0 && r.replay.lit > 0, JSON.stringify([r.wave, r.replay]));
	const cards = r.story.cards;
	assert.ok(cards.length >= 3, JSON.stringify(cards.map((c) => c.where)));
	assert.ok(cards[0].where.startsWith('solve_power_plan()'), cards[0].where);
	assert.ok(cards.some((c) => c.notes.includes('calls solve_power_plan()')));
	assert.ok(cards.some((c) => c.exits.some((e) => e.startsWith('decides the call of'))), JSON.stringify(cards.map((c) => c.exits)));
	assert.equal(r.story.links.length, cards.length - 1);
	assert.equal(r.fileView.mode, 'file');
	assert.ok(r.fileView.reached > 0 && r.fileView.hints.length > 0, JSON.stringify(r.fileView).slice(0, 300));
	assert.equal(r.back, true);
	assert.ok(r.changeView.changed.length > 0);
	assert.equal(r.dirty, false);
});
