import type { SideModelDetail } from './protocol';

// The details of a language model: a longer explanation or examples for a part of the code. The side view shows a
// symbol at the end of the first line of the code, and the symbol shows the text in a card. This file has the parts that
// the extension and the webview share: the search for the code of a detail, and a small part of Markdown for the text.

// A part of the code: lines from 1, UTF-16 columns from 0. endCol is after the last character
export interface CodePlace {
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

type TextOf = (line: number) => string | undefined;

// The text between two places of the code, with \n between the lines. undefined if a line is not there
export function textBetween(textOf: TextOf, p: CodePlace): string | undefined {
	const parts: string[] = [];
	for (let line = p.line; line <= p.endLine; line++) {
		const text = textOf(line);
		if (text === undefined) {
			return undefined;
		}
		parts.push(text.slice(line === p.line ? p.col : 0, line === p.endLine ? p.endCol : text.length));
	}
	return parts.join('\n');
}

// Finds code in the lines first to last: the place nearest to a line and a column. A search with no result looks again
// with no white space, so a model can give the code with a different layout
export function findCode(textOf: TextOf, code: string, near: { line: number; col: number }, lines: [number, number]): CodePlace | undefined {
	const wanted = code.replace(/\r\n?/g, '\n');
	if (wanted.trim() === '') {
		return undefined;
	}
	// the text of the lines, and the line and the column of each offset
	let text = '';
	const starts: number[] = [];
	for (let line = lines[0]; line <= lines[1]; line++) {
		const t = textOf(line);
		if (t === undefined) {
			break;
		}
		starts.push(text.length);
		text += `${t}\n`;
	}
	const placeOf = (offset: number): { line: number; col: number } => {
		let i = starts.length - 1;
		while (i > 0 && starts[i] > offset) {
			i--;
		}
		return { line: lines[0] + i, col: offset - starts[i] };
	};
	const nearest = (found: [number, number][]): CodePlace | undefined => {
		let best: CodePlace | undefined;
		let bestDistance = Infinity;
		for (const [a, b] of found) {
			const start = placeOf(a);
			const end = placeOf(b);
			const distance = Math.abs(start.line - near.line) * 100000 + Math.abs(start.col - near.col);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = { line: start.line, col: start.col, endLine: end.line, endCol: end.col };
			}
		}
		return best;
	};

	const exact: [number, number][] = [];
	for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) {
		exact.push([at, at + wanted.length]);
	}
	if (exact.length > 0) {
		return nearest(exact);
	}

	// with no white space: the offset of each character that is not white space
	const offsets: number[] = [];
	let packed = '';
	for (let i = 0; i < text.length; i++) {
		if (!/\s/.test(text[i])) {
			offsets.push(i);
			packed += text[i];
		}
	}
	const packedWanted = wanted.replace(/\s+/g, '');
	const loose: [number, number][] = [];
	for (let at = packed.indexOf(packedWanted); at >= 0; at = packed.indexOf(packedWanted, at + 1)) {
		loose.push([offsets[at], offsets[at + packedWanted.length - 1] + 1]);
	}
	return nearest(loose);
}

// The place of a detail in the text of the side view: its own place if the code is still there, else the nearest
// place of the code in the lines around it, for example after an edit in the line. undefined if the code is not there
export function anchorDetail(d: SideModelDetail, textOf: TextOf): CodePlace | undefined {
	if (textBetween(textOf, d) === d.code) {
		return { line: d.line, col: d.col, endLine: d.endLine, endCol: d.endCol };
	}
	return findCode(textOf, d.code, { line: d.line, col: d.col }, [Math.max(1, d.line - 5), d.endLine + 5]);
}

//-------------------
// Markdown

// The small part of Markdown of a detail: paragraphs, headings, lists, code blocks, `code`, **bold** and *italic*. The
// side view makes elements from these parts, so a text cannot add HTML or links
export type MdInline = { kind: 'text' | 'code' | 'bold' | 'italic'; text: string };
export type MdBlock =
	| { kind: 'paragraph' | 'heading'; parts: MdInline[] }
	| { kind: 'list'; isOrdered: boolean; items: MdInline[][] }
	| { kind: 'code'; text: string };

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s](?:[^*]*[^*\s])?)\*|\b_([^_\s](?:[^_]*[^_\s])?)_\b/g;

export function parseInline(text: string): MdInline[] {
	const out: MdInline[] = [];
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) {
			out.push({ kind: 'text', text: text.slice(last, m.index) });
		}
		if (m[1] !== undefined) {
			out.push({ kind: 'code', text: m[2].trim() });
		} else if (m[3] !== undefined || m[4] !== undefined) {
			out.push({ kind: 'bold', text: m[3] ?? m[4] });
		} else {
			out.push({ kind: 'italic', text: m[5] ?? m[6] });
		}
		last = m.index + m[0].length;
	}
	if (last < text.length) {
		out.push({ kind: 'text', text: text.slice(last) });
	}
	return out;
}

export function parseMarkdown(text: string): MdBlock[] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const out: MdBlock[] = [];
	let paragraph: string[] = [];
	let items: string[] | undefined; // the items of the open list
	const flush = () => {
		if (paragraph.length > 0) {
			out.push({ kind: 'paragraph', parts: parseInline(paragraph.join(' ')) });
			paragraph = [];
		}
	};
	const closeList = () => {
		const list = out[out.length - 1];
		if (items && list?.kind === 'list') {
			list.items = items.map(parseInline);
		}
		items = undefined;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			flush();
			closeList();
			const code: string[] = [];
			for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) {
				code.push(lines[i]);
			}
			out.push({ kind: 'code', text: code.join('\n') });
			continue;
		}
		const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			closeList();
			out.push({ kind: 'heading', parts: parseInline(heading[1].trim()) });
			continue;
		}
		const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
		if (item) {
			flush();
			const isOrdered = item[1] !== undefined;
			const list = out[out.length - 1];
			if (!items || list?.kind !== 'list' || list.isOrdered !== isOrdered) {
				closeList();
				out.push({ kind: 'list', isOrdered, items: [] });
				items = [];
			}
			items.push(item[2].trim());
			continue;
		}
		if (line.trim() === '') {
			flush();
			continue;
		}
		// an indented line after an item continues the item
		if (items && /^\s+\S/.test(line) && paragraph.length === 0) {
			items[items.length - 1] += ` ${line.trim()}`;
			continue;
		}
		closeList();
		paragraph.push(line.trim());
	}
	flush();
	closeList();
	return out;
}
