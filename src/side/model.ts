import type { TokenLegend, TokenLine } from '../engine/client';
import type { SideRow } from './protocol';

// The style keys of the side view. Each token span gets the index of a style key, and side/theme.ts finds the style
// of each key in the color theme. The keys of the names are semantic token types of VS Code with their modifiers.
// The other keys are the lexical kinds of the engine, and three groups of keywords that the C++ grammar of VS Code
// scopes differently. An attribute is a name in [[...]], and a pragma is a word after #pragma.
export const LEXICAL_KEYS = [
	'comment', 'string', 'number', 'operator', 'punctuation', 'preprocessor', 'keyword', 'keyword.control',
	'keyword.type', 'keyword.modifier', 'keyword.constant', 'keyword.this', 'keyword.storage', 'keyword.new',
	'keyword.operator', 'attribute', 'pragma',
] as const;
export type LexicalKey = (typeof LEXICAL_KEYS)[number];

export const SEMANTIC_TYPES = [
	'namespace', 'class', 'enum', 'enumMember', 'type', 'typeParameter', 'function', 'method', 'parameter', 'variable',
	'property', 'macro', 'label',
] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

// The modifiers that a style key can have. Bit i of a style key is the modifier i.
export const SEMANTIC_MODIFIERS = ['declaration', 'readonly', 'static', 'defaultLibrary'] as const;
export type SemanticModifier = (typeof SEMANTIC_MODIFIERS)[number];

export const STYLE_COUNT = LEXICAL_KEYS.length + (SEMANTIC_TYPES.length << SEMANTIC_MODIFIERS.length);

// The style indices of the brackets come after the style keys: one for each level of nesting, modulo BRACKET_LEVELS,
// and then one for a closing bracket that does not close the last open bracket. The webview finds their colors in the
// theme colors of VS Code, as the text editor does.
export const BRACKET_LEVELS = 60;
export const BRACKET_STYLE = STYLE_COUNT;
export const UNEXPECTED_BRACKET_STYLE = STYLE_COUNT + BRACKET_LEVELS;

export type StyleKey = { lexical: LexicalKey } | { type: SemanticType; modifiers: SemanticModifier[] };

// Keywords that the C++ grammar scopes as storage.type or as keyword.operator. The engine gives them the kind keyword.
const KEYWORD_GROUPS = new Map<string, LexicalKey>([
	...['class', 'struct', 'union', 'enum', 'namespace', 'template', 'typename', 'concept', 'decltype', 'public',
		'private', 'protected'].map((k): [string, LexicalKey] => [k, 'keyword.storage']),
	...['new', 'delete'].map((k): [string, LexicalKey] => [k, 'keyword.new']),
	...['sizeof', 'alignof', 'typeid', 'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast']
		.map((k): [string, LexicalKey] => [k, 'keyword.operator']),
]);

export function semanticStyleIndex(type: number, modifierBits: number): number {
	return LEXICAL_KEYS.length + (type << SEMANTIC_MODIFIERS.length) + modifierBits;
}

export function styleKeyOf(index: number): StyleKey {
	if (index < LEXICAL_KEYS.length) {
		return { lexical: LEXICAL_KEYS[index] };
	}
	const semantic = index - LEXICAL_KEYS.length;
	const bits = semantic & ((1 << SEMANTIC_MODIFIERS.length) - 1);
	return {
		type: SEMANTIC_TYPES[semantic >> SEMANTIC_MODIFIERS.length],
		modifiers: SEMANTIC_MODIFIERS.filter((_, bit) => bits & (1 << bit)),
	};
}

// The UTF-16 index of each UTF-8 byte offset of a line. Undefined for a line with only ASCII characters, because
// then the two offsets are the same.
export function utf16Offsets(text: string): Uint32Array | undefined {
	if (!/[^\x00-\x7f]/.test(text)) {
		return undefined;
	}
	const offsets: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i)!;
		const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		for (let b = 0; b < bytes; b++) {
			offsets.push(i);
		}
		if (code > 0xffff) {
			i++; // the second half of a surrogate pair
		}
	}
	offsets.push(text.length);
	return Uint32Array.from(offsets);
}

// Converts the token lines of the engine to rows of the side view. The legend gives the names of the kind numbers
// and of the modifier bits of the engine. For a bracket, the engine gives the level of nesting, not modifiers.
export function toRows(legend: TokenLegend, lines: TokenLine[]): SideRow[] {
	const kinds = legend.kinds.map((name) => ({
		type: SEMANTIC_TYPES.indexOf(name as SemanticType),
		lexical: LEXICAL_KEYS.indexOf(name as LexicalKey),
		isBracket: name === 'bracket',
	}));
	const bits = legend.modifiers.map((name) => {
		const bit = SEMANTIC_MODIFIERS.indexOf(name as SemanticModifier);
		return bit >= 0 ? 1 << bit : 0;
	});

	return lines.map((l) => {
		const offsets = utf16Offsets(l.text);
		const at = (byte: number) => (offsets ? offsets[Math.min(byte, offsets.length - 1)] : Math.min(byte, l.text.length));
		const spans: number[] = [];
		for (let i = 0; i + 3 < l.tokens.length; i += 4) {
			const kind = kinds[l.tokens[i + 2]];
			if (!kind) {
				continue;
			}
			const start = at(l.tokens[i] - 1);
			const end = at(l.tokens[i] - 1 + l.tokens[i + 1]);
			if (end <= start) {
				continue;
			}
			if (kind.isBracket) {
				const level = l.tokens[i + 3];
				spans.push(start, end, level < 0 ? UNEXPECTED_BRACKET_STYLE : BRACKET_STYLE + (level % BRACKET_LEVELS));
			} else if (kind.type >= 0) {
				let modifiers = 0;
				bits.forEach((bit, m) => {
					if (l.tokens[i + 3] & (1 << m)) {
						modifiers |= bit;
					}
				});
				spans.push(start, end, semanticStyleIndex(kind.type, modifiers));
			} else if (kind.lexical >= 0) {
				spans.push(start, end, lexicalIndex(LEXICAL_KEYS[kind.lexical], l.text.slice(start, end)));
			}
		}
		return { line: l.line, text: l.text, spans };
	});
}

// The spans of a row after an edit of its text: the characters a to b became n characters. A span before the edit
// stays, a span after the edit moves, a span around the edit grows or gets smaller, and a span that the edit cuts goes
export function shiftSpans(spans: readonly number[], a: number, b: number, n: number): number[] {
	const delta = n - (b - a);
	const out: number[] = [];
	for (let i = 0; i + 2 < spans.length; i += 3) {
		const start = spans[i];
		const end = spans[i + 1];
		if (end <= a) {
			out.push(start, end, spans[i + 2]);
		} else if (start >= b) {
			out.push(start + delta, end + delta, spans[i + 2]);
		} else if (start <= a && end >= b && end + delta > start) {
			out.push(start, end + delta, spans[i + 2]);
		}
	}
	return out;
}

// Rows with the text of the editor and no spans, until the tokens of the engine come
export function plainRows(lines: string[], first = 1): SideRow[] {
	return lines.map((text, i) => ({ line: first + i, text, spans: [] }));
}

function lexicalIndex(key: LexicalKey, text: string): number {
	return LEXICAL_KEYS.indexOf(key === 'keyword' ? KEYWORD_GROUPS.get(text) ?? key : key);
}

// The keywords of C++ in the groups of the engine. engine/include/dataflow/tokens.hpp has the same groups.
const KEYWORD_KINDS = new Map<string, LexicalKey>([
	...['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'try', 'catch',
		'throw', 'co_await', 'co_return', 'co_yield'].map((k): [string, LexicalKey] => [k, 'keyword.control']),
	...['void', 'bool', 'char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'short', 'int', 'long', 'float', 'double',
		'signed', 'unsigned', 'auto'].map((k): [string, LexicalKey] => [k, 'keyword.type']),
	...['const', 'constexpr', 'consteval', 'constinit', 'static', 'inline', 'virtual', 'explicit', 'extern', 'mutable',
		'volatile', 'friend', 'thread_local', 'register', 'noexcept'].map((k): [string, LexicalKey] => [k, 'keyword.modifier']),
	...['true', 'false', 'nullptr'].map((k): [string, LexicalKey] => [k, 'keyword.constant']),
	['this', 'keyword.this'],
	...['alignas', 'asm', 'class', 'concept', 'decltype', 'enum', 'namespace', 'operator', 'private', 'protected', 'public',
		'requires', 'static_assert', 'struct', 'template', 'typedef', 'typename', 'union', 'using', 'new', 'delete', 'sizeof',
		'alignof', 'typeid', 'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast'].map((k): [string, LexicalKey] => [k, 'keyword']),
]);

const LEX_STRING = /(?:u8|[uUL])?(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)/y;
const LEX_NUMBER = /(?:\d|\.\d)(?:[eEpP][+-]|[\w.'])*/y;
const LEX_WORD = /[A-Za-z_]\w*/y;
const LEX_PUNCTUATION = /::|->|[;,.()[\]{}]/y;
const LEX_OPERATOR = /[-+*/%=<>!&|^~?:]+/y;

// Token spans for a line with no tokens of the engine, for example a line of the base of a diff. The lexer finds
// comments, strings, numbers, keywords, operators and punctuation. A name gets its style from names, if names has the
// name. A bracket gets the style of punctuation, because the lexer does not know the level of the bracket.
export function lexSpans(text: string, names?: ReadonlyMap<string, number>): number[] {
	const spans: number[] = [];
	const add = (start: number, end: number, key: LexicalKey) => spans.push(start, end, lexicalIndex(key, text.slice(start, end)));
	let i = 0;
	const directive = /^\s*#\s*(\w*)/.exec(text);
	if (directive) {
		add(text.indexOf('#'), directive[0].length, 'preprocessor');
		i = directive[0].length;
	}
	// all words after #pragma are one kind, as in the grammar of VS Code
	const isPragma = directive?.[1] === 'pragma';
	const match = (re: RegExp): number => {
		re.lastIndex = i;
		return re.exec(text)?.[0].length ?? 0;
	};
	while (i < text.length) {
		let n = 0;
		if (text[i] === ' ' || text[i] === '\t') {
			n = 1;
		} else if (text.startsWith('//', i)) {
			add(i, text.length, 'comment');
			break;
		} else if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i + 2);
			n = (end < 0 ? text.length : end + 2) - i;
			add(i, i + n, 'comment');
		} else if ((n = match(LEX_STRING))) {
			add(i, i + n, 'string');
		} else if ((n = match(LEX_NUMBER))) {
			add(i, i + n, 'number');
		} else if ((n = match(LEX_WORD))) {
			const word = text.slice(i, i + n);
			const keyword = KEYWORD_KINDS.get(word);
			const style = names?.get(word);
			if (isPragma) {
				add(i, i + n, 'pragma');
			} else if (keyword) {
				add(i, i + n, keyword);
			} else if (style !== undefined) {
				spans.push(i, i + n, style);
			}
		} else if ((n = match(LEX_PUNCTUATION))) {
			add(i, i + n, 'punctuation');
		} else if ((n = match(LEX_OPERATOR))) {
			add(i, i + n, 'operator');
		} else {
			n = 1;
		}
		i += n;
	}
	return spans;
}

// The length of the common start and of the common end of two lines, in UTF-16 code units. The part between them is
// the change.
export function changedRange(a: string, b: string): { prefix: number; suffix: number } {
	const max = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < max && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}
	return { prefix, suffix };
}

// The spans of an old line from the spans of the new line that replaces it. The common start and the common end keep
// the spans of the new line. The lexer gives the spans of the changed part, which grows to whole words.
export function pairedSpans(oldText: string, row: SideRow): number[] {
	const { prefix, suffix } = changedRange(oldText, row.text);
	let start = prefix;
	while (start > 0 && /\w/.test(oldText[start - 1])) {
		start--;
	}
	let end = oldText.length - suffix;
	while (end < oldText.length && /\w/.test(oldText[end])) {
		end++;
	}
	const shift = row.text.length - oldText.length; // a column of the common end in the new line is the column + shift
	const names = new Map<string, number>();
	const out: number[] = [];
	for (let i = 0; i + 2 < row.spans.length; i += 3) {
		const [a, b, style] = [row.spans[i], row.spans[i + 1], row.spans[i + 2]];
		if (/^\w+$/.test(row.text.slice(a, b))) {
			names.set(row.text.slice(a, b), style);
		}
		if (a < start) {
			out.push(a, Math.min(b, start), style);
		}
	}
	const middle = lexSpans(oldText.slice(start, end), names);
	for (let i = 0; i + 2 < middle.length; i += 3) {
		out.push(middle[i] + start, middle[i + 1] + start, middle[i + 2]);
	}
	for (let i = 0; i + 2 < row.spans.length; i += 3) {
		const [a, b, style] = [row.spans[i], row.spans[i + 1], row.spans[i + 2]];
		if (b - shift > end) {
			out.push(Math.max(a - shift, end), b - shift, style);
		}
	}
	return out;
}
