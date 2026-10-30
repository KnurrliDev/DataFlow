import { readFileSync } from 'fs';
import * as vscode from 'vscode';
import { restoreModelLayer, storeModelLayer, StoredModelLayer } from '../lenses/blocks';
import { fileKey } from '../lenses/member';
import { restoreGuide, storeGuide, StoredGuide } from '../review/guide';
import type { SideGuide, SideModel } from '../side/protocol';
import type { StateStore } from '../state/store';

// The key of the layers of a model in the state of the workspace
const LAYERS_KEY = 'dataflow.mcp.layers';
// The key of the guided review in the state of the workspace
const GUIDE_KEY = 'dataflow.mcp.guide';
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
	private timer?: NodeJS.Timeout;
	private readonly listener: vscode.Disposable;

	constructor(
		private readonly memento: vscode.Memento,
		private readonly store: StateStore,
		private readonly log: vscode.LogOutputChannel,
	) {
		this.last = store.state.modelLayers;
		this.lastGuide = store.state.guide;
		this.listener = store.onDidChange(() => {
			if (store.state.modelLayers !== this.last || store.state.guide !== this.lastGuide) {
				this.last = store.state.modelLayers;
				this.lastGuide = store.state.guide;
				clearTimeout(this.timer);
				this.timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
			}
		});
	}

	// The guide of the store with the texts of the lines of its steps, as the state of the workspace keeps it
	storedGuide(): StoredGuide | undefined {
		const guide = this.store.state.guide;
		return guide ? storeGuide(guide, (file) => this.linesOf(file)) : undefined;
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

	// Puts the layers and the guide of the last session into the store, if the store has none. A layer of a file that is
	// gone, and a layer with no block and no note in the text, go away
	restore(stored = this.memento.get<StoredModelLayer[]>(LAYERS_KEY, []), storedGuide = this.memento.get<StoredGuide>(GUIDE_KEY)): void {
		if (storedGuide && !this.store.state.guide) {
			const guide = restoreGuide(storedGuide, (file) => this.linesOf(file));
			if (guide) {
				this.store.update({ guide });
				this.log.info(`The guided review came back at step ${guide.current + 1} of ${guide.steps.length}.`);
			}
		}
		if (stored.length === 0 || this.store.state.modelLayers.length > 0) {
			return;
		}
		const layers: SideModel[] = [];
		for (const s of stored) {
			const lines = this.linesOf(s.layer.file);
			const layer = lines && restoreModelLayer(s, lines.text, lines.count);
			if (layer) {
				layers.push(layer);
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
		void this.memento.update(GUIDE_KEY, this.storedGuide());
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
