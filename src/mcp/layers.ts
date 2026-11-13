import { readFileSync } from 'fs';
import * as vscode from 'vscode';
import { restoreModelLayer, storeModelLayer, StoredModelLayer, withLayerIds } from '../lenses/blocks';
import { fileKey } from '../lenses/member';
import { restoreGuide, storeGuide, StoredGuide } from '../review/guide';
import { guideOwner, setStack } from '../review/stack';
import type { SideGuide, SideModel } from '../side/protocol';
import type { StateStore } from '../state/store';

// The key of the layers of a model in the state of the workspace
const LAYERS_KEY = 'dataflow.mcp.layers';
// The key of the one guided review of an older version in the state of the workspace
const GUIDE_KEY = 'dataflow.mcp.guide';
// The key of the stack of the guides in the state of the workspace
const GUIDES_KEY = 'dataflow.mcp.guides';

// The stack of the guides for a later session: the guides from the bottom of the stack to the top guide, and the last
// number of a guide, so the ids do not repeat
export interface StoredGuides {
	guides: StoredGuide[];
	seq: number;
}
// A change of the layers, for example during an edit, is stored after this time
const SAVE_DELAY_MS = 1000;

type LineText = (line: number) => string | undefined; // a line from 1

// Keeps the blocks, the notes and the comments of a model, and the guided review, for the next session of the workspace,
// for example after a reload of the window. Each layer keeps the text of the first and the last line of its blocks,
// notes and comments, and the guide keeps them for its steps, so the next session finds them again after a change of
// the file.
export class LayerKeeper implements vscode.Disposable {
	private last: SideModel[];
	private lastGuide?: SideGuide;
	private lastGuidesBelow: readonly SideGuide[];
	private timer?: NodeJS.Timeout;
	private readonly listener: vscode.Disposable;

	constructor(
		private readonly memento: vscode.Memento,
		private readonly store: StateStore,
		private readonly log: vscode.LogOutputChannel,
	) {
		this.last = store.state.modelLayers;
		this.lastGuide = store.state.guide;
		this.lastGuidesBelow = store.state.guidesBelow;
		this.listener = store.onDidChange(() => {
			const s = store.state;
			if (s.modelLayers !== this.last || s.guide !== this.lastGuide || s.guidesBelow !== this.lastGuidesBelow) {
				this.last = s.modelLayers;
				this.lastGuide = s.guide;
				this.lastGuidesBelow = s.guidesBelow;
				clearTimeout(this.timer);
				this.timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
			}
		});
	}

	// The stack of the guides of the store with the texts of the lines of their steps, as the state of the workspace
	// keeps it. Undefined if no guide shows
	storedGuides(): StoredGuides | undefined {
		const { guide, guidesBelow, guideSeq } = this.store.state;
		const guides = [...guidesBelow, ...(guide ? [guide] : [])];
		return guides.length > 0 ? { guides: guides.map((g) => storeGuide(g, (file) => this.linesOf(file))), seq: guideSeq } : undefined;
	}

	// The layers of the store with the texts of their lines, as the state of the workspace keeps them
	stored(): StoredModelLayer[] {
		const out: StoredModelLayer[] = [];
		for (const layer of this.store.state.modelLayers) {
			const lines = this.linesOf(layer.file);
			if (lines) {
				out.push(storeModelLayer(layer, lines.text));
			}
		}
		return out;
	}

	// Puts the layers and the guides of the last session into the store, if the store has none. A layer of a file that is
	// gone, and a layer with no block and no note in the text, go away. The one guide of an older version comes back as a
	// stack of one guide, with an id and its owner
	restore(stored = this.memento.get<StoredModelLayer[]>(LAYERS_KEY, []), storedGuides = this.storedGuidesOfMemento()): void {
		if (storedGuides && storedGuides.guides.length > 0 && !this.store.state.guide) {
			const guides = storedGuides.guides.map((s) => restoreGuide(s, (file) => this.linesOf(file)))
				.filter((g): g is SideGuide => !!g)
				.map((g) => (g.id ? g : { ...g, id: `g${g.seq}`, owner: guideOwner(g) }));
			if (guides.length > 0) {
				const top = guides[guides.length - 1];
				setStack(this.store, { guide: top, guidesBelow: guides.slice(0, -1) }, 'start', 'user');
				this.store.update({ guideSeq: Math.max(this.store.state.guideSeq, storedGuides.seq) });
				this.log.info(`${guides.length === 1 ? 'The guide' : `${guides.length} guides`} came back. The top guide shows step ${top.current + 1} of ${top.steps.length}.`);
			}
		}
		if (stored.length === 0 || this.store.state.modelLayers.length > 0) {
			return;
		}
		const layers: SideModel[] = [];
		for (const s of stored) {
			const lines = this.linesOf(s.layer.file);
			const layer = lines && restoreModelLayer(s, lines.text, lines.count);
			// a layer of an older version gets the ids of its notes and comments
			if (layer) {
				layers.push(withLayerIds(layer));
			}
		}
		if (layers.length > 0) {
			this.store.update({ modelLayers: layers });
			this.log.info(`The layers of the model came back in ${layers.length === 1 ? '1 file' : `${layers.length} files`}.`);
		}
	}

	dispose(): void {
		this.listener.dispose();
		if (this.timer) {
			clearTimeout(this.timer);
			this.save();
		}
	}

	private save(): void {
		this.timer = undefined;
		void this.memento.update(LAYERS_KEY, this.stored());
		void this.memento.update(GUIDES_KEY, this.storedGuides());
		// the stack replaces the one guide of an older version
		if (this.memento.get(GUIDE_KEY) !== undefined) {
			void this.memento.update(GUIDE_KEY, undefined);
		}
	}

	// The stack of the guides of the last session, or the one guide of an older version as a stack
	private storedGuidesOfMemento(): StoredGuides | undefined {
		const stack = this.memento.get<StoredGuides>(GUIDES_KEY);
		if (stack) {
			return stack;
		}
		const old = this.memento.get<StoredGuide>(GUIDE_KEY);
		return old ? { guides: [old], seq: old.guide.seq } : undefined;
	}

	// The lines of a file: the open document, else the file on disk. An open document can have changes that are not
	// on the disk. undefined if the file is gone
	private linesOf(file: string): { text: LineText; count: number } | undefined {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && fileKey(d.uri.fsPath) === fileKey(file));
		if (doc) {
			return { text: (l) => (l >= 1 && l <= doc.lineCount ? doc.lineAt(l - 1).text : undefined), count: doc.lineCount };
		}
		try {
			const lines = readFileSync(file, 'utf8').split(/\r?\n/);
			return { text: (l) => lines[l - 1], count: lines.length };
		} catch {
			return undefined;
		}
	}
}
