import * as assert from 'assert';
import { addDetail, resolveDetail } from '../../lenses/blocks';
import { anchorDetail, findCode, parseMarkdown, textBetween } from '../../side/details';
import type { SideModelDetail } from '../../side/protocol';

// A function with an expression on one line and an expression on two lines. Lines from 1, UTF-16 columns from 0
const SRC = [
	'int scale(int a, int b) {',
	'  int c = a + b * 2;',
	'  return c *',
	'         factor(a);',
	'}',
];
const textOf = (src: string[]) => (line: number) => src[line - 1];

suite('Details of a model', () => {
	test('The search finds code on a line, over two lines, and with a different layout', () => {
		const t = textOf(SRC);
		assert.deepStrictEqual(findCode(t, 'a + b * 2', { line: 2, col: 0 }, [1, 5]), { line: 2, col: 10, endLine: 2, endCol: 19 });
		// more places: the place nearest to the line and the column
		assert.strictEqual(findCode(t, 'a', { line: 4, col: 0 }, [1, 5])?.line, 4);
		// two lines, with different white space
		assert.deepStrictEqual(findCode(t, 'c * factor(a)', { line: 3, col: 0 }, [1, 5]), { line: 3, col: 9, endLine: 4, endCol: 18 });
		assert.strictEqual(findCode(t, 'nothing', { line: 2, col: 0 }, [1, 5]), undefined);
		assert.strictEqual(textBetween(t, { line: 3, col: 9, endLine: 4, endCol: 18 }), 'c *\n         factor(a)');
	});

	test('A detail finds its code again after an edit in its line', () => {
		const d: SideModelDetail = { id: 'd1', line: 2, col: 10, endLine: 2, endCol: 19, code: 'a + b * 2', title: 'T', text: 'x' };
		assert.deepStrictEqual(anchorDetail(d, textOf(SRC)), { line: 2, col: 10, endLine: 2, endCol: 19 });
		const edited = [SRC[0], '  int sum = a + b * 2;', ...SRC.slice(2)];
		assert.deepStrictEqual(anchorDetail(d, textOf(edited)), { line: 2, col: 12, endLine: 2, endCol: 21 });
		assert.strictEqual(anchorDetail(d, textOf(SRC.map((l) => l.replace('b * 2', 'b')))), undefined);
	});

	test('The code of a detail: the expression on the line, the line, or the selection of the user', () => {
		const t = textOf(SRC);
		const one = resolveDetail({ line: 2, expression: 'a + b * 2', text: ' For a = 1 and b = 2: 5. ' }, t, SRC.length);
		assert.deepStrictEqual(one.detail, { line: 2, col: 10, endLine: 2, endCol: 19, code: 'a + b * 2', title: 'a + b * 2', text: 'For a = 1 and b = 2: 5.' });
		// the model gave a line before the code
		assert.strictEqual(resolveDetail({ line: 3, expression: 'factor(a)', text: 'x' }, t, SRC.length).detail?.line, 4);
		// no expression: the line with no white space at its ends
		assert.strictEqual(resolveDetail({ line: 3, title: 'Return', text: 'x' }, t, SRC.length).detail?.code, 'return c *');
		// no line: the selection of the user
		const selection = { line: 3, col: 9, endLine: 4, endCol: 18 };
		assert.strictEqual(resolveDetail({ text: 'x' }, t, SRC.length, selection).detail?.code, 'c *\n         factor(a)');
		assert.match(resolveDetail({ text: 'x' }, t, SRC.length).problem!, /The user selected no code/);
		assert.match(resolveDetail({ line: 2, expression: 'x * y', text: 'x' }, t, SRC.length).problem!, /Line 2 has no "x \* y": int c = a \+ b \* 2;/);
		assert.match(resolveDetail({ line: 9, text: 'x' }, t, SRC.length).problem!, /"line" must be a line of the file \(1-5\)/);
		assert.match(resolveDetail({ line: 2, text: ' ' }, t, SRC.length).problem!, /"text" must be a text/);
	});

	test('A detail on the same code replaces the old detail, and a new detail gets the next id', () => {
		const one = addDetail([], { line: 2, col: 10, endLine: 2, endCol: 19, code: 'a + b * 2', title: 'A', text: 'a' });
		assert.strictEqual(one.id, 'd1');
		const two = addDetail(one.details, { line: 1, col: 4, endLine: 1, endCol: 9, code: 'scale', title: 'B', text: 'b' });
		assert.strictEqual(two.id, 'd2');
		// in the sequence of the code
		assert.deepStrictEqual(two.details.map((d) => d.id), ['d2', 'd1']);
		const again = addDetail(two.details, { line: 2, col: 10, endLine: 2, endCol: 19, code: 'a + b * 2', title: 'A2', text: 'new' });
		assert.strictEqual(again.id, 'd1');
		assert.deepStrictEqual(again.details.map((d) => `${d.id} ${d.title}`), ['d2 B', 'd1 A2']);
	});

	test('The text of a detail has a small part of Markdown, and no HTML', () => {
		const blocks = parseMarkdown([
			'## Examples',
			'For **a = 1** and *b = 2*, the result is `5`.',
			'',
			'- a = 0: `4`',
			'- a = -2:',
			'  the result is `0`',
			'1. first',
			'2. second',
			'```cpp',
			'int x = scale(1, 2); // 5',
			'```',
			'<b>no html</b> and snake_case_names stay',
		].join('\n'));
		assert.deepStrictEqual(blocks.map((b) => b.kind), ['heading', 'paragraph', 'list', 'list', 'code', 'paragraph']);
		assert.deepStrictEqual(blocks[1], {
			kind: 'paragraph', parts: [
				{ kind: 'text', text: 'For ' }, { kind: 'bold', text: 'a = 1' }, { kind: 'text', text: ' and ' }, { kind: 'italic', text: 'b = 2' },
				{ kind: 'text', text: ', the result is ' }, { kind: 'code', text: '5' }, { kind: 'text', text: '.' },
			],
		});
		const bullets = blocks[2] as { isOrdered: boolean; items: { text: string }[][] };
		assert.strictEqual(bullets.isOrdered, false);
		// an indented line continues its item
		assert.deepStrictEqual(bullets.items[1].map((p) => p.text), ['a = -2: the result is ', '0']);
		assert.strictEqual((blocks[3] as { isOrdered: boolean }).isOrdered, true);
		assert.deepStrictEqual(blocks[4], { kind: 'code', text: 'int x = scale(1, 2); // 5' });
		assert.deepStrictEqual(blocks[5], { kind: 'paragraph', parts: [{ kind: 'text', text: '<b>no html</b> and snake_case_names stay' }] });
	});
});
