// The scroll sync between the text editor and the side view, and the font rules of the text editor. These functions
// do not use the VS Code API, so the unit tests can call them.

// The guard against echoes. When one view follows the other, the follower also sends a scroll event. The guard
// ignores the scroll events of a view for a short time after the sync moved it. The Markdown preview of VS Code
// uses the same method.
export class ScrollGuard {
	private until = 0;

	constructor(private readonly windowMs = 150) {}

	// The sync moved the view at this time
	moved(now: number): void {
		this.until = now + this.windowMs;
	}

	// True if a scroll event of the view at this time is an echo of the sync
	isEcho(now: number): boolean {
		return now < this.until;
	}
}

// The height of a line in px, as the text editor of VS Code calculates it. A lineHeight of 0 gives a height from the
// font size. A lineHeight less than 8 is a multiple of the font size.
export function editorLineHeight(fontSize: number, lineHeight: number, isMac: boolean): number {
	let height = lineHeight;
	if (height <= 0) {
		height = (isMac ? 1.5 : 1.35) * fontSize;
	} else if (height < 8) {
		height = height * fontSize;
	}
	return Math.max(8, Math.round(height));
}

// The CSS font-feature-settings for the setting editor.fontLigatures: true, false, or a list of features
export function fontFeatureSettings(ligatures: unknown): string {
	if (ligatures === true || ligatures === 'true') {
		return '"liga" on, "calt" on';
	}
	if (typeof ligatures === 'string' && ligatures.trim() !== '' && ligatures !== 'false') {
		return ligatures;
	}
	return '"liga" off, "calt" off';
}
