import * as assert from 'assert';
import * as path from 'path';
import {
	GuideFileLookup, guideFacts, guideProgress, guideSummary, MAX_GUIDE_STEPS, MAX_REVIEW_FILES, MAX_STEP_CHECKS, resolveGuidePlan, reviewFacts, stepIndex,
	withCurrent, withNote, withStatus,
} from '../../review/guide';
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
			'Step 2: the file src/nothing.cpp is not in the project.',
			'Step 3: the lines 200 to 230 are not in battery.cpp, which has 209 lines.',
			'Step 4: the lines 71 to 69 are not in battery.cpp, which has 209 lines.',
			'Step 5: "lines" must be two whole numbers, the first and the last line.',
			'Step 6: "kind" must be one of change, ripple, context, risk, test.',
		]);
		assert.deepStrictEqual(resolveGuidePlan({ steps: [] }, lookup, { seq: 1 }).problems, ['Give "steps": a list with one step or more.']);
		const many = { steps: Array.from({ length: MAX_GUIDE_STEPS + 1 }, (_, i) => step(`Step ${i}`, 'src/battery.cpp', [1, 1])) };
		assert.match(resolveGuidePlan(many, lookup, { seq: 1 }).problems[0], /steps at most/);
		// with no file in the first step and no default file, the step has no file
		assert.deepStrictEqual(resolveGuidePlan({ steps: [step('No file', undefined, [1, 1])] }, lookup, { seq: 1 }).problems, ['Step 1 has no "file".']);
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
			title: 'Review of the new limit',
			currentStep: 1,
			progress: '2 of 3 steps reviewed: 1 question',
			steps: [
				{ step: 1, title: 'Check the new limit', file: 'battery.cpp', lines: [69, 71], status: 'ok' },
				{ step: 2, title: 'Follow the result to process()', file: 'battery.cpp', lines: [101, 111], status: 'question', hasNote: true },
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
});
