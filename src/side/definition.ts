// Go to definition in the side view: the places of the definitions, and the history of the jumps for Back and Forward.
// This module does not use the VS Code API, so the unit tests can call it.

// A place in a file. Line and col from 0, col in UTF-16 code units
export interface SidePlace {
	file: string;
	line: number;
	col: number;
}

// A definition: the range of its name. key is the file as fileKey gives it, for a comparison of files
export interface DefinitionPlace {
	file: string;
	key: string;
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

const contains = (p: DefinitionPlace, at: { line: number; col: number }) =>
	(at.line > p.line || (at.line === p.line && at.col >= p.col)) && (at.line < p.endLine || (at.line === p.endLine && at.col <= p.endCol));

// The definitions that are not at the place of the click, with no duplicates. A click on the name of a definition gives
// the definition itself, as in the text editor
export function otherPlaces(places: readonly DefinitionPlace[], clicked: { key: string; line: number; col: number }): DefinitionPlace[] {
	const out: DefinitionPlace[] = [];
	for (const p of places) {
		const isClicked = p.key === clicked.key && contains(p, clicked);
		const isDuplicate = out.some((o) => o.key === p.key && o.line === p.line && o.col === p.col);
		if (!isClicked && !isDuplicate) {
			out.push(p);
		}
	}
	return out;
}

const samePlace = (a: SidePlace, b: SidePlace) => a.file === b.file && a.line === b.line && a.col === b.col;

// The places that the side view left with its jumps, for Back and Forward. A new jump removes the places of Forward, as
// in the text editor. The history keeps the last `max` places
export class PlaceHistory {
	private readonly back: SidePlace[] = [];
	private readonly forward: SidePlace[] = [];

	constructor(private readonly max = 50) {}

	get canGoBack(): boolean {
		return this.back.length > 0;
	}

	get canGoForward(): boolean {
		return this.forward.length > 0;
	}

	// A jump leaves the place `from`
	push(from: SidePlace): void {
		const last = this.back[this.back.length - 1];
		if (!last || !samePlace(last, from)) {
			this.back.push(from);
		}
		if (this.back.length > this.max) {
			this.back.shift();
		}
		this.forward.length = 0;
	}

	// The place before the jump to the current place, or undefined. The current place goes to Forward
	goBack(current: SidePlace): SidePlace | undefined {
		const to = this.back.pop();
		if (to) {
			this.forward.push(current);
		}
		return to;
	}

	// The place that Back left, or undefined. The current place goes to Back
	goForward(current: SidePlace): SidePlace | undefined {
		const to = this.forward.pop();
		if (to) {
			this.back.push(current);
		}
		return to;
	}
}
