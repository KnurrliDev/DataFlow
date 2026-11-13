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

test('side view: the colors, the guides, the scroll sync in both directions, the cursor with no text editor, Show Calls, Ctrl+click, Outline, forward declarations and the restore after a reload', { timeout: 600000 }, async () => {
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
	// with Ctrl down, a name gets the underline of a link. Ctrl+click goes to the definition in the side view only: the
	// cursor of the text editor stays. The mouse button Back comes back
	const g = r.goto;
	assert.deepEqual(g.hover, { isLink: true, decoration: 'underline', cursor: 'pointer' }, JSON.stringify(g));
	assert.equal(g.afterKeyUp, false, JSON.stringify(g));
	assert.equal(g.file, 'types.hpp', JSON.stringify(g));
	assert.equal(g.cursor, g.declLine, JSON.stringify(g));
	assert.equal(g.statusAfter, g.statusBefore, JSON.stringify(g));
	assert.equal(g.back, 'battery.cpp', JSON.stringify(g));
	// a right-click on a type: the menu of VS Code has Outline, and the panel shows the members with the layout. The filter
	// keeps the matching members, a click on a member moves the side view, the panel stays, and Escape closes it
	const o = r.outline;
	assert.equal(o.menu, 'Outline', JSON.stringify(o));
	assert.equal(o.panel?.title, 'struct HomeBatteryCtrl', JSON.stringify(o));
	assert.match(o.panel.layout, /^\d+ bytes · align \d+/, JSON.stringify(o));
	assert.equal(o.panel.hasBar, true);
	assert.deepEqual([o.panel.groups, o.panel.items], [['▾Data members10'], 10], JSON.stringify(o));
	assert.ok(o.filtered.length > 0 && o.filtered.length < 10 && o.filtered.every((t) => /charg/i.test(t)), JSON.stringify(o.filtered));
	assert.deepEqual([o.file, o.isOpen, o.afterEscape, o.back], ['types.hpp', true, false, 'battery.cpp'], JSON.stringify(o));
	// Include Hierarchy in a header: the include of types.hpp gets the hint and the badge of forward declarations. The
	// details show the declarations with Copy, and the first line that needs the include of worker_pool.hpp
	const f = r.forward;
	assert.equal(f.file, 'planner.hpp', JSON.stringify(f));
	assert.equal(f.hint, '→ 5 forward declarations', JSON.stringify(f));
	assert.equal(f.details?.title, 'Forward declarations can replace this include', JSON.stringify(f));
	assert.match(f.details.code, /^namespace electricity::power_ctrl \{ struct MeterRead; \}\nnamespace charge \{ struct State;/, JSON.stringify(f));
	assert.equal(f.details.types.length, 5, JSON.stringify(f));
	assert.equal(f.details.copy, 'Copy');
	assert.deepEqual(f.badges, ['<battery/types.hpp>'], JSON.stringify(f));
	assert.ok(f.stats.includes('1 replaceable by forward declarations'), JSON.stringify(f.stats));
	assert.equal(f.copied, true, JSON.stringify(f));
	assert.match(f.check, /^Check: no errors with these declarations \(parse [\d.]+ m?s\)\.$/, JSON.stringify(f));
	assert.match(f.needed ?? '', /^The file needs the full header: line \d+ uses electricity::WorkerPool, a data member of the type\.$/, JSON.stringify(f));
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

test('Layers of two clients: the bars in the colors of the clients, the groups of the tab Model, the buttons and the clicks of an extension, and its tab', { timeout: 600000 }, async () => {
	const r = await run('side-clients-snapshot.mjs');
	assert.deepEqual(r.ids, { notes: ['n1'], detail: 'd1' });
	// the bars of the MCP client have the color of the model. The bars of the extension come after them in a chart color.
	// The bars are in the sequence of the blocks, so the test sorts them by their position
	const byLeft = (bars) => bars.map((b) => [b.cls, b.left]).sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]));
	assert.deepEqual(byLeft(r.bars), [['mbar lv-0', '1px'], ['mbar lv-1', '6px'], ['mbar lv-0 cl-1', '11px'], ['mbar lv-1 cl-1', '16px']]);
	assert.equal(r.bars.find((b) => b.cls === 'mbar lv-0').color, r.want.model);
	assert.equal(r.bars.find((b) => b.cls === 'mbar lv-0 cl-1').color, r.want.blue);
	assert.deepEqual(r.modelBar, { note: 'Waits for the solver', buttons: ['Fix it', 'Skip'] });
	assert.equal(r.noteTag, 'Note of ui-client: Waits for the solver');
	assert.deepEqual(r.groups, [
		{ client: 'ui-test', blocks: ['1', '1a'], buttons: [] },
		{ client: 'ui-client', blocks: ['1', '1a'], buttons: ['Fix it', 'Skip', 'Open the plan'] },
	]);
	assert.deepEqual(r.card, { client: 'ui-client', buttons: ['Open the plan'] });
	assert.deepEqual(r.step, ['Run the check']);
	// the tab of the extension comes after the tabs of DataFlow, with its sections, its rows and its buttons. A click on a
	// row with a place shows its line
	assert.deepEqual(r.tabNames.slice(-2), ['Guide', 'Plan']);
	assert.deepEqual(r.tab, {
		client: 'ui-client',
		sections: [
			{
				title: 'Steps',
				rows: [
					{ text: 'Check the wait for the solver', isLink: true, badge: 'risk 3', detail: 'The solver runs on a worker thread.', bold: 'solver', buttons: ['Accept'] },
					{ text: 'Write the tests', isLink: false, buttons: [] },
				],
			},
			{ title: 'Notes', rows: [], empty: 'No items.' },
		],
	});
	assert.equal(r.tabPlace, r.lines.detail);
	// each click goes to the extension with the id of the button, the id of the item, the file and the line
	assert.deepEqual(r.clicks, [
		{ kind: 'note', action: 'fix', item: 'n1', file: 'battery.cpp', line: r.lines.note },
		{ kind: 'detail', action: 'open', item: 'd1', file: 'battery.cpp', line: r.lines.detail },
		{ kind: 'step', action: 'run', file: 'battery.cpp', line: r.lines.note, step: 1 },
		{ kind: 'tab', action: 'accept', item: 'r1', file: 'battery.cpp', line: r.lines.detail },
	]);
	// clear of the MCP client removes only its layer, and the bars of the extension go to the first columns
	assert.equal(r.cleared, 1);
	assert.deepEqual(byLeft(r.barsAfterClear), [['mbar lv-0', '1px'], ['mbar lv-1', '6px']]);
});

test('Guided review: the files of a folder, a plan of the model, the marks, the notes, a command and the guide after a reload', { timeout: 600000 }, async () => {
	const r = await run('side-guide-snapshot.mjs');
	assert.ok(r.prompts.includes('guided-review'), JSON.stringify(r.prompts));
	// get_review gives the C and C++ files of the folder, the changed file first with its diff, and the paths that do not
	// exist
	assert.match(r.facts.files[0], /^src\/battery\.cpp \d+ changed 69$/, JSON.stringify(r.facts));
	assert.ok(r.facts.files.length >= 2 && r.facts.files.slice(1).every((f) => !f.includes('changed')), JSON.stringify(r.facts.files));
	assert.deepEqual(r.facts.notFound, ['tests']);
	assert.deepEqual(r.facts.diff, ['-      |       if (cost < 1e-5) {', '+   69 |       if (cost < 1e-4) {']);
	// no ripple: Change Ripple stays off, and the side view shows no story
	assert.deepEqual(r.noRipple, { ripplePressed: 'false', story: false });
	// the plan: the bar, the lines of step 1, its tag and its checks
	assert.deepEqual(r.plan.steps.map((s) => s.file), Array(4).fill('src/battery.cpp'));
	assert.deepEqual(r.step1.lines, [69, 70, 71]);
	assert.equal(r.step1.tag, 'review1/4 Check the new limit');
	assert.equal(r.step1.checks.length, 2);
	// the mark OK and Next in the bar, then a note and the marks of the model
	assert.deepEqual([r.step2.current, r.step2.statuses[0]], [2, 'st-ok']);
	assert.match(r.afterNote.note ?? '', /empty res/);
	assert.deepEqual(r.step4.statuses, ['st-ok', 'st-question', 'st-todo', 'st-issue']);
	assert.equal(r.step4.progress, '3 of 4 steps reviewed: 1 issue, 1 question');
	// get_view gives the step that the user looks at, and the marks
	assert.equal(r.view.currentStep, 4);
	assert.deepEqual(r.view.steps.map((s) => s.status), ['ok', 'question', 'todo', 'issue']);
	// the note of the user from the field of the step goes to the model
	assert.equal(r.userNote, 'Check the lock in the worker too.');
	// a second plan on the top of the stack: the tab Guide names the first plan under it, the step in CMakeLists.txt opens in
	// the text editor, and the label shows next to the title. Close review shows the first plan again at its step
	assert.deepEqual(r.stack.guides, ['claude-code review Review of the build', 'claude-code review Review of the new cost limit']);
	assert.deepEqual([r.stack.below, r.stack.label, r.stack.file], [['Review of the new cost limit'], 'build', 'text editor']);
	assert.match(r.stack.editor, /CMakeLists\.txt/);
	assert.deepEqual([r.afterSecondClose.current, r.afterSecondClose.statuses], [4, ['st-ok', 'st-question', 'st-todo', 'st-issue']]);
	// the command Previous Review Step, and the guide after a reload of the window
	assert.equal(r.afterCommand, 3);
	assert.equal(r.afterReload.current, 3);
	assert.deepEqual(r.afterReload.statuses, ['st-ok', 'st-question', 'st-todo', 'st-issue']);
	assert.equal(r.afterReload.lines[0], 101);
	// Close review removes the bar and the lines of the step
	assert.equal(r.closed, true);
});

test('Diff walk: the command with the list of branches, the marks of the diff in the code, the card of the removed line, the diff in the tab Guide, the diff editor and a plan of the model', { timeout: 600000 }, async () => {
	const r = await run('side-walk-snapshot.mjs');
	// Heat on: each step of the plan of the model gets the flames and the score of its hottest function. get_diff gives the
	// heat of the changed functions
	assert.equal(r.stepHeat?.length, 2, JSON.stringify(r.stepHeat));
	for (const h of r.stepHeat) {
		assert.ok(h && h.flames >= 1 && h.flames <= 5 && /^b-(cool|warm|hot|veryHot)$/.test(h.band) && /^\d+$/.test(h.text.trim()), JSON.stringify(h));
	}
	assert.match(r.stepHeat[0].title, /^electricity::power_ctrl::process\nHeat \d+ of 100: (cool|warm|hot|very hot)$/);
	assert.ok(r.hottest.includes('electricity::power_ctrl::solve_power_plan') && r.hottest.includes('electricity::power_ctrl::process'), JSON.stringify(r.hottest));
	// the list of the changes: the label and the detail of each item
	for (const label of ['Changes that are not committed', 'Changes of the branch', 'Changes against a branch…', 'Changes since a commit…']) {
		assert.ok(r.items.includes(label), JSON.stringify(r.items));
	}
	// the list of branches has main, and not the active branch review
	assert.ok(r.branches.includes('main') && !r.branches.includes('review'), JSON.stringify(r.branches));
	// step 1: the committed change in solve_power_plan(). The changed line is green with the changed digit, and its chip
	// gives the old line
	const s1 = r.step1;
	assert.equal(s1.guideTitle, 'Changes of review against main');
	assert.equal(s1.pill, 'diff');
	assert.deepEqual(s1.steps, ['Changes in solve_power_plan()', 'Changes in process()']);
	assert.equal(s1.current, 1);
	assert.equal(s1.stats, '+1 −1');
	assert.deepEqual(s1.frame, [69]);
	assert.deepEqual(s1.added, [69]);
	assert.deepEqual(s1.removedAt, [69]);
	assert.equal(s1.chip, '−1  if (cost < 1e-5) {');
	assert.deepEqual(s1.changedText, ['4']);
	assert.equal(s1.tag, 'diff1/2 Changes in solve_power_plan()');
	assert.match(s1.source, /^Changes against main \([0-9a-f]{7}\)$/);
	assert.equal(s1.modelPill, false);
	// the diff in the tab Guide, with no common indent
	const rows = s1.diffRows.map((t) => t[0] + t.slice(1).trim());
	assert.ok(rows.includes('-if (cost < 1e-5) {') && rows.includes('+if (cost < 1e-4) {'), JSON.stringify(s1.diffRows));
	assert.deepEqual(s1.changedInDiff, ['5', '4']);
	assert.equal(r.card.title, 'Before the change: 1 line');
	assert.deepEqual(r.card.rows, ['      if (cost < 1e-5) {']);
	assert.ok(r.card.spans > 0);
	// step 2: the new line in process() that is not saved
	assert.deepEqual([r.step2.current, r.step2.added, r.step2.removedAt, r.step2.chip, r.step2.stats], [2, [99], [], null, '+1 −0']);
	assert.match(r.diffEditor, /^battery\.cpp: main \([0-9a-f]{7}\) to working tree$/);
	// the model: get_diff, a plan with the new line first, and a note with the mark issue
	assert.ok(r.prompts.includes('diff-walk'), JSON.stringify(r.prompts));
	assert.deepEqual(r.hunks, ['src/battery.cpp h1 69-69 electricity::power_ctrl::solve_power_plan', 'src/battery.cpp h2 99-99 electricity::power_ctrl::process']);
	assert.deepEqual(r.plan.steps.map((s) => s.title), ['Add the counter of the cycles', 'Loosen the limit of the cost']);
	assert.deepEqual([r.model1.title, r.model1.added, r.model1.modelPill], ['Add the counter of the cycles', [99], true]);
	assert.match(r.model1.source, /^modelPlan of claude-code\. Changes against main \([0-9a-f]{7}\)$/);
	assert.deepEqual([r.model2.current, r.model2.statuses], [2, ['st-todo', 'st-issue']]);
	assert.match(r.model2.note ?? '', /Check the tests of the prices/);
	assert.equal(r.view.kind, 'diff walk');
	assert.equal(r.view.currentStep, 2);
	// the walk of the model is on the top of the walk of the command. Close walk shows the walk of the command again at its
	// step, and a second Close walk removes the guide
	assert.deepEqual(r.below, ['Changes of review against main']);
	assert.deepEqual([r.afterClose.guideTitle, r.afterClose.current, r.afterClose.title], ['Changes of review against main', 2, 'Changes in process()']);
	assert.equal(r.closed, true);
});

test('Heat: the flames and the strips of the functions, the tab Heat with the reasons of the function at the cursor, a click in the list and Heat off', { timeout: 600000 }, async () => {
	const r = await run('side-heat-snapshot.mjs');
	const h = r.heat;
	// the tab lists the 6 functions of the file, the hottest first, each with 1 to 5 flames
	assert.equal(h.items.length, 6, JSON.stringify(h.items));
	const scores = h.items.map((i) => i.score);
	assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
	assert.ok(h.items.every((i) => i.flames >= 1 && i.flames <= 5), JSON.stringify(h.items));
	// the code: flames in the color of the band on the line of the name of each rendered function, and the strips
	assert.ok(h.flames.length > 0, JSON.stringify(h));
	for (const f of h.flames) {
		assert.ok(f.count >= 1 && f.count <= 5 && /^b-(cool|warm|hot|veryHot)$/.test(f.band), JSON.stringify(f));
		assert.match(f.title, /^Heat \d+ of 100: (cool|warm|hot|very hot)\. Show the reasons in the tab Heat\.$/);
	}
	assert.ok(h.bars > 0);
	// the function at the cursor: process() with the points of reach, risk and history
	assert.equal(h.current.name, 'electricity::power_ctrl::process');
	assert.deepEqual(h.current.groups, ['Reach', 'Risk', 'History']);
	assert.ok(h.current.reasons.includes('+8 types.hpp with the declaration is in 2 of 2 source files'), JSON.stringify(h.current.reasons));
	assert.ok(h.current.reasons.some((t) => /^\+\d+ \d+ decisions$/.test(t)), JSON.stringify(h.current.reasons));
	assert.ok(h.current.reasons.includes('+2 Changed in 1 commit') && h.current.reasons.includes('+2 Changed in the last 30 days'), JSON.stringify(h.current.reasons));
	// the call graph: main() in main.cpp calls process(). The fixture has no frame functions
	assert.ok(h.current.reasons.includes('+2 1 function calls it directly') && h.current.reasons.includes('+1 Callers in 1 other file'),
		JSON.stringify(h.current.reasons));
	assert.match(h.graph, /^Call graph: \d+ functions in 2 source files$/);
	assert.match(h.graphText, /The call graph has no frame functions/);
	assert.ok(!h.notices.some((n) => /call graph/.test(n)) && h.scan === null, JSON.stringify(h));
	// a click in the list shows the function in the code, and Heat off removes the flames and the strips
	assert.equal(typeof r.revealed, 'number');
	assert.equal(r.off, true);
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
