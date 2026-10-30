// The indent guides of the code view. The rules are the rules of the text editor of VS Code, in
// guidesTextModelPart.ts of the VS Code repository. These functions use no VS Code API and no DOM, so the extension,
// the webview and the unit tests can use them.

export interface GuideText {
	lineCount: number;
	tabSize: number;
	indentSize: number;
	text(line: number): string; // lines start at 1
}

// The guides of a range of lines: the start and the end line, and the level of the guide
export interface ActiveGuide {
	first: number;
	last: number;
	level: number;
}

// The indent of a line in columns, with each tab to the next tab stop. -1 for a line with only whitespace.
export function indentOf(text: string, tabSize: number): number {
	let indent = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 32) {
			indent++;
		} else if (c === 9) {
			indent = indent - (indent % tabSize) + tabSize;
		} else {
			return indent;
		}
	}
	return -1;
}

// The number of guides of a line with only whitespace, from the indents of the nearest lines with text above and
// below it. -1 means that there is no such line.
function whitespaceGuides(above: number, below: number, indentSize: number): number {
	if (above === -1 || below === -1) {
		return 0;
	}
	if (above < below) {
		return 1 + Math.floor(above / indentSize);
	}
	if (above === below) {
		return Math.ceil(below / indentSize);
	}
	return 1 + Math.floor(below / indentSize);
}

// Finds the nearest line with text in a direction. Returns the line and its indent, or -1 and -1.
function nearestText(t: GuideText, from: number, step: 1 | -1): [number, number] {
	for (let line = from; line >= 1 && line <= t.lineCount; line += step) {
		const indent = indentOf(t.text(line), t.tabSize);
		if (indent >= 0) {
			return [line, indent];
		}
	}
	return [-1, -1];
}

// The number of indent guides of each line from first to last
export function indentGuides(t: GuideText, first: number, last: number): number[] {
	const out: number[] = [];
	let aboveLine = -2; // -2: not searched yet
	let aboveIndent = -1;
	let belowLine = -2;
	let belowIndent = -1;
	for (let line = first; line <= last; line++) {
		const indent = indentOf(t.text(line), t.tabSize);
		if (indent >= 0) {
			aboveLine = line;
			aboveIndent = indent;
			out.push(Math.ceil(indent / t.indentSize));
			continue;
		}
		if (aboveLine === -2) {
			[aboveLine, aboveIndent] = nearestText(t, line - 1, -1);
		}
		if (belowLine !== -1 && (belowLine === -2 || belowLine < line)) {
			[belowLine, belowIndent] = nearestText(t, line + 1, 1);
		}
		out.push(whitespaceGuides(aboveIndent, belowIndent, t.indentSize));
	}
	return out;
}

// The number of guides of one line
function guidesOf(t: GuideText, line: number): number {
	const indent = indentOf(t.text(line), t.tabSize);
	if (indent >= 0) {
		return Math.ceil(indent / t.indentSize);
	}
	return whitespaceGuides(nearestText(t, line - 1, -1)[1], nearestText(t, line + 1, 1)[1], t.indentSize);
}


// The active guide for the cursor: the guide of the block that contains the line of the cursor. At the first line or
// the last line of a block, the guide of the block inside is active. The search stops at the lines min and max.
export function activeGuide(t: GuideText, line: number, min: number, max: number): ActiveGuide {
	let first = 0;
	let last = 0;
	let level = 0;
	let initial = 0;
	let goUp = true;
	let goDown = true;
	for (let distance = 0; goUp || goDown; distance++) {
		const up = line - distance;
		const down = line + distance;
		if (distance > 1 && (up < 1 || up < min)) {
			goUp = false;
		}
		if (distance > 1 && (down > t.lineCount || down > max)) {
			goDown = false;
		}
		if (distance > 50000) {
			goUp = false;
			goDown = false;
		}
		const upLevel = goUp && up >= 1 ? guidesOf(t, up) : -1;
		const downLevel = goDown && down <= t.lineCount ? guidesOf(t, down) : -1;
		if (distance === 0) {
			initial = upLevel;
			continue;
		}
		if (distance === 1) {
			if (down <= t.lineCount && downLevel >= 0 && initial + 1 === downLevel) {
				// the first line of a block: the guide of the block inside is active
				goUp = false;
				first = last = down;
				level = downLevel;
				continue;
			}
			if (up >= 1 && upLevel >= 0 && upLevel - 1 === initial) {
				// the last line of a block
				goDown = false;
				first = last = up;
				level = upLevel;
				continue;
			}
			first = last = line;
			level = initial;
			if (level === 0) {
				return { first, last, level };
			}
		}
		if (goUp) {
			if (upLevel >= level) {
				first = up;
			} else {
				goUp = false;
			}
		}
		if (goDown) {
			if (downLevel >= level) {
				last = down;
			} else {
				goDown = false;
			}
		}
	}
	return { first, last, level };
}
