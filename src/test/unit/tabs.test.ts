import * as assert from 'assert';
import { MAX_TAB_ROWS, resolveTabContent, resolveTabOptions } from '../../api/tabs';

// The tab of an extension in the details column: the checks of its id, its title and its content

const resolveFile = (file: string) => (file.startsWith('/') ? file : `/repo/${file}`);

suite('Tabs of extensions', () => {
	test('The options need an id of letters, digits, - and _, and a title. A long title gets cut', () => {
		assert.deepStrictEqual(resolveTabOptions({ id: 'review-plan_2', title: ' Plan ' }), { id: 'review-plan_2', title: 'Plan' });
		assert.strictEqual(resolveTabOptions({ id: 'a', title: 'x'.repeat(50) }).title.length, 30);
		assert.throws(() => resolveTabOptions(undefined), /Give the options of the tab: \{ id, title \}\./);
		assert.throws(() => resolveTabOptions({ id: 'a b', title: 'Plan' }), /"id" of the tab must have 1 to 64 letters, digits, - or _\./);
		assert.throws(() => resolveTabOptions({ id: 'plan', title: ' ' }), /Give the "title" of the tab\./);
	});

	test('The content has sections with rows. A row has a text, and optionally an id, a detail, a badge, a place and buttons', () => {
		const sections = resolveTabContent({
			sections: [
				{
					title: 'Steps', rows: [
						{ id: 'r1', text: 'Add the limit', detail: 'Use **max_rate**.', badge: ' risk 3 ', place: { file: 'src/rate.cpp', line: 12 }, actions: [{ id: 'run', title: 'Run' }] },
						{ text: 'Check the tests', detail: ' ', place: { file: '/other/test.cpp', line: 1 } },
					],
				},
				{ title: 'Empty', rows: [] },
			],
		}, resolveFile);
		assert.deepStrictEqual(sections, [
			{
				title: 'Steps', rows: [
					{ id: 'r1', text: 'Add the limit', detail: 'Use **max_rate**.', badge: 'risk 3', place: { file: '/repo/src/rate.cpp', line: 12 }, actions: [{ id: 'run', title: 'Run' }] },
					{ text: 'Check the tests', place: { file: '/other/test.cpp', line: 1 } },
				],
			},
			{ title: 'Empty', rows: [] },
		]);
		// a long text gets cut
		const long = resolveTabContent({ sections: [{ title: 'A', rows: [{ text: 'x'.repeat(300), badge: 'y'.repeat(40) }] }] }, resolveFile);
		assert.deepStrictEqual([long[0].rows[0].text.length, long[0].rows[0].badge?.length], [200, 20]);
	});

	test('A wrong content throws one error with all problems, and too many rows throw an error', () => {
		assert.throws(() => resolveTabContent({ rows: [] }, resolveFile), /must be an object with "sections"/);
		assert.throws(() => resolveTabContent({ sections: [{ title: 'A', rows: Array.from({ length: MAX_TAB_ROWS + 1 }, () => ({ text: 'x' })) }] }, resolveFile),
			/A tab has a maximum of 200 rows\. The content has 201 rows\./);
		assert.throws(() => resolveTabContent({
			sections: [
				{ title: 'A', rows: [{ text: '' }, { id: 'r1', text: 'b' }, { id: 'r1', text: 'c' }, { text: 'd', actions: [{ id: 'x', title: 'X' }] }] },
				{ title: 'B', rows: [{ text: 'e', place: { file: 'a.cpp', line: 0 } }, { text: 'f', detail: 3 }] },
				{ rows: [] },
			],
		}, resolveFile), (err: Error) => {
			assert.strictEqual(err.message, [
				'Section 1, row 1: a row must have "text".',
				'Section 1, row 3: the id r1 is on a different row of the tab.',
				'Section 1, row 4: a row with "actions" needs an "id".',
				'Section 2, row 1: "place" must have "file" and "line", a line from 1.',
				'Section 2, row 2: "detail" must be a text.',
				'Section 3: a section must have "title" and "rows".',
			].join(' '));
			return true;
		});
	});
});
