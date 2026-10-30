import type { CostKind, CostModel } from '../engine/client';
import { functionTitle } from '../side/names';
import { LineText, toUtf16Column } from './flow';

// Hidden C++: makes the data of the side view from the items of the engine.
// This module does not use the VS Code API, so the unit tests can call it directly.

export type CostCategory = 'copy' | 'move' | 'conversion' | 'lifetime' | 'destructor' | 'allocation' | 'lookup' | 'state';

// The categories of the strategy. Temporaries and shadowed names are in "Temporaries and lifetime".
// styles.ts of the side view gives each category the color of the prototype.
export const COST_CATEGORIES: { id: CostCategory; label: string; isHeuristic?: boolean }[] = [
	{ id: 'copy', label: 'Copies' },
	{ id: 'move', label: 'Moves' },
	{ id: 'conversion', label: 'Conversions' },
	{ id: 'lifetime', label: 'Temporaries and lifetime' },
	{ id: 'destructor', label: 'Destructors' },
	{ id: 'allocation', label: 'Allocations', isHeuristic: true },
	{ id: 'lookup', label: 'Repeated lookups' },
	{ id: 'state', label: 'Hidden state' },
];

export const ALL_COST_CATEGORIES: CostCategory[] = COST_CATEGORIES.map((c) => c.id);

export function categoryOf(kind: CostKind): CostCategory {
	return kind === 'temporary' || kind === 'shadow' ? 'lifetime' : kind;
}

export interface CostFilter {
	categories: Set<CostCategory>; // the categories that show
	hidden: Set<string>; // the patterns that the user marked as not useful
}

// A range on one line. Lines start at 1. Columns are UTF-16 code units from 0.
export interface CostRange {
	line: number;
	start: number;
	end: number;
}

// One item of Hidden C++ for the side view, with the range of its code
export interface CostMark extends CostRange {
	category: CostCategory;
	text: string;
	detail: string;
	pattern: string;
	heuristic: boolean;
	related: CostRange[]; // the other lookups of a group
}

// The items of the file that the filter permits, in the sequence of the source. The engine counts lines from 1 and
// columns in UTF-8 bytes from 1. lineText gets lines from 0.
export function buildCostMarks(model: CostModel, filter: CostFilter, lineText: LineText): CostMark[] {
	const range = (r: { line: number; col: number; len: number }): CostRange => {
		const text = lineText(r.line - 1) ?? '';
		return { line: r.line, start: toUtf16Column(text, r.col), end: toUtf16Column(text, r.col + r.len) };
	};
	return model.items
		.filter((i) => filter.categories.has(categoryOf(i.kind)) && !filter.hidden.has(i.pattern))
		.sort((a, b) => a.line - b.line || a.col - b.col)
		.map((i) => ({
			...range(i), category: categoryOf(i.kind), text: i.text, detail: i.detail, pattern: i.pattern, heuristic: !!i.heuristic,
			related: (i.related ?? []).map(range),
		}));
}

// The number of items of each category in the file, without the patterns that the user marked as not useful. The
// counts include the categories that do not show, so the user can see what a switch hides.
export function costCounts(model: CostModel, filter: CostFilter): Record<CostCategory, number> {
	const out = Object.fromEntries(ALL_COST_CATEGORIES.map((c) => [c, 0])) as Record<CostCategory, number>;
	for (const item of model.items) {
		if (!filter.hidden.has(item.pattern)) {
			out[categoryOf(item.kind)]++;
		}
	}
	return out;
}

// An item of the function at the cursor, for the details column. Lines start at 1.
export interface CostItemInfo {
	line: number;
	category: CostCategory;
	text: string;
	detail: string;
	pattern: string;
	heuristic: boolean;
}

// The name of the function at the cursor, and its items that the filter permits, in the sequence of the source. A
// function that the model does not have gets no items.
export function functionItems(model: CostModel, filter: CostFilter, fn?: { qualifiedName: string; line: number }): { fn?: string; items: CostItemInfo[] } {
	const index = fn ? model.functions.findIndex((f) => f.qualifiedName === fn.qualifiedName && f.range.begin.line === fn.line) : -1;
	if (index < 0) {
		return { items: [] };
	}
	return {
		fn: functionTitle(model.functions[index]),
		items: model.items
			.filter((i) => i.fn === index && !filter.hidden.has(i.pattern) && filter.categories.has(categoryOf(i.kind)))
			.sort((x, y) => x.line - y.line || x.col - y.col)
			.map((i) => ({ line: i.line, category: categoryOf(i.kind), text: i.text, detail: i.detail, pattern: i.pattern, heuristic: !!i.heuristic })),
	};
}
