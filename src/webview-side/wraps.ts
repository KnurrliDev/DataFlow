// A box of a lens around a part of the text of a row, for example an event call of Logic Map or a copy of Hidden C++.
// The box contains the token spans of its part. A box can contain other boxes.
export interface Wrap {
	start: number; // UTF-16 columns from 0
	end: number;
	cls: string;
	cost?: number; // the index of an item of Hidden C++, for its hover card
	detail?: string; // the id of a detail of a model, for its hover card
}

// The boxes of a line in the sequence for the code view: by start, and a longer box before a shorter box. A box that
// crosses the end of a box before it does not show, because a span cannot cross the end of its parent.
export function nestWraps(wraps: Wrap[]): Wrap[] {
	const sorted = wraps.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start || b.end - a.end);
	const out: Wrap[] = [];
	const open: Wrap[] = [];
	for (const w of sorted) {
		while (open.length > 0 && open[open.length - 1].end <= w.start) {
			open.pop();
		}
		const parent = open[open.length - 1];
		if (parent && w.end > parent.end) {
			continue;
		}
		out.push(w);
		open.push(w);
	}
	return out;
}
