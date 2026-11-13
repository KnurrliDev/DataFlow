import * as assert from 'assert';
import * as path from 'path';
import type { TextChange } from '../../lenses/blocks';
import type { HeatBand, HeatFunction, HeatModel } from '../../lenses/heat';
import {
	GuideFileLines, GuideFileLookup, guideFacts, guideProgress, guideSummary, MAX_GUIDE_STEPS, MAX_REVIEW_FILES, MAX_STEP_CHECKS, MAX_STEP_DATA, moveGuide,
	resolveGuidePlan, restoreGuide, reviewFacts, stepIndex, storeGuide, withClientData, withCurrent, withNote, withStatus, withUserNote,
} from '../../review/guide';
import {
	dropGuide, findGuide, guideChangeOf, guideOwner, guideRef, GuideStack, guidesText, pushGuide, putGuide, raiseGuide, stackGuides,
} from '../../review/stack';
import type { SideGuide } from '../../side/protocol';

// The guided review: the files to review for the model, the check of the plan of the model, the state of the guide and
// its summary

const ROOT = path.resolve('/repo');
const CPP = path.join(ROOT, 'src', 'battery.cpp');
const HPP = path.join(ROOT, 'include', 'battery', 'types.hpp');
const FILES: Record<string, { file: string; lineCount: number }> = {
	'src/battery.cpp': { file: CPP, lineCount: 209 },
	[CPP]: { file: CPP, lineCount: 209 },
	'include/battery/types.hpp': { file: HPP, lineCount: 194 },
	[HPP]: { file: HPP, lineCount: 194 },
};
const lookup: GuideFileLookup = (f) => FILES[f];

const step = (title: string, file: string | undefined, lines: unknown, extra: Record<string, unknown> = {}) =>
	({ title, ...(file ? { file } : {}), lines, text: `Look at ${title}.`, ...extra });

const plan = {
	title: 'Review of the new limit',
	summary: 'The solver accepts a higher cost.',
	steps: [
		step('Check the new limit', 'src/battery.cpp', [69, 71], { kind: 'change', checks: ['Is 1e-4 the right limit?'] }),
		step('Follow the result to process()', undefined, [101, 111], { kind: 'ripple' }),
		step('Read the type of the result', 'include/battery/types.hpp', [88, 88], { kind: 'context' }),
	],
};

suite('Guided review', () => {
	test('A plan resolves its files, a step with no file gets the file of the step before, and the first step is the current step', () => {
		const { guide, problems } = resolveGuidePlan(plan, lookup, { seq: 3, client: 'claude-code', target: 'main' });
		assert.deepStrictEqual(problems, []);
		assert.ok(guide);
		assert.strictEqual(guide.title, 'Review of the new limit');
		assert.strictEqual(guide.current, 0);
		assert.strictEqual(guide.seq, 3);
		assert.strictEqual(guide.client, 'claude-code');
		assert.strictEqual(guide.target, 'main');
		assert.deepStrictEqual(guide.steps.map((s) => [s.file, s.name, s.first, s.last, s.kind, s.status]), [
			[CPP, 'battery.cpp', 69, 71, 'change', 'todo'],
			[CPP, 'battery.cpp', 101, 111, 'ripple', 'todo'],
			[HPP, 'types.hpp', 88, 88, 'context', 'todo'],
		]);
		assert.deepStrictEqual(guide.steps[0].checks, ['Is 1e-4 the right limit?']);
	});

	test('A wrong plan gives one problem for each wrong step, and no guide', () => {
		const wrong = {
			steps: [
				step('', 'src/battery.cpp', [69, 71]),
				step('Unknown file', 'src/nothing.cpp', [1, 2]),
				step('Lines out of the file', 'src/battery.cpp', [200, 230]),
				step('Lines in the wrong sequence', 'src/battery.cpp', [71, 69]),
				step('One line only', 'src/battery.cpp', 69),
				step('Wrong kind', 'src/battery.cpp', [1, 1], { kind: 'nice' }),
			],
		};
		const { guide, problems } = resolveGuidePlan(wrong, lookup, { seq: 1 });
		assert.strictEqual(guide, undefined);
		assert.deepStrictEqual(problems, [
			'Step 1 has no "title".',
			'Step 2: the file src/nothing.cpp is not in the project. For a file that is not there yet, give "newFile".',
			'Step 3: the lines 200 to 230 are not in battery.cpp, which has 209 lines.',
			'Step 4: the lines 71 to 69 are not a range of lines from 1.',
			'Step 5: "lines" must be two whole numbers, the first and the last line.',
			'Step 6: "kind" must be one of change, ripple, context, risk, test.',
		]);
		assert.deepStrictEqual(resolveGuidePlan({ steps: [] }, lookup, { seq: 1 }).problems, ['Give "steps": a list with one step or more.']);
		const many = { steps: Array.from({ length: MAX_GUIDE_STEPS + 1 }, (_, i) => step(`Step ${i}`, 'src/battery.cpp', [1, 1])) };
		assert.match(resolveGuidePlan(many, lookup, { seq: 1 }).problems[0], /steps at most/);
		// with no file in the first step and no default file, the step has no file
		assert.deepStrictEqual(resolveGuidePlan({ steps: [step('No file', undefined, [1, 1])] }, lookup, { seq: 1 }).problems, ['Step 1 has no "file".']);
	});

	test('A step on a file that the lookup refuses gets the problem of the lookup', () => {
		const refusing: GuideFileLookup = (f) => (f === 'CMakeLists.txt' ? { file: path.join(ROOT, f), lineCount: 0, problem: 'CMakeLists.txt is not a C or C++ file.' } : lookup(f));
		const { guide, problems } = resolveGuidePlan({ steps: [step('Read the build', 'CMakeLists.txt', [1, 2])] }, refusing, { seq: 1 });
		assert.strictEqual(guide, undefined);
		assert.deepStrictEqual(problems, ['Step 1: CMakeLists.txt is not a C or C++ file.']);
	});

	test('An edit moves the steps of its file, and a step whose lines the edit deleted keeps the line of the edit', () => {
		const { guide } = resolveGuidePlan(plan, lookup, { seq: 1 });
		assert.ok(guide);
		const change = (startLine: number, startChar: number, endLine: number, endChar: number, text: string): TextChange =>
			({ range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } }, text });
		// two new lines above all steps of battery.cpp. The step in types.hpp stays
		const added = moveGuide(guide, CPP, [change(10, 0, 10, 0, 'a\nb\n')]);
		assert.deepStrictEqual(added.steps.map((s) => [s.first, s.last]), [[71, 73], [103, 113], [88, 88]]);
		// a change in one line moves no step, so the guide stays the same object
		assert.strictEqual(moveGuide(guide, CPP, [change(69, 4, 69, 8, 'x')]), guide);
		// an edit of a different file moves nothing
		assert.strictEqual(moveGuide(guide, path.join(ROOT, 'src', 'main.cpp'), [change(0, 0, 0, 0, 'a\n')]), guide);
		// the edit deletes the lines 100 to 115, with the lines of step 2: the step keeps line 100
		const deleted = moveGuide(guide, CPP, [change(99, 0, 115, 0, '')]);
		assert.deepStrictEqual(deleted.steps.map((s) => [s.first, s.last]), [[69, 71], [100, 100], [88, 88]]);
	});

	test('A stored guide comes back at the nearest place with the texts of its lines, and a step of a file that is gone goes away', () => {
		const { guide } = resolveGuidePlan(plan, lookup, { seq: 1 });
		assert.ok(guide);
		const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
		const files: Record<string, string[]> = { [CPP]: text(209), [HPP]: text(194) };
		const lines: GuideFileLines = (f) => (files[f] ? { text: (l) => files[f][l - 1], count: files[f].length } : undefined);
		const stored = storeGuide(withCurrent(withStatus(guide, 0, 'ok'), 2), lines);
		assert.deepStrictEqual(stored.texts[0], { first: 'line 69', last: 'line 71' });
		// three new lines at the top of battery.cpp in the next session: the steps of battery.cpp move down by three
		files[CPP] = ['new 1', 'new 2', 'new 3', ...text(209)];
		const back = restoreGuide(stored, lines);
		assert.ok(back);
		assert.deepStrictEqual(back.steps.map((s) => [s.first, s.last, s.status]), [[72, 74, 'ok'], [104, 114, 'todo'], [88, 88, 'todo']]);
		assert.strictEqual(back.current, 2);
		// a text with no match keeps the lines in the file
		files[HPP] = text(50);
		assert.deepStrictEqual(restoreGuide(stored, lines)?.steps[2].first, 50);
		// types.hpp is gone: its step goes away, and the current step stays on the step before it
		delete files[HPP];
		const fewer = restoreGuide(stored, lines);
		assert.deepStrictEqual(fewer?.steps.map((s) => s.title), ['Check the new limit', 'Follow the result to process()']);
		assert.strictEqual(fewer?.current, 1);
		delete files[CPP];
		assert.strictEqual(restoreGuide(stored, lines), undefined);
	});

	test('Long texts get shorter, and a step keeps a maximum of five checks', () => {
		const long = { steps: [step('x'.repeat(200), 'src/battery.cpp', [1, 2], { checks: Array.from({ length: 8 }, (_, i) => `Check ${i}?`) })] };
		const { guide } = resolveGuidePlan(long, lookup, { seq: 1 });
		assert.ok(guide);
		assert.strictEqual(guide.steps[0].title.length, 80);
		assert.ok(guide.steps[0].title.endsWith('…'));
		assert.strictEqual(guide.steps[0].checks.length, MAX_STEP_CHECKS);
		assert.strictEqual(guide.title, 'Review of the changes');
	});

	test('The current step, the marks and the notes change the guide, and a wrong step changes nothing', () => {
		const { guide } = resolveGuidePlan(plan, lookup, { seq: 1 });
		assert.ok(guide);
		const moved = withCurrent(guide, 2);
		assert.strictEqual(moved.current, 2);
		assert.strictEqual(withCurrent(moved, 7), moved);
		assert.strictEqual(withCurrent(moved, -1), moved);
		assert.strictEqual(stepIndex(guide, 3), undefined);
		const marked = withStatus(withStatus(moved, 0, 'ok'), 1, 'issue');
		assert.deepStrictEqual(marked.steps.map((s) => s.status), ['ok', 'issue', 'todo']);
		assert.strictEqual(withStatus(marked, 0, 'ok'), marked);
		assert.strictEqual(guide.steps[0].status, 'todo', 'the old guide does not change');
		const noted = withNote(marked, 1, '  The result can be **empty**.  ');
		assert.strictEqual(noted.steps[1].note, 'The result can be **empty**.');
		assert.strictEqual(withNote(noted, 1, '').steps[1].note, undefined);
		assert.strictEqual(guideProgress(noted), '2 of 3 steps reviewed: 1 issue');
	});

	test('The summary lists each step with its place, its mark and the note of the model', () => {
		const { guide } = resolveGuidePlan(plan, lookup, { seq: 1 });
		assert.ok(guide);
		const reviewed: SideGuide = withNote(withStatus(withStatus(guide, 0, 'ok'), 1, 'question'), 1, 'Is the future\nalways ready here?');
		assert.strictEqual(guideSummary(reviewed), [
			'## Review of the new limit',
			'',
			'The solver accepts a higher cost.',
			'',
			'2 of 3 steps reviewed: 1 question.',
			'',
			'- [x] 1. **Check the new limit** (`battery.cpp:69-71`): OK',
			'- [x] 2. **Follow the result to process()** (`battery.cpp:101-111`): question',
			'  > Is the future',
			'  > always ready here?',
			'- [ ] 3. **Read the type of the result** (`types.hpp:88`): not reviewed',
		].join('\n'));
		assert.deepStrictEqual(guideFacts(reviewed), {
			id: 'g1',
			owner: 'model',
			title: 'Review of the new limit',
			currentStep: 1,
			progress: '2 of 3 steps reviewed: 1 question',
			steps: [
				{ step: 1, title: 'Check the new limit', file: 'battery.cpp', lines: [69, 71], status: 'ok' },
				{ step: 2, title: 'Follow the result to process()', file: 'battery.cpp', lines: [101, 111], status: 'question', hasNote: true, note: 'Is the future\nalways ready here?' },
				{ step: 3, title: 'Read the type of the result', file: 'types.hpp', lines: [88, 88], status: 'todo' },
			],
		});
	});

	test('The facts of the files to review have the diff of a changed file with line numbers, and paths relative to the root', () => {
		const facts = reviewFacts({
			root: ROOT, target: 'main', base: 'main (merge base 1a2b3c4)', missing: ['src/nothing.cpp'], skipped: ['CMakeLists.txt'],
			files: [
				{
					file: CPP, lineCount: 209, hunks: [[
						{ kind: 'context', text: '    if (opt.last_cost) {', oldLine: 68, newLine: 68 },
						{ kind: 'removed', text: '      if (cost < 1e-5) {', oldLine: 69, newLine: 69 },
						{ kind: 'added', text: '      if (cost < 1e-4) {', newLine: 69 },
					]],
				},
				{ file: HPP, lineCount: 194, hunks: [] },
			],
		});
		assert.deepStrictEqual(facts, {
			root: ROOT,
			target: 'main',
			base: 'main (merge base 1a2b3c4)',
			files: [
				{
					file: 'src/battery.cpp', lines: 209, isChanged: true, changedLines: [69],
					diff: ['    68 |     if (opt.last_cost) {', '-      |       if (cost < 1e-5) {', '+   69 |       if (cost < 1e-4) {'].join('\n'),
				},
				{ file: 'include/battery/types.hpp', lines: 194, isChanged: false },
			],
			notFound: ['src/nothing.cpp'],
			notCpp: ['CMakeLists.txt'],
		});
	});

	test('With no target branch, the facts have no diff, and more files than the limit give their number', () => {
		const many = Array.from({ length: MAX_REVIEW_FILES + 3 }, (_, i) => ({ file: path.join(ROOT, 'src', `f${i}.cpp`), lineCount: 10, hunks: [] }));
		const facts = reviewFacts({ root: ROOT, missing: [], skipped: [], files: many, notice: 'The folder has no git repository, so the files have no changes.' }) as {
			files: unknown[]; moreFiles: number; target?: string; notice: string;
		};
		assert.strictEqual(facts.files.length, MAX_REVIEW_FILES);
		assert.strictEqual(facts.moreFiles, 3);
		assert.strictEqual(facts.target, undefined);
		assert.match(facts.notice, /no git repository/);
	});

	test('With the heat of the changed files, a changed file has the heat of its changed functions, and hottestChanges gives them', () => {
		const fn = (name: string, first: number, last: number, score: number, band: HeatBand): HeatFunction => ({
			name, qualifiedName: `power::${name}`, first, last, nameLine: first, score, band, flames: 1, reach: 0, risk: 0, history: 0, isSiloed: false,
			isReachComplete: true, reasons: [{ group: 'risk', points: 10, text: '24 decisions', id: 'decisions', value: 24 }],
		});
		const model: HeatModel = { file: CPP, notices: [], isReachComplete: true, functions: [fn('setup', 10, 20, 80, 'veryHot'), fn('solve', 60, 80, 55, 'hot')] };
		// a removed block marks the line after it: the changed lines 69 and 75 are in solve(), not in setup()
		const facts = reviewFacts({
			root: ROOT, missing: [], skipped: [],
			files: [{
				file: CPP, lineCount: 209, hunks: [
					[{ kind: 'removed', text: '      if (cost < 1e-5) {', oldLine: 69, newLine: 69 }, { kind: 'added', text: '      if (cost < 1e-4) {', newLine: 69 }],
					[{ kind: 'removed', text: '      return;', oldLine: 76, newLine: 75 }],
				],
			}, { file: HPP, lineCount: 194, hunks: [] }],
		}, new Map([[CPP, model], [HPP, { ...model, file: HPP }]])) as {
			files: { changedFunctions?: { function: string; lines: number[]; score: number; band: string }[] }[];
			hottestChanges: { function: string; file: string; score: number; band: string; reasons: string[] }[];
		};
		assert.deepStrictEqual(facts.files[0].changedFunctions, [{ function: 'power::solve', lines: [60, 80], score: 55, band: 'hot', isReachComplete: true }]);
		// a file with no changes has no changed functions
		assert.strictEqual(facts.files[1].changedFunctions, undefined);
		assert.deepStrictEqual(facts.hottestChanges, [
			{ function: 'power::solve', lines: [60, 80], score: 55, band: 'hot', isReachComplete: true, file: 'src/battery.cpp', reasons: ['24 decisions (+10 risk)'] },
		]);
	});
});

// The steps of a guide in other text files and in new files, the data of a client on a step, and the note of the user
suite('Guided review: other files, data of the client and the note of the user', () => {
	const CMAKE = path.join(ROOT, 'CMakeLists.txt');
	const NEW = path.join(ROOT, 'tests', 'fake_solver.hpp');
	const withText: GuideFileLookup = (f) => (f === 'CMakeLists.txt' || f === CMAKE ? { file: CMAKE, lineCount: 30, isCpp: false } : lookup(f));
	const newFile = (f: string) => (f === 'tests/fake_solver.hpp' ? { file: NEW } : f === 'src/battery.cpp' ? { file: CPP, lineCount: 209 } : undefined);

	test('A step can be in a text file that is not a C or C++ file, or in a new file with no lines', () => {
		const { guide, problems } = resolveGuidePlan({
			steps: [
				step('Add the test to the build', 'CMakeLists.txt', [12, 14]),
				{ title: 'Write the fake solver', newFile: 'tests/fake_solver.hpp', text: 'A solver for the tests.' },
				{ title: 'Use it in a test', newFile: 'tests/fake_solver.hpp', lines: [3, 9], text: 'The test.' },
				step('Back to the build', undefined, [1, 2]),
			],
		}, withText, { seq: 4, newFile });
		assert.deepStrictEqual(problems, []);
		assert.ok(guide);
		assert.deepStrictEqual([guide.id, guide.owner], ['g4', undefined]);
		// a step with no file gets the file of the last step with a file, not the new file
		assert.deepStrictEqual(guide.steps.map((s) => [s.file, s.name, s.first, s.last, s.fileKind]), [
			[CMAKE, 'CMakeLists.txt', 12, 14, 'text'],
			[NEW, 'fake_solver.hpp', 1, 1, 'new'],
			[NEW, 'fake_solver.hpp', 3, 9, 'new'],
			[CMAKE, 'CMakeLists.txt', 1, 2, 'text'],
		]);
		const wrong = resolveGuidePlan({
			steps: [
				{ title: 'Both', file: 'src/battery.cpp', newFile: 'tests/fake_solver.hpp', lines: [1, 1], text: 'x' },
				{ title: 'Outside', newFile: '../outside.hpp', text: 'x' },
				{ title: 'Wrong lines', newFile: 'tests/fake_solver.hpp', lines: [5, 2], text: 'x' },
				{ title: 'There already', newFile: 'src/battery.cpp', lines: [300, 301], text: 'x' },
			],
		}, withText, { seq: 1, newFile });
		assert.deepStrictEqual(wrong.problems, [
			'Step 1: give "file" or "newFile", not both.',
			'Step 2: the new file ../outside.hpp is not in a folder of the project.',
			'Step 3: the lines 5 to 2 are not a range of lines from 1.',
			'Step 4: the lines 300 to 301 are not in battery.cpp, which has 209 lines.',
		]);
	});

	test('A step keeps the label and the data of the client, and wrong values are problems', () => {
		const data = { risk: 4, writer: 'user', parts: { a: [1, 2] } };
		const { guide, problems } = resolveGuidePlan({ steps: [step('A', 'src/battery.cpp', [1, 2], { label: '  risk   4 ', data })] }, lookup, { seq: 1 });
		assert.deepStrictEqual(problems, []);
		assert.ok(guide);
		assert.deepStrictEqual([guide.steps[0].label, guide.steps[0].data], ['risk 4', data]);
		assert.notStrictEqual(guide.steps[0].data, data, 'the guide keeps a copy of the data');
		assert.strictEqual(resolveGuidePlan({ steps: [step('A', 'src/battery.cpp', [1, 2], { label: 'x'.repeat(50) })] }, lookup, { seq: 1 }).guide?.steps[0].label,
			`${'x'.repeat(39)}…`);
		const wrong = resolveGuidePlan({
			steps: [
				step('A', 'src/battery.cpp', [1, 2], { label: 4 }),
				step('B', 'src/battery.cpp', [1, 2], { data: [1, 2] }),
				step('C', 'src/battery.cpp', [1, 2], { data: { text: 'x'.repeat(MAX_STEP_DATA) } }),
			],
		}, lookup, { seq: 1 });
		assert.deepStrictEqual(wrong.problems, [
			'Step 1: "label" must be a text.',
			'Step 2: "data" must be a JSON object.',
			`Step 3: "data" has ${MAX_STEP_DATA + 11} characters as JSON. The maximum is ${MAX_STEP_DATA}.`,
		]);
		// a client changes the label and the data. An empty label and null data remove them
		const labeled = withClientData(guide, 0, { label: 'risk 5' });
		assert.deepStrictEqual([labeled.steps[0].label, labeled.steps[0].data], ['risk 5', data]);
		const cleared = withClientData(labeled, 0, { label: '', data: null });
		assert.deepStrictEqual([cleared.steps[0].label, cleared.steps[0].data], [undefined, undefined]);
		assert.strictEqual(withClientData(cleared, 0, {}), cleared);
		assert.strictEqual(withClientData(cleared, 9, { label: 'x' }), cleared);
	});

	test('The note of the user and the data of the client go into the facts, the summary and the next session', () => {
		const { guide } = resolveGuidePlan({
			steps: [step('A', 'src/battery.cpp', [1, 2], { label: 'risk 4', data: { risk: 4 } }), { title: 'B', newFile: 'tests/fake_solver.hpp', text: 'x' }],
		}, lookup, { seq: 2, owner: 'my-extension', newFile });
		assert.ok(guide);
		const noted = withUserNote(guide, 0, '  Why not 1e-3?  ');
		assert.strictEqual(noted.steps[0].userNote, 'Why not 1e-3?');
		assert.strictEqual(withUserNote(noted, 0, 'Why not 1e-3?'), noted);
		assert.strictEqual(withUserNote(noted, 0, ' ').steps[0].userNote, undefined);
		const facts = guideFacts(noted);
		assert.deepStrictEqual([facts.id, facts.owner], ['g2', 'my-extension']);
		assert.deepStrictEqual(facts.steps, [
			{ step: 1, title: 'A', file: 'battery.cpp', lines: [1, 2], status: 'todo', label: 'risk 4', data: { risk: 4 }, userNote: 'Why not 1e-3?' },
			{ step: 2, title: 'B', file: 'fake_solver.hpp', lines: [1, 1], status: 'todo', fileKind: 'new' },
		]);
		assert.deepStrictEqual(guideSummary(noted).split('\n').slice(4), [
			'- [ ] 1. **A** [risk 4] (`battery.cpp:1-2`): not reviewed',
			'  > Note of the reviewer: Why not 1e-3?',
			'- [ ] 2. **B** (`fake_solver.hpp`, new file): not reviewed',
		]);
		// the next session: the step of the new file stays, also with no file
		const lines: GuideFileLines = (f) => (f === CPP ? { text: (l) => `line ${l}`, count: 209 } : undefined);
		const back = restoreGuide(storeGuide(noted, lines), lines);
		assert.deepStrictEqual(back?.steps.map((s) => [s.title, s.fileKind, s.userNote]), [['A', undefined, 'Why not 1e-3?'], ['B', 'new', undefined]]);
	});
});

// The stack of the guides: the top guide shows, and the guides under it stay
suite('The stack of the guides', () => {
	const guide = (n: number, owner?: string, kind?: 'diff'): SideGuide => ({
		id: `g${n}`, ...(owner ? { owner } : {}), ...(kind ? { kind } : {}), title: `Guide ${n}`, steps: [], current: 0, seq: n,
	});

	test('A new guide goes on the top, a close shows the guide under it, and a guide comes to the top', () => {
		let stack: GuideStack = { guidesBelow: [] };
		stack = pushGuide(stack, guide(1, 'user', 'diff'));
		stack = pushGuide(stack, guide(2, 'claude-code'));
		stack = pushGuide(stack, guide(3, 'my-extension'));
		assert.deepStrictEqual(stackGuides(stack).map((g) => g.id), ['g3', 'g2', 'g1']);
		assert.strictEqual(guidesText(stack), 'g3 "Guide 3" (my-extension, review), g2 "Guide 2" (claude-code, review), g1 "Guide 1" (user, diff walk)');
		assert.deepStrictEqual(guideRef(stack.guide!), { id: 'g3', owner: 'my-extension', title: 'Guide 3', kind: 'review' });
		assert.strictEqual(findGuide(stack, 'g2')?.title, 'Guide 2');
		// a plan with the id of a guide under the top guide replaces it in its place
		const replaced = putGuide(stack, { ...guide(2, 'claude-code'), title: 'New plan', seq: 4 });
		assert.deepStrictEqual(stackGuides(replaced).map((g) => g.title), ['Guide 3', 'New plan', 'Guide 1']);
		// a guide comes to the top, and the old top guide goes under it
		assert.deepStrictEqual(stackGuides(raiseGuide(stack, 'g1')).map((g) => g.id), ['g1', 'g3', 'g2']);
		assert.strictEqual(raiseGuide(stack, 'g9'), stack);
		// a close of the top guide shows the guide under it. A close of a guide under the top guide keeps the top guide
		assert.deepStrictEqual(stackGuides(dropGuide(stack, 'g3')).map((g) => g.id), ['g2', 'g1']);
		assert.deepStrictEqual(stackGuides(dropGuide(stack, 'g2')).map((g) => g.id), ['g3', 'g1']);
		assert.deepStrictEqual(stackGuides(dropGuide(dropGuide(dropGuide(stack, 'g3'), 'g2'), 'g1')), []);
	});

	test('The owner of a guide of an older version, and the change between two top guides', () => {
		const old = guide(1);
		assert.strictEqual(guideOwner({ ...old, kind: 'diff' }), 'user');
		assert.strictEqual(guideOwner(old), 'model');
		assert.strictEqual(guideOwner({ ...old, client: 'claude-code' }), 'claude-code');
		const { guide: a } = resolveGuidePlan(plan, lookup, { seq: 5, owner: 'x' });
		assert.ok(a);
		assert.strictEqual(guideChangeOf(undefined, a), 'start');
		assert.strictEqual(guideChangeOf(a, { ...a, id: 'g6' }), 'show');
		assert.strictEqual(guideChangeOf(a, { ...a, seq: 6 }), 'replace');
		assert.strictEqual(guideChangeOf(a, withStatus(a, 1, 'ok')), 'mark');
		assert.strictEqual(guideChangeOf(a, withUserNote(a, 1, 'why?')), 'userNote');
		assert.strictEqual(guideChangeOf(a, withNote(a, 1, 'because')), 'note');
		assert.strictEqual(guideChangeOf(a, withClientData(a, 1, { label: 'risk 1' })), 'label');
		assert.strictEqual(guideChangeOf(a, withCurrent(a, 2)), 'step');
		assert.strictEqual(guideChangeOf(a, { ...a, steps: a.steps.map((s) => ({ ...s, first: s.first + 1 })) }), 'move');
	});
});
