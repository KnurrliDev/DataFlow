import * as assert from 'assert';
import type { FlowModel, LogicModel } from '../../engine/client';
import { buildFlowView } from '../../lenses/flow';
import { buildLogicView, logicWarnings } from '../../lenses/logic';
import { buildControls, Choices, dominators, evaluatePath, pathChoices, pathSteps, whyLine } from '../../logic/paths';
import { buildSideFlow } from '../../side/flowLayer';
import { buildSideLogic } from '../../side/logicLayer';
import { activeGuide, GuideText, indentGuides, indentOf } from '../../side/guides';
import {
	BRACKET_STYLE, LEXICAL_KEYS, semanticStyleIndex, SEMANTIC_TYPES, shiftSpans, styleKeyOf, toRows, UNEXPECTED_BRACKET_STYLE, utf16Offsets,
} from '../../side/model';
import { editorLineHeight, fontFeatureSettings, ScrollGuard } from '../../side/sync';
import {
	customSections, customTextMateRules, parseJsonc, parsePlist, resolveStyles, scopeMatcher, semanticRulesOf, semanticScore, textMateRulesOf,
} from '../../side/themeRules';
import { StateStore } from '../../state/store';

// The legend of the engine. engine/README.md describes the kinds and the modifiers.
const legend = {
	kinds: ['comment', 'string', 'number', 'operator', 'punctuation', 'preprocessor', 'keyword', 'keyword.control', 'keyword.type',
		'keyword.modifier', 'keyword.constant', 'keyword.this', 'namespace', 'class', 'enum', 'enumMember', 'type', 'typeParameter',
		'function', 'method', 'parameter', 'variable', 'property', 'macro', 'label', 'bracket'],
	modifiers: ['declaration', 'readonly', 'static', 'defaultLibrary'],
};
const kind = (name: string) => legend.kinds.indexOf(name);
const lexical = (key: string) => LEXICAL_KEYS.indexOf(key as never);
const semantic = (type: string, bits = 0) => semanticStyleIndex(SEMANTIC_TYPES.indexOf(type as never), bits);

suite('Side view: rows', () => {
	test('The spans get the UTF-16 columns of the UTF-8 columns of the engine', () => {
		// ä has 2 bytes. The engine counts the bytes from 1.
		const text = 'auto ä = name;';
		const [row] = toRows(legend, [{ line: 3, text, tokens: [1, 4, kind('keyword.type'), 0, 9, 1, kind('operator'), 0, 11, 4, kind('variable'), 2] }]);
		assert.strictEqual(row.line, 3);
		assert.deepStrictEqual(row.spans, [0, 4, lexical('keyword.type'), 7, 8, lexical('operator'), 9, 13, semantic('variable', 2)]);
		assert.strictEqual(text.slice(9, 13), 'name');
		assert.strictEqual(utf16Offsets('abc'), undefined);
		assert.deepStrictEqual([...utf16Offsets('a😀b')!], [0, 1, 1, 1, 1, 3, 4]);
	});

	test('A keyword gets its group of the grammar, and a bracket gets its level', () => {
		const text = 'new (class) ]';
		const [row] = toRows(legend, [{
			line: 1, text,
			tokens: [1, 3, kind('keyword'), 0, 5, 1, kind('bracket'), 0, 6, 5, kind('keyword'), 0, 11, 1, kind('bracket'), 0, 13, 1, kind('bracket'), -1],
		}]);
		assert.deepStrictEqual(row.spans, [
			0, 3, lexical('keyword.new'), 4, 5, BRACKET_STYLE, 5, 10, lexical('keyword.storage'), 10, 11, BRACKET_STYLE, 12, 13, UNEXPECTED_BRACKET_STYLE,
		]);
	});

	test('An edit of a row moves the spans after it, grows the span around it, and removes a span that it cuts', () => {
		// int count = 10; as int 0-3, count 4-9, 10 13-15
		const spans = [0, 3, 1, 4, 9, 2, 13, 15, 3];
		// a character in count: count grows, and 10 moves
		assert.deepStrictEqual(shiftSpans(spans, 6, 6, 1), [0, 3, 1, 4, 10, 2, 14, 16, 3]);
		// a character at the end of count stays out of its span. The span after the edit moves
		assert.deepStrictEqual(shiftSpans(spans, 9, 9, 2), [0, 3, 1, 4, 9, 2, 15, 17, 3]);
		// the deletion of '= 1' cuts the span of 10, and the span of count stays
		assert.deepStrictEqual(shiftSpans(spans, 10, 14, 0), [0, 3, 1, 4, 9, 2]);
		// a replacement of the full name keeps its style
		assert.deepStrictEqual(shiftSpans(spans, 4, 9, 3), [0, 3, 1, 4, 7, 2, 11, 13, 3]);
	});

	test('Each style index has a style key', () => {
		assert.deepStrictEqual(styleKeyOf(lexical('comment')), { lexical: 'comment' });
		assert.deepStrictEqual(styleKeyOf(semantic('function', 0b1001)), { type: 'function', modifiers: ['declaration', 'defaultLibrary'] });
	});
});

suite('Side view: theme colors', () => {
	test('The theme parser accepts comments and a comma after the last item', () => {
		const json = parseJsonc('{ "$schema": "vscode://schemas/color-theme", // a comment\n "a": [1, 2, ], /* b */ "c": "x//y" }');
		assert.deepStrictEqual(json, { $schema: 'vscode://schemas/color-theme', a: [1, 2], c: 'x//y' });
	});

	test('A theme of TextMate is a property list, and its settings are the rules of the colors', () => {
		const tmTheme = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0">',
			'<dict>',
			'  <key>name</key><string>Old &amp; Dark</string>',
			'  <!-- the colors of the editor, then the rules -->',
			'  <key>settings</key>',
			'  <array>',
			'    <dict><key>settings</key><dict><key>foreground</key><string>#F8F8F2</string></dict></dict>',
			'    <dict>',
			'      <key>scope</key><string>comment, punctuation.definition.comment</string>',
			'      <key>settings</key><dict><key>foreground</key><string>#75715E</string><key>fontStyle</key><string>italic</string></dict>',
			'    </dict>',
			'    <dict><key>scope</key><string>keyword.control</string><key>settings</key><dict><key>foreground</key><string>#F92672</string></dict></dict>',
			'  </array>',
			'  <key>semanticClass</key><string>theme.dark.old</string>',
			'  <key>uuid</key><string>D8D5E82E</string>',
			'  <key>isDefault</key><true/>',
			'  <key>version</key><integer>2</integer>',
			'</dict>',
			'</plist>',
		].join('\n');
		const plist = parsePlist(tmTheme) as Record<string, unknown>;
		assert.deepStrictEqual([plist.name, plist.isDefault, plist.version], ['Old & Dark', true, 2]);
		const rules = textMateRulesOf(plist);
		assert.strictEqual(rules.length, 3);
		const styles = resolveStyles({ tokenColors: rules, semanticRules: [], semanticHighlighting: false });
		assert.deepStrictEqual(styles[lexical('comment')], { color: '#75715E', bold: false, italic: true, underline: false, strikethrough: false });
		assert.strictEqual(styles[lexical('keyword.control')].color, '#F92672');
		assert.throws(() => parsePlist('{ "a": 1 }'), /property list/);
	});

	test('A scope selector agrees with a deeper and longer scope, and not with an exclusion', () => {
		const path = ['source.cpp', 'meta.function-call.cpp', 'entity.name.function.call.cpp'];
		assert.ok(scopeMatcher('entity.name.function')(path) > scopeMatcher('entity.name')(path));
		assert.ok(scopeMatcher('meta.function-call')(path) < scopeMatcher('entity.name')(path));
		assert.ok(scopeMatcher('source.cpp entity.name.function')(path) >= 0);
		assert.strictEqual(scopeMatcher('entity.name.functions')(path), -1);
		assert.strictEqual(scopeMatcher('keyword - keyword.operator')(['source.cpp', 'keyword.operator.cpp']), -1);
		assert.ok(scopeMatcher('keyword - keyword.operator')(['source.cpp', 'keyword.control.cpp']) >= 0);
		assert.ok(scopeMatcher('string, entity.name')(path) >= 0);
	});

	test('A semantic selector needs the type and all its modifiers', () => {
		assert.strictEqual(semanticScore('variable.readonly', 'variable', ['readonly', 'declaration'], 'cpp'), 200);
		assert.strictEqual(semanticScore('*.declaration', 'function', ['declaration'], 'cpp'), 100);
		assert.strictEqual(semanticScore('variable.readonly', 'variable', [], 'cpp'), -1);
		assert.strictEqual(semanticScore('variable:c', 'variable', [], 'cpp'), -1);
		assert.strictEqual(semanticScore('variable:cpp', 'variable', [], 'cpp'), 110);
	});

	test('The styles come from the semantic rules, the defaults of VS Code and the grammar scopes', () => {
		const tokenColors = [
			{ scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } },
			{ scope: ['keyword.control'], settings: { foreground: '#C586C0' } },
			{ scope: 'storage.type', settings: { foreground: '#569CD6' } },
			{ scope: 'entity.name.function', settings: { foreground: '#DCDCAA' } },
			{ scope: 'variable', settings: { foreground: '#9CDCFE' } },
			{ scope: 'variable.other.constant', settings: { foreground: '#4FC1FF' } },
		];
		const semanticRules = semanticRulesOf({ 'function.declaration': { bold: true }, 'parameter': '#FF0000' });
		const styles = resolveStyles({ tokenColors, semanticRules, semanticHighlighting: true });
		assert.deepStrictEqual(styles[lexical('comment')], { color: '#6A9955', bold: false, italic: true, underline: false, strikethrough: false });
		assert.strictEqual(styles[lexical('keyword.control')].color, '#C586C0');
		assert.strictEqual(styles[lexical('keyword.type')].color, '#569CD6');
		assert.strictEqual(styles[semantic('function')].color, '#DCDCAA');
		assert.deepStrictEqual(styles[semantic('function', 0b0001)], { color: '#DCDCAA', bold: true });
		assert.strictEqual(styles[semantic('variable')].color, '#9CDCFE');
		assert.strictEqual(styles[semantic('variable', 0b0010)].color, '#4FC1FF');
		assert.strictEqual(styles[semantic('parameter')].color, '#FF0000');

		// without semantic highlighting, a variable has no scope in the grammar
		const grammar = resolveStyles({ tokenColors, semanticRules, semanticHighlighting: false });
		assert.strictEqual(grammar[semantic('variable', 0b0010)].color, undefined);
		assert.strictEqual(grammar[semantic('function')].color, '#DCDCAA');
	});

	test('The user settings have a general section and sections for themes', () => {
		const setting = { comments: '#111111', '[Dark+]': { textMateRules: [{ scope: 'string', settings: { foreground: '#222222' } }] }, '[*Light*]': { numbers: '#333333' } };
		const sections = customSections(setting, ['Dark+', 'Dark+']);
		assert.strictEqual(sections.length, 2);
		const rules = sections.flatMap(customTextMateRules);
		assert.deepStrictEqual(rules.map((r) => r.settings?.foreground), ['#111111', '#222222']);
		assert.strictEqual(customSections(setting, ['Light Modern']).flatMap(customTextMateRules).length, 2);
	});
});

suite('Side view: scroll sync and editor settings', () => {
	test('The guide ignores the scroll events of a view for a short time after the sync moved it', () => {
		const guard = new ScrollGuard(150);
		assert.strictEqual(guard.isEcho(1000), false);
		guard.moved(1000);
		assert.strictEqual(guard.isEcho(1100), true);
		assert.strictEqual(guard.isEcho(1150), false);
	});

	test('The line height and the ligatures agree with the text editor', () => {
		assert.strictEqual(editorLineHeight(14, 0, false), 19);
		assert.strictEqual(editorLineHeight(12, 0, true), 18);
		assert.strictEqual(editorLineHeight(14, 1.5, false), 21);
		assert.strictEqual(editorLineHeight(14, 22, false), 22);
		assert.strictEqual(fontFeatureSettings(false), '"liga" off, "calt" off');
		assert.strictEqual(fontFeatureSettings(true), '"liga" on, "calt" on');
		assert.strictEqual(fontFeatureSettings("'ss01'"), "'ss01'");
	});
});

suite('Side view: Flow Lens', () => {
	// The engine counts lines from 1 and columns in UTF-8 bytes from 1. The side view counts lines from 1.
	const fn = { name: 'f', qualifiedName: 'ns::f', kind: 'function' as const, range: { begin: { line: 1, col: 1 }, end: { line: 7, col: 2 } } };
	const sideFlow = (model: FlowModel, lines: string[]) => {
		const view = buildFlowView(model, 0, (line) => lines[line]);
		const variables = model.variables.map((v) => ({ name: v.name, type: v.type, declLine: model.refs[v.declRef].line - 1 }));
		return buildSideFlow({ file: 'a.cpp', fn, view, variables, pulse: 3, isSelected: true }, 3);
	};

	test('Each reference knows the definitions that get to it, and the finding goes to the last rail segment', () => {
		const lines = ['auto best = find();', 'if (best) {', '  use(best->id);', '}', 'log(best->id);'];
		const flow = sideFlow({
			function: fn,
			variables: [{ name: 'best', type: 'std::optional<Item>', storage: 'local', declRef: 0 }],
			refs: [
				{ var: 0, role: 'def', line: 1, col: 6, len: 4 },
				{ var: 0, role: 'check', line: 2, col: 5, len: 4 },
				{ var: 0, role: 'read', line: 3, col: 7, len: 4 },
				{ var: 0, role: 'read', line: 5, col: 5, len: 4, finding: 'unchecked optional access' },
			],
			edges: [[0, 1], [0, 2], [0, 3]],
		}, lines);
		assert.deepStrictEqual(flow.marks.map((m) => [m.line, m.role, m.from, m.to]), [
			[1, 'def', [], [1, 2, 3]], [2, 'check', [0], []], [3, 'read', [0], []], [5, 'read', [0], []],
		]);
		assert.deepStrictEqual([flow.marks[3].start, flow.marks[3].end, flow.marks[3].finding], [4, 8, 'optional not checked here']);
		assert.deepStrictEqual(flow.findings, [{ line: 5, text: 'optional not checked here' }]);
		assert.deepStrictEqual(flow.lanes.map((l) => [l.slot, l.from, l.to]), [[0, 1, 5]]);
		assert.deepStrictEqual(flow.lanes[0].segments.at(-1), { from: 3, to: 5, isProblem: true });
		assert.deepStrictEqual([flow.slots, flow.declLine, flow.pulse, flow.isSelected, flow.variables[0].isCurrent], [1, 1, 3, true, true]);
	});

	test('Rails that share a line get different columns. A rail after them uses a free column again', () => {
		const lines = ['int x = 1;', 'x = 2;', 'use(x);', 'use(x);', '', 'x = 3;', 'use(x);'];
		const flow = sideFlow({
			function: fn,
			variables: [{ name: 'x', type: 'int', storage: 'local', declRef: 0 }],
			refs: [
				{ var: 0, role: 'def', line: 1, col: 5, len: 1 },
				{ var: 0, role: 'write', line: 2, col: 1, len: 1 },
				{ var: 0, role: 'read', line: 3, col: 5, len: 1 },
				{ var: 0, role: 'read', line: 4, col: 5, len: 1 },
				{ var: 0, role: 'write', line: 6, col: 1, len: 1 },
				{ var: 0, role: 'read', line: 7, col: 5, len: 1 },
			],
			edges: [[0, 2], [1, 3], [4, 5]],
		}, lines);
		assert.deepStrictEqual(flow.lanes.map((l) => [l.from, l.to, l.slot]), [[1, 3, 0], [2, 4, 1], [6, 7, 0]]);
		assert.strictEqual(flow.slots, 2);
	});
});

suite('Side view: Logic Map', () => {
	// A small CFG for this function. Block ids are in the comments. The engine counts lines from 1 and columns in UTF-8
	// bytes from 1.
	const lines = ['void f(int s) {', '  int *p = get();', '  if (s == 1) {', '    ev("one");', '  } else {', '    ev("two");', '  }', '  use(*p);', '}'];
	const fn = { name: 'f', qualifiedName: 'ns::f', kind: 'function' as const, range: { begin: { line: 1, col: 1 }, end: { line: 9, col: 1 } } };
	const model: LogicModel = {
		function: fn,
		entry: 1,
		exit: 0,
		blocks: [
			{ succs: [], lines: [] }, { succs: [2], lines: [] }, { succs: [3, 4], lines: [[2, 3]] }, // 0 is the exit, 1 is the entry
			{ succs: [5], lines: [[4, 4]] }, { succs: [5], lines: [[6, 6]] }, { succs: [0], lines: [[8, 8]] },
		],
		decisions: [{
			kind: 'if', block: 2, condBlocks: [], text: 's == 1', line: 3, col: 7, parent: -1,
			branches: [{ label: 'yes', succ: 0, first: 3, last: 5 }, { label: 'no', succ: 1, first: 5, last: 7 }],
		}],
		chains: [],
		events: [
			{ block: 3, line: 4, col: 5, len: 9, function: 'ev', label: 'one' },
			{ block: 4, line: 6, col: 5, len: 9, function: 'ev', label: 'two' },
		],
		nullable: [{ var: 'p', source: 'get', at: { block: 2, line: 2, col: 8, len: 1 }, derefs: [{ block: 5, line: 8, col: 7, len: 2 }], checks: [] }],
	};

	const layerOf = (chosen: Choices) => {
		const controls = buildControls(model);
		const choices = pathChoices(model, controls, chosen);
		const path = evaluatePath(model, controls, choices);
		const view = buildLogicView(model, path, (line) => lines[line]);
		const why = { line: 4, items: whyLine(model, controls, dominators(model), 4)!.map((w) => ({ key: w.key, text: w.text, option: w.option })) };
		return buildSideLogic({
			file: 'a.cpp', fn, view, steps: pathSteps(model, controls, choices, path), chosen: Object.keys(chosen), hasCfg: true,
			warnings: logicWarnings(model, path), why,
		});
	};

	test('The layer has the lines from 1, the steps of the path, and the marks of the path', () => {
		const logic = layerOf({ 'if:s == 1#0': 'yes' });
		assert.deepStrictEqual([logic.fn, logic.first, logic.last, logic.hasChoices, logic.hasCfg], ['ns::f', 1, 9, true, true]);
		assert.deepStrictEqual(logic.steps.map((s) => [s.kind, s.line, s.value ?? s.text, s.isSet]), [
			['decision', 3, 'yes', true], ['event', 4, 'one', undefined], ['warning', 8, 'p can be null', undefined], ['end', 9, '', undefined],
		]);
		assert.deepStrictEqual(logic.steps[0].options, ['yes', 'no']);
		assert.deepStrictEqual(logic.dead, [5, 6, 7]);
		assert.deepStrictEqual(logic.events, [{ line: 4, start: 4, end: 13, label: 'one' }]);
		assert.deepStrictEqual(logic.problems, [{ line: 8, start: 6, end: 8 }]);
		assert.deepStrictEqual(logic.hints, [{ line: 8, text: 'p can be null here (get, line 2)' }]);
		assert.deepStrictEqual(logic.warnings.map((w) => [w.line, w.short]), [[8, 'p can be null']]);
		assert.deepStrictEqual(logic.why, { line: 4, items: [{ key: 'if:s == 1#0', text: 's == 1', option: 'yes' }] });
	});

	test('With no choice of the user, each decision has the default option and the path is one path', () => {
		// the two branches have one line each, so the first option is the default
		const logic = layerOf({});
		assert.deepStrictEqual([logic.hasChoices, logic.steps[0].value, logic.steps[0].isSet], [false, 'yes', false]);
		assert.deepStrictEqual(logic.dead, [5, 6, 7]);
	});
});

suite('Side view: indent guides', () => {
	// a function with an empty line in its body, and an empty line between two functions
	const lines = ['void f() {', '  int a;', '', '  if (a) {', '    a++;', '  }', '}', '', 'void g() {', '  int b;', '}'];
	const text: GuideText = { lineCount: lines.length, tabSize: 4, indentSize: 2, text: (line) => lines[line - 1] };

	test('A line gets one guide for each level of indent. An empty line gets the guides of its block', () => {
		assert.strictEqual(indentOf('\t  x', 4), 6);
		assert.strictEqual(indentOf('   ', 4), -1);
		assert.deepStrictEqual(indentGuides(text, 1, 11), [0, 1, 1, 1, 2, 1, 0, 0, 0, 1, 0]);
	});

	test('The active guide is the guide of the block of the cursor', () => {
		assert.deepStrictEqual(activeGuide(text, 5, 1, 11), { first: 5, last: 5, level: 2 });
		assert.deepStrictEqual(activeGuide(text, 2, 1, 11), { first: 2, last: 6, level: 1 });
		// on the first line of a block, the block inside is active
		assert.deepStrictEqual(activeGuide(text, 4, 1, 11), { first: 5, last: 5, level: 2 });
		assert.deepStrictEqual(activeGuide(text, 8, 1, 11), { first: 8, last: 8, level: 0 });
	});
});

suite('Side view: lenses', () => {
	test('All lenses but Change Ripple and Heat are on by default, and the lens that turns on last is the last lens', () => {
		const store = new StateStore();
		// Change Ripple and Heat run git and more requests, so they start only on demand
		assert.deepStrictEqual(store.state.lenses, { flow: true, logic: true, cost: true, review: false, includes: true, calls: true, threads: true, heat: false });
		assert.strictEqual(store.state.lastLens, undefined);
		store.toggleLens('review');
		assert.strictEqual(store.state.lastLens, 'review');
		// a lens that turns off does not change the last lens
		store.toggleLens('logic');
		assert.deepStrictEqual([store.state.lenses.logic, store.state.lastLens], [false, 'review']);
		store.toggleLens('logic');
		assert.deepStrictEqual([store.state.lenses.logic, store.state.lastLens], [true, 'logic']);
		store.dispose();
	});
});
