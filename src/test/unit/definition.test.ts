import * as assert from 'assert';
import { DefinitionPlace, otherPlaces, PlaceHistory } from '../../side/definition';

// Go to definition in the side view: the definitions that are not the place of the click, and Back and Forward

suite('Go to definition in the side view', () => {
	const place = (key: string, line: number, col: number, len = 6): DefinitionPlace => ({ file: key, key, line, col, endLine: line, endCol: col + len });

	test('The definition at the place of the click and duplicates do not count', () => {
		const own = place('a.cpp', 10, 7);
		const other = place('b.hpp', 3, 2);
		// a click in the name of the definition itself, also at its end
		assert.deepStrictEqual(otherPlaces([own, other], { key: 'a.cpp', line: 10, col: 9 }), [other]);
		assert.deepStrictEqual(otherPlaces([own], { key: 'a.cpp', line: 10, col: 13 }), []);
		// a click in a different name of the same line, or in a different file
		assert.deepStrictEqual(otherPlaces([own], { key: 'a.cpp', line: 10, col: 20 }), [own]);
		assert.deepStrictEqual(otherPlaces([own], { key: 'c.cpp', line: 10, col: 9 }), [own]);
		// two providers give the same place
		assert.deepStrictEqual(otherPlaces([other, { ...other }], { key: 'a.cpp', line: 1, col: 0 }), [other]);
	});

	test('Back and Forward go through the places that the jumps left', () => {
		const history = new PlaceHistory(3);
		const a = { file: 'a.cpp', line: 1, col: 0 };
		const b = { file: 'b.hpp', line: 5, col: 2 };
		const c = { file: 'c.hpp', line: 9, col: 4 };
		assert.strictEqual(history.goBack(a), undefined);
		// a jump from a to b, then from b to c
		history.push(a);
		history.push(b);
		assert.deepStrictEqual(history.goBack(c), b);
		assert.deepStrictEqual(history.goBack(b), a);
		assert.strictEqual(history.canGoBack, false);
		assert.deepStrictEqual(history.goForward(a), b);
		assert.deepStrictEqual(history.goForward(b), c);
		assert.strictEqual(history.canGoForward, false);
		// a new jump removes the places of Forward
		assert.deepStrictEqual(history.goBack(c), b);
		history.push(b);
		assert.strictEqual(history.canGoForward, false);
		// the same place twice is one place, and the history keeps the last places only
		history.push(b);
		history.push(c);
		history.push(a);
		history.push(c);
		const back: unknown[] = [];
		for (let to = history.goBack(b); to; to = history.goBack(b)) {
			back.push(to);
		}
		assert.deepStrictEqual(back, [c, a, c]);
	});
});
