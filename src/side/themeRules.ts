import { LexicalKey, SemanticType, STYLE_COUNT, styleKeyOf } from './model';
import type { SideStyle } from './protocol';

// The rules of a color theme, and the style of each style key of the side view. These functions do not use the
// VS Code API, so the unit tests can call them. VS Code finds the styles of tokens with the same rules: see
// textMateScopeMatcher.ts, colorThemeData.ts and tokenClassificationRegistry.ts in the VS Code repository.

// A rule of tokenColors
export interface TextMateRule {
	scope?: string | string[];
	settings?: { foreground?: string; fontStyle?: string };
}

export interface TokenStyle {
	foreground?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
}

// A rule of semanticTokenColors: a selector such as variable.readonly or *.declaration, and a style
export interface SemanticRule {
	selector: string;
	style: TokenStyle;
}

// The rules of a theme. The rules of the user settings come after the rules of the theme.
export interface ThemeData {
	tokenColors: TextMateRule[];
	semanticRules: SemanticRule[];
	semanticHighlighting: boolean;
}

// The TextMate scopes of the C++ grammar of VS Code for the lexical keys, inside source.cpp
const LEXICAL_SCOPES: Record<LexicalKey, string[]> = {
	'comment': ['comment.line.double-slash.cpp'],
	'string': ['string.quoted.double.cpp'],
	'number': ['constant.numeric.decimal.cpp'],
	'operator': ['keyword.operator.cpp'],
	'punctuation': ['punctuation.cpp'],
	'preprocessor': ['meta.preprocessor.cpp', 'keyword.control.directive.cpp'],
	'keyword': ['keyword.other.cpp'],
	'keyword.control': ['keyword.control.cpp'],
	'keyword.type': ['storage.type.primitive.cpp', 'storage.type.built-in.primitive.cpp'],
	'keyword.modifier': ['storage.modifier.cpp'],
	'keyword.constant': ['constant.language.cpp'],
	'keyword.this': ['variable.language.this.cpp'],
	'keyword.storage': ['storage.type.cpp'],
	'keyword.new': ['keyword.operator.wordlike.cpp', 'keyword.operator.new.cpp'],
	'keyword.operator': ['keyword.operator.functionlike.cpp', 'keyword.operator.sizeof.cpp'],
	// the grammar adds the name of the attribute to the last scope, for example entity.other.attribute.nodiscard.cpp
	'attribute': ['support.other.attribute.cpp', 'entity.other.attribute.cpp'],
	'pragma': ['meta.preprocessor.pragma.cpp', 'entity.other.attribute-name.pragma.preprocessor.cpp'],
};

// The TextMate scopes of the C++ grammar for names. The side view uses them when the theme has no semantic colors.
// The grammar knows the kind of a name only at some places, so these scopes are an estimate. The grammar gives no
// scope to a variable.
const GRAMMAR_SCOPES: Record<SemanticType, string[]> = {
	namespace: ['entity.name.namespace.cpp'],
	class: ['entity.name.type.cpp'],
	enum: ['entity.name.type.enum.cpp'],
	enumMember: ['variable.other.enummember.cpp'],
	type: ['entity.name.type.cpp'],
	typeParameter: ['entity.name.type.template.cpp'],
	function: ['meta.function-call.cpp', 'entity.name.function.call.cpp'],
	method: ['entity.name.function.member.cpp'],
	parameter: ['variable.parameter.cpp'],
	variable: [],
	property: ['variable.other.property.cpp'],
	macro: ['entity.name.function.preprocessor.cpp'],
	label: ['entity.name.label.cpp'],
};

// The default styles of semantic tokens in VS Code: a selector and the TextMate scopes to try, in the sequence of
// tokenClassificationRegistry.ts
const SEMANTIC_DEFAULTS: [string, string[][]][] = [
	['namespace', [['entity.name.namespace']]],
	['type', [['entity.name.type'], ['support.type']]],
	['class', [['entity.name.type.class'], ['support.class']]],
	['enum', [['entity.name.type.enum']]],
	['typeParameter', [['entity.name.type.parameter']]],
	['function', [['entity.name.function'], ['support.function']]],
	['method', [['entity.name.function.member'], ['support.function']]],
	['macro', [['entity.name.function.preprocessor']]],
	['variable', [['variable.other.readwrite'], ['entity.name.variable']]],
	['parameter', [['variable.parameter']]],
	['property', [['variable.other.property']]],
	['enumMember', [['variable.other.enummember']]],
	['variable.readonly', [['variable.other.constant']]],
	['property.readonly', [['variable.other.constant.property']]],
	['type.defaultLibrary', [['support.type']]],
	['class.defaultLibrary', [['support.class']]],
	['variable.defaultLibrary', [['support.variable'], ['support.other.variable']]],
	['variable.defaultLibrary.readonly', [['support.constant']]],
	['property.defaultLibrary', [['support.variable.property']]],
	['property.defaultLibrary.readonly', [['support.constant.property']]],
	['function.defaultLibrary', [['support.function']]],
];

// The groups of editor.tokenColorCustomizations and their scopes, as in VS Code
const TOKEN_GROUPS: Record<string, string[]> = {
	comments: ['comment', 'punctuation.definition.comment'],
	strings: ['string', 'meta.embedded.assembly'],
	keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
	numbers: ['constant.numeric'],
	types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
	functions: ['entity.name.function', 'support.function'],
	variables: ['variable', 'entity.name.variable'],
};

type ScopeMatcher = (path: string[]) => number;

interface CompiledRule {
	match: ScopeMatcher;
	foreground?: string;
	fontStyle?: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parses JSON with comments and with a comma after the last item of a list, as in the files of color themes
export function parseJsonc(text: string): unknown {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) {
				if (text[i] === '\\') {
					i++;
				}
			}
			out += text.slice(start, i + 1);
		} else if (c === '/' && text[i + 1] === '/') {
			while (i + 1 < text.length && text[i + 1] !== '\n') {
				i++;
			}
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
		} else {
			out += c;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// The text of an element of XML: the entities become characters, and a CDATA section stays as it is
function xmlText(raw: string): string {
	const entity = (whole: string, name: string): string => {
		const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
		if (name in named) {
			return named[name];
		}
		const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : name.startsWith('#') ? parseInt(name.slice(1), 10) : NaN;
		return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
	};
	return raw.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map((part) => (part.startsWith('<![CDATA[')
		? part.slice(9, -3) : part.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, entity))).join('');
}

// Parses a property list of Apple in XML, for example a .tmTheme file of TextMate. It gives objects, arrays, strings,
// numbers and booleans, and throws for text that is not a property list
export function parsePlist(text: string): unknown {
	const src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
	const tags = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;
	let pos = 0;
	interface Tag {
		name: string;
		isClose: boolean;
		isEmpty: boolean;
	}
	const next = (): Tag => {
		tags.lastIndex = pos;
		const m = tags.exec(src);
		if (!m) {
			throw new Error('The property list ends too early.');
		}
		pos = tags.lastIndex;
		return { name: m[2], isClose: m[1] === '/', isEmpty: m[3] === '/' };
	};
	// the text up to the closing tag of the element
	const textOf = (open: Tag): string => {
		if (open.isEmpty) {
			return '';
		}
		const close = src.indexOf(`</${open.name}>`, pos);
		if (close < 0) {
			throw new Error(`The property list has no </${open.name}>.`);
		}
		const raw = src.slice(pos, close);
		pos = close + open.name.length + 3;
		return xmlText(raw);
	};
	const value = (open: Tag): unknown => {
		switch (open.name) {
			case 'dict': {
				const out: Record<string, unknown> = {};
				for (let t = open.isEmpty ? undefined : next(); t && !(t.isClose && t.name === 'dict'); t = next()) {
					if (t.name !== 'key' || t.isClose) {
						throw new Error(`A dict of the property list has <${t.name}> in the place of a key.`);
					}
					const key = textOf(t);
					out[key] = value(next());
				}
				return out;
			}
			case 'array': {
				const out: unknown[] = [];
				for (let t = open.isEmpty ? undefined : next(); t && !(t.isClose && t.name === 'array'); t = next()) {
					out.push(value(t));
				}
				return out;
			}
			case 'string':
			case 'date':
			case 'data':
				return textOf(open);
			case 'integer':
			case 'real':
				return Number(textOf(open));
			case 'true':
			case 'false':
				textOf(open);
				return open.name === 'true';
			default:
				throw new Error(`The property list has the unknown element <${open.name}>.`);
		}
	};
	if (next().name !== 'plist') {
		throw new Error('The text is not a property list.');
	}
	return value(next());
}

// The rules of a theme of TextMate: the items of its settings. The first item with no scope has the colors of the
// editor, and the rules ignore it
export function textMateRulesOf(plist: unknown): TextMateRule[] {
	return isObject(plist) && Array.isArray(plist.settings) ? plist.settings.filter(isObject) as TextMateRule[] : [];
}

// True if the scope is the selector name or starts with the name and a dot
function scopeMatches(scope: string, name: string): boolean {
	return scope === name || (scope.startsWith(name) && scope[name.length] === '.');
}

// All names must agree with a scope of the path. The score comes from the last name: a deeper scope and a longer
// name give a higher score.
function nameScore(names: string[], path: string[]): number {
	if (path.length < names.length) {
		return -1;
	}
	let score = -1;
	for (const name of names) {
		let found = -1;
		for (let i = path.length - 1; i >= 0 && found < 0; i--) {
			if (scopeMatches(path[i], name)) {
				found = i;
			}
		}
		if (found < 0) {
			return -1;
		}
		score = (found + 1) * 0x10000 + name.length;
	}
	return score;
}

// The matcher of a scope selector. A selector can have alternatives with , or |, an exclusion with -, groups in
// parentheses and a path of names. The score is -1 if the selector does not agree with the path.
export function scopeMatcher(selector: string): ScopeMatcher {
	const tokens = (selector.match(/[LR]:|[\w.:][\w.:-]*|[,|\-()]/g) ?? []).filter((t) => t !== 'L:' && t !== 'R:');
	let pos = 0;
	const isName = (t: string | undefined): t is string => !!t && /^[\w.:]/.test(t);

	const operand = (): ScopeMatcher | undefined => {
		const t = tokens[pos];
		if (t === '-') {
			pos++;
			const negated = operand();
			return negated && ((path) => (negated(path) < 0 ? 0 : -1));
		}
		if (t === '(') {
			pos++;
			const inner = alternatives();
			if (tokens[pos] === ')') {
				pos++;
			}
			return inner;
		}
		if (isName(t)) {
			const names: string[] = [];
			while (isName(tokens[pos])) {
				names.push(tokens[pos++]);
			}
			return (path) => nameScore(names, path);
		}
		return undefined;
	};
	const conjunction = (): ScopeMatcher | undefined => {
		const parts: ScopeMatcher[] = [];
		for (let m = operand(); m; m = operand()) {
			parts.push(m);
		}
		if (parts.length === 0) {
			return undefined;
		}
		return (path) => {
			let min = parts[0](path);
			for (let i = 1; min >= 0 && i < parts.length; i++) {
				min = Math.min(min, parts[i](path));
			}
			return min;
		};
	};
	const alternatives = (): ScopeMatcher | undefined => {
		const parts: ScopeMatcher[] = [];
		for (let m = conjunction(); m; m = conjunction()) {
			parts.push(m);
			if (tokens[pos] !== ',' && tokens[pos] !== '|') {
				break;
			}
			while (tokens[pos] === ',' || tokens[pos] === '|') {
				pos++;
			}
		}
		if (parts.length === 0) {
			return undefined;
		}
		return (path) => Math.max(...parts.map((p) => p(path)));
	};
	return alternatives() ?? (() => -1);
}

function compileRules(rules: TextMateRule[]): CompiledRule[] {
	const out: CompiledRule[] = [];
	for (const rule of rules) {
		if (!isObject(rule) || !isObject(rule.settings) || !rule.scope) {
			continue;
		}
		const selectors = (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).filter((s) => typeof s === 'string');
		const matchers = selectors.map(scopeMatcher);
		const { foreground, fontStyle } = rule.settings;
		out.push({
			match: (path) => Math.max(-1, ...matchers.map((m) => m(path))),
			foreground: typeof foreground === 'string' ? foreground : undefined,
			fontStyle: typeof fontStyle === 'string' ? fontStyle : undefined,
		});
	}
	return out;
}

// The font styles of a fontStyle value. An empty value removes all font styles.
export function fontStyleOf(fontStyle: string): TokenStyle {
	const words = fontStyle.split(/\s+/);
	return {
		bold: words.includes('bold'),
		italic: words.includes('italic'),
		underline: words.includes('underline'),
		strikethrough: words.includes('strikethrough'),
	};
}

// The style of the first scope path that a rule agrees with. For each property, the rule with the highest score
// wins, and the later rule wins at the same score.
function resolveScopes(paths: string[][], rules: CompiledRule[]): TokenStyle | undefined {
	for (const path of paths) {
		let foreground: string | undefined;
		let fontStyle: string | undefined;
		let foregroundScore = -1;
		let fontStyleScore = -1;
		for (const rule of rules) {
			const score = rule.match(path);
			if (score < 0) {
				continue;
			}
			if (rule.foreground && score >= foregroundScore) {
				foreground = rule.foreground;
				foregroundScore = score;
			}
			if (rule.fontStyle !== undefined && score >= fontStyleScore) {
				fontStyle = rule.fontStyle;
				fontStyleScore = score;
			}
		}
		if (foreground !== undefined || fontStyle !== undefined) {
			return { foreground, ...(fontStyle !== undefined ? fontStyleOf(fontStyle) : {}) };
		}
	}
	return undefined;
}

// The score of a semantic selector for a token, or -1. The selector is type(.modifier)*(:language). The type * agrees
// with all types. All modifiers of the selector must be in the token.
export function semanticScore(selector: string, type: string, modifiers: readonly string[], language: string): number {
	const [body, selectorLanguage] = selector.split(':');
	const [selectorType, ...selectorModifiers] = body.split('.');
	let score = 0;
	if (selectorLanguage !== undefined) {
		if (selectorLanguage !== language) {
			return -1;
		}
		score += 10;
	}
	if (selectorType !== '*') {
		if (selectorType !== type) {
			return -1;
		}
		score += 100;
	}
	if (!selectorModifiers.every((m) => modifiers.includes(m))) {
		return -1;
	}
	return score + selectorModifiers.length * 100;
}

// The style of a value of semanticTokenColors: a color, or an object with a color and font styles
export function readSemanticStyle(value: unknown): TokenStyle | undefined {
	if (typeof value === 'string') {
		return { foreground: value };
	}
	if (!isObject(value)) {
		return undefined;
	}
	const style: TokenStyle = typeof value.fontStyle === 'string' ? fontStyleOf(value.fontStyle) : {};
	if (typeof value.foreground === 'string') {
		style.foreground = value.foreground;
	}
	for (const p of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
		if (typeof value[p] === 'boolean') {
			style[p] = value[p] as boolean;
		}
	}
	return style;
}

export function semanticRulesOf(colors: unknown): SemanticRule[] {
	if (!isObject(colors)) {
		return [];
	}
	return Object.entries(colors).flatMap(([selector, value]) => {
		const style = readSemanticStyle(value);
		return style ? [{ selector, style }] : [];
	});
}

// The style of a semantic token. First the semantic rules. For the properties that they do not give, the defaults
// of VS Code, which try TextMate scopes of the theme.
function semanticStyle(type: SemanticType, modifiers: readonly string[], rules: SemanticRule[], tmRules: CompiledRule[]): TokenStyle {
	const result: TokenStyle = {};
	const score: Record<keyof TokenStyle, number> = { foreground: -1, bold: -1, italic: -1, underline: -1, strikethrough: -1 };
	const apply = (s: number, style: TokenStyle) => {
		if (style.foreground && score.foreground <= s) {
			score.foreground = s;
			result.foreground = style.foreground;
		}
		for (const p of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
			if (style[p] !== undefined && score[p] <= s) {
				score[p] = s;
				result[p] = style[p];
			}
		}
	};
	for (const rule of rules) {
		const s = semanticScore(rule.selector, type, modifiers, 'cpp');
		if (s >= 0) {
			apply(s, rule.style);
		}
	}
	// a property that a rule gives does not change
	for (const p of Object.keys(score) as (keyof TokenStyle)[]) {
		if (score[p] >= 0) {
			score[p] = Number.MAX_VALUE;
		}
	}
	for (const [selector, paths] of SEMANTIC_DEFAULTS) {
		const s = semanticScore(selector, type, modifiers, 'cpp');
		const style = s >= 0 ? resolveScopes(paths, tmRules) : undefined;
		if (style) {
			apply(s, style);
		}
	}
	return result;
}

function definedOnly<T extends object>(style: T): T {
	return Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined)) as T;
}

// The style of each style key of the side view
export function resolveStyles(theme: ThemeData): SideStyle[] {
	const rules = compileRules(theme.tokenColors);
	const out: SideStyle[] = [];
	for (let i = 0; i < STYLE_COUNT; i++) {
		const key = styleKeyOf(i);
		let style: TokenStyle;
		if ('lexical' in key) {
			style = resolveScopes([['source.cpp', ...LEXICAL_SCOPES[key.lexical]]], rules) ?? {};
		} else {
			// a semantic token changes only the properties that it gives. The others come from the grammar
			const grammar = GRAMMAR_SCOPES[key.type].length > 0 ? resolveScopes([['source.cpp', ...GRAMMAR_SCOPES[key.type]]], rules) ?? {} : {};
			style = theme.semanticHighlighting
				? { ...grammar, ...definedOnly(semanticStyle(key.type, key.modifiers, theme.semanticRules, rules)) }
				: grammar;
		}
		const { foreground, ...font } = style;
		out.push(definedOnly<SideStyle>({ color: foreground, ...font }));
	}
	return out;
}

// The TextMate rules of a section of editor.tokenColorCustomizations
export function customTextMateRules(section: unknown): TextMateRule[] {
	if (!isObject(section)) {
		return [];
	}
	const out: TextMateRule[] = [];
	for (const [group, scope] of Object.entries(TOKEN_GROUPS)) {
		const value = section[group];
		if (typeof value === 'string') {
			out.push({ scope, settings: { foreground: value } });
		} else if (isObject(value)) {
			const { foreground, fontStyle } = value;
			out.push({
				scope,
				settings: {
					foreground: typeof foreground === 'string' ? foreground : undefined,
					fontStyle: typeof fontStyle === 'string' ? fontStyle : undefined,
				},
			});
		}
	}
	if (Array.isArray(section.textMateRules)) {
		out.push(...section.textMateRules.filter(isObject));
	}
	return out;
}

// The sections of a customization setting for a theme: the general section, then the sections such as [Dark+] or
// [*Dark*] that agree with a name of the theme
export function customSections(setting: unknown, themeNames: string[]): Record<string, unknown>[] {
	if (!isObject(setting)) {
		return [];
	}
	const agrees = (key: string) => {
		const names = key.slice(1, -1).split('][');
		return names.some((pattern) => {
			const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
			return themeNames.some((name) => regex.test(name));
		});
	};
	const general = Object.fromEntries(Object.entries(setting).filter(([key]) => !key.startsWith('[')));
	const forTheme = Object.entries(setting)
		.filter(([key, value]) => key.startsWith('[') && key.endsWith(']') && isObject(value) && agrees(key))
		.map(([, value]) => value as Record<string, unknown>);
	return [general, ...forTheme];
}

// The styles of the side view if DataFlow cannot read the color theme: colors of the workbench that follow the theme
export function fallbackStyles(): SideStyle[] {
	const lexical: Record<LexicalKey, string> = {
		'comment': 'var(--vscode-descriptionForeground)',
		'string': 'var(--vscode-debugTokenExpression-string)',
		'number': 'var(--vscode-debugTokenExpression-number)',
		'operator': '',
		'punctuation': '',
		'preprocessor': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.control': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.type': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.modifier': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.constant': 'var(--vscode-debugTokenExpression-boolean)',
		'keyword.this': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.storage': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.new': 'var(--vscode-symbolIcon-keywordForeground)',
		'keyword.operator': 'var(--vscode-symbolIcon-keywordForeground)',
		'attribute': '',
		'pragma': '',
	};
	const semantic: Record<SemanticType, string> = {
		namespace: 'var(--vscode-symbolIcon-namespaceForeground)',
		class: 'var(--vscode-symbolIcon-classForeground)',
		enum: 'var(--vscode-symbolIcon-enumeratorForeground)',
		enumMember: 'var(--vscode-symbolIcon-enumeratorMemberForeground)',
		type: 'var(--vscode-symbolIcon-structForeground)',
		typeParameter: 'var(--vscode-symbolIcon-typeParameterForeground)',
		function: 'var(--vscode-symbolIcon-functionForeground)',
		method: 'var(--vscode-symbolIcon-methodForeground)',
		parameter: 'var(--vscode-symbolIcon-variableForeground)',
		variable: 'var(--vscode-symbolIcon-variableForeground)',
		property: 'var(--vscode-symbolIcon-propertyForeground)',
		macro: 'var(--vscode-symbolIcon-constantForeground)',
		label: '',
	};
	const out: SideStyle[] = [];
	for (let i = 0; i < STYLE_COUNT; i++) {
		const key = styleKeyOf(i);
		const color = 'lexical' in key ? lexical[key.lexical] : semantic[key.type];
		out.push(color ? { color } : {});
	}
	return out;
}
