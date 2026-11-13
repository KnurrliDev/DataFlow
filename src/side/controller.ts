import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { EngineClient, FileResult } from '../engine/client';
import { mergeModelLayers } from '../lenses/blocks';
import { toUtf16Column, toUtf8Column } from '../lenses/flow';
import type { ReviewState } from '../lenses/ripple';
import { guideSummary, withCurrent, withStatus } from '../review/guide';
import { CallGraphView, CostLayerState, GuideHeatState, HeatLayerState, LogicPathState, RippleLayerState, StateStore, TraceState } from '../state/store';
import { buildSideCost } from './costLayer';
import { DefinitionPlace, otherPlaces, PlaceHistory, SidePlace } from './definition';
import { buildSideFlow, buildSideMemberFlow } from './flowLayer';
import { buildSideLogic } from './logicLayer';
import { functionTitle } from './names';
import {
	BRACKET_LEVELS, BRACKET_STYLE, LEXICAL_KEYS, plainRows, SEMANTIC_MODIFIERS, SEMANTIC_TYPES, semanticStyleIndex, shiftSpans, toRows,
} from './model';
import type {
	FromSide, SideAction, SideBrackets, SideCallGraph, SideCallList, SideCalls, SideCardKind, SideCost, SideDetailsTab, SideFlow, SideForwardCheck, SideFrame, SideGuide, SideHeat, SideIncluders,
	SideIncludes, SideLogic, SideModel, SideOutline, SideRipple, SideThreads, SideRow, SideSettings, SideStory, SideStyle, SideViewState, SideWhy, ToSide,
} from './protocol';
import { buildSideRipple, buildSideStory, fileKey, lineRanges, storyLines } from './storyLayer';
import { editorLineHeight, fontFeatureSettings, ScrollGuard } from './sync';
import { loadThemeStyles, onDidChangeThemeStyles } from './theme';
import { fallbackStyles } from './themeRules';

const CPP_LANGUAGES = new Set(['c', 'cpp', 'cuda-cpp']);
const isCpp = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && CPP_LANGUAGES.has(doc.languageId);
const sameDoc = (a: vscode.TextDocument | undefined, b: vscode.TextDocument | undefined) =>
	!!a && !!b && a.uri.toString() === b.uri.toString();

// The engine sends the tokens in parts of this number of lines. The first part contains the visible lines.
const CHUNK_LINES = 1000;
// The first part also contains this number of lines above and below the visible lines
const MARGIN_LINES = 200;
// With no semantic tokens of an extension, the side view asks again after this time, because the extension can start late
const SEMANTIC_RETRY_MS = 5000;
// The definition provider of the editor answers in this time, or the side view finds no definition
const DEFINITION_MS = 10000;

const BRACKETS: SideBrackets = { first: BRACKET_STYLE, levels: BRACKET_LEVELS, punctuation: LEXICAL_KEYS.indexOf('punctuation') };

// The style indices of variables, parameters and data members, with all modifiers
const TRACEABLE = ['variable', 'parameter', 'property'].flatMap((type) => Array.from({ length: 1 << SEMANTIC_MODIFIERS.length },
	(_, bits) => semanticStyleIndex(SEMANTIC_TYPES.indexOf(type as never), bits)));
// The style indices of functions and methods, with each set of modifiers. The menu of their names has "Show Calls"
const CALLABLE = ['function', 'method'].flatMap((type) => Array.from({ length: 1 << SEMANTIC_MODIFIERS.length },
	(_, bits) => semanticStyleIndex(SEMANTIC_TYPES.indexOf(type as never), bits)));
// The style indices of classes, enums and type aliases, with each set of modifiers. The menu of their names has "Outline"
const TYPE_NAMES = ['class', 'enum', 'type'].flatMap((type) => Array.from({ length: 1 << SEMANTIC_MODIFIERS.length },
	(_, bits) => semanticStyleIndex(SEMANTIC_TYPES.indexOf(type as never), bits)));
// The style indices of all names. Ctrl+click on a name goes to its definition
const NAVIGABLE = SEMANTIC_TYPES.flatMap((_, type) => Array.from({ length: 1 << SEMANTIC_MODIFIERS.length },
	(__, bits) => semanticStyleIndex(type, bits)));
// The style index of a string. Ctrl+click on the file of an #include opens the file
const INCLUDE_FILE = LEXICAL_KEYS.indexOf('string');

// The settings of the text editor that change the code view
const EDITOR_SETTINGS = ['editor.fontSize', 'editor.lineHeight', 'editor.fontLigatures', 'editor.letterSpacing', 'editor.tabSize',
	'editor.indentSize', 'editor.guides', 'editor.bracketPairColorization', 'editor.multiCursorModifier'];

// A promise with a time limit: undefined after the time
function withLimit<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
	return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}

// Animations are on if the setting is on and VS Code does not reduce motion
function animationsOn(): boolean {
	const config = vscode.workspace.getConfiguration();
	return config.get<string>('dataflow.animations') === 'on' && config.get<string>('workbench.reduceMotion') !== 'on';
}

// The number of lines that the text editor keeps above a line that it reveals at the top: the lines of the sticky scroll,
// or editor.cursorSurroundingLines, but not more than half of the visible lines. The side view reveals the line under
// these lines, so the first line of the editor is the first line of the side view.
function revealPadding(editor: vscode.TextEditor): number {
	const config = vscode.workspace.getConfiguration('editor', editor.document);
	const sticky = config.get<boolean>('stickyScroll.enabled', true) ? config.get<number>('stickyScroll.maxLineCount', 5) : 0;
	const lines = Math.max(config.get<number>('cursorSurroundingLines', 0), sticky);
	const visible = editor.visibleRanges[0];
	const visibleLines = visible ? visible.end.line - visible.start.line + 1 : 0;
	return Math.floor(Math.min(visibleLines / 2, lines));
}

// The model of the file in the side view. The rows have the text that the engine parsed, or the text of the editor
// until the tokens of the engine come.
interface FileModel {
	doc: vscode.TextDocument;
	file: string;
	rows: SideRow[]; // the row of line n is rows[n - 1]
	version?: number; // the version of the text of the tokens. Undefined until the tokens come
	parse?: FileResult;
	error?: string;
	inactive?: [number, number][]; // the ranges of lines that a condition of the preprocessor skips
	// the rows that an edit changed before the engine parsed the edit, with the version of the document after the edit
	edited?: Map<number, number>;
	// an edit added or removed lines at this version of the document. The rows wait for the tokens of this version
	waitFor?: number;
}

// The side view: a webview panel beside the text editor. It shows the file of the active C++ editor, and it scrolls
// with the editor. docs/side-view-strategy.md describes it.
export class SideViewController implements vscode.Disposable {
	static readonly viewType = 'dataflow.sideView';

	private panel?: vscode.WebviewPanel;
	private panelSubscriptions: vscode.Disposable[] = [];
	private readonly subscriptions: vscode.Disposable[] = [];
	private model?: FileModel;
	private styles: SideStyle[] = fallbackStyles();
	private stylesError?: string;
	private stylesLoad = 0; // the number of the newest load of the theme styles
	private hasSemanticTokens = true; // an extension gives semantic tokens for the file of the side view
	private semanticRetry?: NodeJS.Timeout;
	private readonly editorGuard = new ScrollGuard();
	private readonly viewGuard = new ScrollGuard();
	private loadRun = 0; // a newer load of tokens stops an older load
	private engineState?: string;
	private lastTrace?: TraceState;
	private lastFlow: SideFlow | null = null;
	private lastLogicPath?: LogicPathState;
	private lastLogic: SideLogic | null = null;
	private lastCostLayer?: CostLayerState;
	private lastCost: SideCost | null = null;
	private lastHeatLayer?: HeatLayerState;
	private lastCallGraph?: CallGraphView;
	private lastHeat: SideHeat | null = null;
	private lastIncludes: SideIncludes | null = null;
	private lastIncludesLayer?: SideIncludes;
	private lastIncluders?: SideIncluders;
	private lastForwardCheck: SideForwardCheck | null = null;
	private forwardCheckRun = 0; // a new check or new include data makes the result of a running check old
	private lastCalls: SideCalls | null = null;
	private lastCallsLayer?: SideCalls;
	private lastThreads: SideThreads | null = null;
	private lastThreadsLayer?: SideThreads;
	private lastModel: SideModel | null = null;
	private lastModelLayers?: SideModel[];
	private lastGuide?: SideGuide;
	private lastGuideHeat?: GuideHeatState;
	private lastGuideView: SideGuide | null = null;
	private pendingModel?: SideModel; // a layer that an edit moved. It waits for the rows of the new text
	private lastReview?: ReviewState;
	private lastRippleLayer?: RippleLayerState;
	private lastStory: SideStory | null = null;
	private lastRipple: SideRipple | null = null;
	private storyRun = 0; // a newer load of the story stops an older load
	private storySeq = 0; // the number of the review of the story
	private storyRows = new Map<string, Map<number, SideRow>>(); // the rows of the story with tokens, by the key of the file
	// The script of the webview is ready for messages. A hidden webview loses its script, and it starts again when it shows.
	private isViewReady = false;
	private pendingDetails?: SideDetailsTab; // a tab of the details column, for the message after the script is ready

	// For the tests: the render times of the code view in ms, the number of inactive rows of the last render, the visible
	// lines with a dot for the hints at the end, the last line and the last answer to 'why' that the side view got
	readonly renderTimes: number[] = [];
	lastInactiveRows = 0;
	lastShortEnds: { lines: number[]; width: number } = { lines: [], width: 0 };
	lastCard?: { kind: SideCardKind | null; line: number }; // the last answer to the command "Show Card at Cursor"
	lastCallList: SideCallList | null = null; // the last list of "Show Calls"
	lastOutline: SideOutline | null = null; // the last panel of "Outline"
	// the card of the command "Show Card at Cursor" is open. A move of the cursor and a new file close it
	private isCardOpen = false;
	private viewCursor?: { doc: vscode.TextDocument; pos: vscode.Position }; // the cursor of the side view, see cursorPlace
	private viewSelection?: { doc: vscode.TextDocument; range: vscode.Range }; // the selection of the side view, see selectionPlace
	private viewTop = 1; // the first visible line of the side view
	private readonly history = new PlaceHistory(); // the places that the jumps of the side view left, for Back and Forward
	lastScrollTo?: number;
	lastWhy?: SideWhy;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: StateStore,
		private readonly engine: () => EngineClient | undefined,
		private readonly onAction: (action: SideAction, editor: vscode.TextEditor | undefined) => void,
		private readonly onCursor: () => void = () => undefined, // the cursor of the side view moved
	) {
		this.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				// the side view keeps its file when the focus goes into the side view or into an editor of a different language
				if (this.panel && editor && isCpp(editor.document) && !sameDoc(editor.document, this.model?.doc)) {
					this.showFile(editor.document);
				}
				if (editor && sameDoc(editor.document, this.model?.doc)) {
					this.keepCursor(editor);
				}
			}),
			vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
				if (sameDoc(e.textEditor.document, this.model?.doc)) {
					this.fromEditor(e.textEditor);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.model && sameDoc(e.document, this.model.doc)) {
					this.shiftCursor(e);
					// an old selection is not correct after an edit
					this.viewSelection = undefined;
					this.applyEdit(this.model, e);
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (sameDoc(e.textEditor.document, this.model?.doc)) {
					this.keepCursor(e.textEditor);
					this.closeCard();
					this.post({ type: 'cursor', line: e.selections[0].active.line + 1 });
				}
			}),
			vscode.window.onDidChangeTextEditorOptions((e) => {
				if (sameDoc(e.textEditor.document, this.model?.doc)) {
					this.post({ type: 'settings', settings: this.settings() });
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (EDITOR_SETTINGS.some((s) => e.affectsConfiguration(s))) {
					this.post({ type: 'settings', settings: this.settings() });
				}
				if (e.affectsConfiguration('editor.bracketPairColorization.independentColorPoolPerBracketType')) {
					void this.loadTokens();
				}
				if (e.affectsConfiguration('dataflow.animations') || e.affectsConfiguration('workbench.reduceMotion')) {
					this.post({ type: 'frame', frame: this.frame() });
				}
			}),
			onDidChangeThemeStyles(() => void this.loadStyles()),
			store.onDidChange((state) => {
				// after a start or a restart of the engine, load the tokens again
				if (state.engine !== this.engineState) {
					this.engineState = state.engine;
					if (state.engine === 'ready') {
						void this.loadTokens();
					}
				}
				if (state.trace !== this.lastTrace) {
					this.postFlow();
				}
				if (state.logicPath !== this.lastLogicPath) {
					this.postLogic();
				}
				if (state.costLayer !== this.lastCostLayer) {
					this.postCost();
				}
				if (state.heatLayer !== this.lastHeatLayer || state.callGraph !== this.lastCallGraph) {
					this.postHeat();
				}
				if (state.includesLayer !== this.lastIncludesLayer) {
					this.postIncludes();
				}
				if (state.includersLayer !== this.lastIncluders) {
					this.lastIncluders = state.includersLayer;
					this.post({ type: 'includers', includers: this.lastIncluders ?? null });
				}
				if (state.callsLayer !== this.lastCallsLayer) {
					this.postCalls();
				}
				if (state.threadsLayer !== this.lastThreadsLayer) {
					this.postThreads();
				}
				if (state.modelLayers !== this.lastModelLayers) {
					this.postModel();
				}
				if (state.guide !== this.lastGuide || state.guideHeat !== this.lastGuideHeat) {
					this.postGuide();
				}
				if (state.review !== this.lastReview || state.rippleLayer !== this.lastRippleLayer) {
					void this.loadStory();
					this.postRipple();
				}
				this.post({ type: 'frame', frame: this.frame() });
			}),
		);
		void this.loadStyles();
	}

	// The data of Flow Lens that the side view got last, for the tests
	get flow(): SideFlow | null {
		return this.lastFlow;
	}

	// The data of Logic Map that the side view got last, for the tests
	get logic(): SideLogic | null {
		return this.lastLogic;
	}

	// The data of Hidden C++ that the side view got last, for the tests
	get cost(): SideCost | null {
		return this.lastCost;
	}

	// The heat that the side view got last, for the tests
	get heat(): SideHeat | null {
		return this.lastHeat;
	}

	// The include hierarchy that the side view got last, for the tests
	get includes(): SideIncludes | null {
		return this.lastIncludes;
	}

	// The result of the button Check of the forward declarations, as the side view got it last, for the tests
	get forwardCheck(): SideForwardCheck | null {
		return this.lastForwardCheck;
	}

	// The source files that include a file, as the side view got them last, for the tests
	get includers(): SideIncluders | null {
		return this.lastIncluders ?? null;
	}

	// The call graph that the side view got last, for the tests
	get calls(): SideCalls | null {
		return this.lastCalls;
	}

	// The threads and the shared data that the side view got last, for the tests
	get threads(): SideThreads | null {
		return this.lastThreads;
	}

	// The blocks and the notes of a language model that the side view got last, for the tests
	get modelLayer(): SideModel | null {
		return this.lastModel;
	}

	// The story of Change Ripple and the ripple in the file view that the side view got last, for the tests
	get story(): SideStory | null {
		return this.lastStory;
	}

	get ripple(): SideRipple | null {
		return this.lastRipple;
	}

	// The toolbar and the status line that the side view shows now, for the tests
	get frameState(): SideFrame {
		return this.frame();
	}

	get isOpen(): boolean {
		return !!this.panel;
	}

	// The side view is open, and its tab shows
	get isVisible(): boolean {
		return !!this.panel?.visible;
	}

	// The rows that the side view shows now, for the tests
	get rows(): readonly SideRow[] {
		return this.model?.rows ?? [];
	}

	// The version of the text of the tokens. -1 is the file on disk. Undefined until the tokens come.
	get tokenVersion(): number | undefined {
		return this.model?.version;
	}

	get file(): string | undefined {
		return this.model?.file;
	}

	get document(): vscode.TextDocument | undefined {
		return this.model?.doc;
	}

	// The cursor of the side view while no text editor shows its file, for example with Claude Code in front of the C++
	// editor. It starts at the last cursor of the text editor, and a click in the side view moves it. With a text editor
	// of the file, the cursor of that editor counts, and this is undefined
	get cursorPlace(): { doc: vscode.TextDocument; pos: vscode.Position } | undefined {
		const model = this.model;
		const cursor = this.viewCursor;
		return model && cursor && sameDoc(cursor.doc, model.doc) && !this.editorForSync() ? { doc: model.doc, pos: cursor.pos } : undefined;
	}

	// The code that the user selected in the side view while no text editor shows its file. With a text editor of the
	// file, the side view gives its selection to that editor, and this is undefined
	get selectionPlace(): { doc: vscode.TextDocument; range: vscode.Range } | undefined {
		const model = this.model;
		const selection = this.viewSelection;
		return model && selection && sameDoc(selection.doc, model.doc) && !this.editorForSync() ? { doc: model.doc, range: selection.range } : undefined;
	}

	// Shows a place in the side view only, with no text editor: the file, the line in the middle part of the view, and
	// the cursor of the side view. For a place of a click in the side view, of a list, or of a tool of the model while
	// no C++ text editor shows
	showPlace(doc: vscode.TextDocument, pos: vscode.Position): void {
		this.store.update({ sideMode: 'file' });
		if (!this.panel) {
			this.open();
		} else {
			this.panel.reveal(undefined, true);
		}
		if (!sameDoc(doc, this.model?.doc)) {
			this.showFile(doc);
		}
		this.setViewCursor(doc, pos, true);
	}

	// True if a C++ text editor shows. Else the side view is the only view of the code, and it moves in itself
	get hasCodeEditor(): boolean {
		return vscode.window.visibleTextEditors.some((e) => isCpp(e.document));
	}

	// Moves the cursor to a place for a tool of the model or for an extension, and shows the place: in the text editor
	// beside the side view and in the side view, or with no C++ text editor, in the side view only. The lenses follow the
	// cursor, and the focus stays. Lines start at 1, the column is a column of VS Code
	async goTo(file: string, line: number, col = 0): Promise<void> {
		if (!this.panel) {
			this.open();
		}
		await this.openPlace(file, line, col);
	}

	// Shows the list of "Show Calls" in the side view, or updates it with the calls in other files. null closes it
	showCallList(list: SideCallList | null): void {
		this.lastCallList = list;
		if (list && !this.panel) {
			this.open();
		}
		this.post({ type: 'callList', list });
	}

	// Shows the panel of "Outline" in the side view. null closes it
	showOutline(outline: SideOutline | null): void {
		this.lastOutline = outline;
		if (outline && !this.panel) {
			this.open();
		}
		this.post({ type: 'outline', outline });
	}

	// The ranges of lines that the side view shows as inactive, for the tests
	get inactiveRanges(): readonly [number, number][] | undefined {
		return this.model?.inactive;
	}

	get styleTable(): readonly SideStyle[] {
		return this.styles;
	}

	// Opens the side view beside the active editor, or shows it. The text editor keeps the focus.
	open(): void {
		if (this.panel) {
			this.panel.reveal(undefined, true);
		} else {
			const panel = vscode.window.createWebviewPanel(SideViewController.viewType, 'DataFlow',
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
				{ ...this.webviewOptions(), enableFindWidget: true });
			this.attach(panel);
		}
		const doc = vscode.window.activeTextEditor?.document;
		if (doc && isCpp(doc) && !sameDoc(doc, this.model?.doc)) {
			this.showFile(doc);
		}
	}

	// The command "Show Card at Cursor": the side view shows the card of the item at the cursor of the editor or of the
	// side view, as for the mouse. A second command closes the card
	toggleCard(doc: vscode.TextDocument, pos: vscode.Position): void {
		if (this.isCardOpen) {
			this.closeCard();
			return;
		}
		if (!this.panel?.visible || !sameDoc(doc, this.model?.doc)) {
			vscode.window.setStatusBarMessage('DataFlow: Open the side view for this file.', 4000);
			return;
		}
		this.isCardOpen = true;
		this.post({ type: 'showCard', line: pos.line + 1, col: pos.character });
	}

	private closeCard(): void {
		if (this.isCardOpen) {
			this.isCardOpen = false;
			this.post({ type: 'hideCard' });
		}
	}

	// Restores the side view after a reload of the window
	async restore(panel: vscode.WebviewPanel, state: SideViewState | undefined): Promise<void> {
		panel.webview.options = this.webviewOptions();
		this.attach(panel);
		const active = vscode.window.activeTextEditor?.document;
		let doc = active && isCpp(active) ? active : undefined;
		if (!doc && state?.file) {
			doc = await vscode.workspace.openTextDocument(vscode.Uri.file(state.file)).then((d) => d, () => undefined);
		}
		if (doc) {
			this.showFile(doc);
		}
	}

	// The extension sent a document that opened to the engine. A change of the language also opens the document, for
	// example when an .inc file changes to C++. Its editor does not become active again, thus the side view shows it here.
	onDidSendOpen(doc: vscode.TextDocument): void {
		if (this.panel && vscode.window.activeTextEditor?.document === doc && !sameDoc(doc, this.model?.doc)) {
			this.showFile(doc);
		}
	}

	// The extension sent a change of a document to the engine. The side view shows the new text after the parse.
	onDidSendChange(doc: vscode.TextDocument): void {
		if (sameDoc(doc, this.model?.doc)) {
			void this.loadTokens();
		}
	}

	// The engine parses a file in a new way, for example after the lines of the source file that includes it. The side
	// view shows the result of the new parse, for example with no errors.
	onDidChangeParse(file: string): void {
		if (this.model && fileKey(this.model.file) === fileKey(file)) {
			void this.loadTokens();
		}
	}

	// A message from the webview. The tests also call this method.
	receive(message: FromSide): void {
		switch (message.type) {
			case 'ready':
				this.isViewReady = true;
				this.sendAll();
				if (this.pendingDetails) {
					this.post({ type: 'details', lens: this.pendingDetails });
					this.pendingDetails = undefined;
				}
				break;
			case 'scroll':
				this.viewTop = message.line;
				this.fromView(message.line);
				break;
			case 'select':
				this.select(message.line, message.col ?? 0);
				break;
			case 'selectRange':
				this.selectRange(message.line, message.col, message.endLine, message.endCol);
				break;
			case 'revealLine':
				this.select(message.line, 0, true);
				break;
			case 'trace':
				// the cursor goes to the variable too, as for a trace in the editor
				this.select(message.line, message.col);
				this.onAction(message, this.editorForSync());
				break;
			case 'traceVariable':
			case 'clearTrace':
			case 'toggleLens':
			case 'setChoice':
			case 'resetChoices':
			case 'why':
			case 'applyWhy':
			case 'setCostCategory':
			case 'notUseful':
			case 'showHidden':
			case 'reviewChanges':
			case 'clearReview':
			case 'openDiff':
			case 'guideDiff':
			case 'callFocus':
			case 'callsShown':
			case 'includersShown':
			case 'parseMemberFile':
			case 'parseMemberFiles':
			case 'clearModel':
			case 'heatScan':
			case 'heatStop':
			case 'clientAction':
				this.onAction(message, this.editorForSync());
				break;
			case 'showStory':
				this.store.update({ sideMode: 'story' });
				break;
			case 'showFileView':
				this.store.update({ sideMode: 'file' });
				break;
			case 'openPlace':
				void this.openPlace(message.file, message.line, message.col);
				break;
			case 'guideGo':
				void this.goToGuideStep(message.index);
				break;
			case 'guideStatus':
				if (this.store.state.guide) {
					this.store.update({ guide: withStatus(this.store.state.guide, message.index, message.status) });
				}
				break;
			case 'guideCopy':
				void this.copyGuideSummary();
				break;
			case 'checkForward':
				void this.checkForward(message.line, message.text);
				break;
			case 'copyForward':
				void vscode.env.clipboard.writeText(message.text).then(() =>
					vscode.window.setStatusBarMessage('DataFlow: The forward declarations are on the clipboard.', 4000));
				break;
			case 'guideClose':
				this.store.update({ guide: undefined });
				break;
			case 'openDefinition':
				void this.openDefinition(message.file, message.line, message.col);
				break;
			case 'goToDefinition':
				void this.goToDefinition(message.line, message.col, message.isCallable ?? false);
				break;
			case 'goToPlace':
				void this.jumpTo({ file: message.file, line: Math.max(0, message.line - 1), col: message.col });
				break;
			case 'goBack':
				void this.goBack();
				break;
			case 'goForward':
				void this.goForward();
				break;
			case 'outlineGo':
				void this.outlineGo(message.file, message.line, message.col, message.toDefinition ?? false);
				break;
			case 'openEditor':
				void this.focusEditor();
				break;
			case 'command':
				void vscode.commands.executeCommand(message.command);
				break;
			case 'shortEnds':
				this.lastShortEnds = { lines: message.lines, width: message.width };
				break;
			case 'card':
				this.lastCard = { kind: message.kind, line: message.line };
				if (!message.kind) {
					this.isCardOpen = false;
					vscode.window.setStatusBarMessage('DataFlow: The side view has no card at the cursor.', 4000);
				}
				break;
			case 'rendered':
				this.lastInactiveRows = message.inactiveRows;
				this.renderTimes.push(message.ms);
				if (this.renderTimes.length > 200) {
					this.renderTimes.shift();
				}
				break;
		}
	}

	// The answer to the action 'why' of the side view
	answerWhy(why: SideWhy): void {
		this.lastWhy = why;
		this.post({ type: 'why', why });
	}

	// Opens the details column of the side view at the tab. A side view that opens now gets the message when its
	// script is ready.
	showDetails(lens: SideDetailsTab): void {
		if (this.isViewReady) {
			this.post({ type: 'details', lens });
		} else {
			this.pendingDetails = lens;
		}
	}

	// Opens a file in the text editor, with the side view beside it. If no text editor is open and the side view is in the
	// first column, the side view goes to the second column first.
	async openFile(file: string): Promise<void> {
		const hasEditor = vscode.window.visibleTextEditors.some((e) => e.viewColumn !== this.panel?.viewColumn);
		if (this.panel && !hasEditor && this.panel.viewColumn === vscode.ViewColumn.One) {
			this.panel.reveal(vscode.ViewColumn.Two, true);
		}
		await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: this.editorColumn(), preview: false });
		this.open();
	}

	// The column of the text editor beside the side view, for an editor that the side view opens
	editorColumn(): vscode.ViewColumn {
		return this.editorForSync()?.viewColumn
			?? vscode.window.visibleTextEditors.find((e) => e.viewColumn !== this.panel?.viewColumn)?.viewColumn ?? vscode.ViewColumn.One;
	}

	dispose(): void {
		clearTimeout(this.semanticRetry);
		this.panel?.dispose();
		this.subscriptions.forEach((s) => s.dispose());
	}

	private webviewOptions(): vscode.WebviewOptions {
		return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out', 'webview')] };
	}

	private attach(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		this.isViewReady = false;
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'dataflow.svg');
		panel.webview.html = this.html(panel.webview);
		this.panelSubscriptions = [
			panel.webview.onDidReceiveMessage((message: FromSide) => this.receive(message)),
			panel.onDidChangeViewState((e) => {
				if (!e.webviewPanel.visible) {
					this.isViewReady = false;
				}
			}),
			panel.onDidDispose(() => {
				// without a panel, the model does not get the changes of the file. A new panel loads the file again
				this.panel = undefined;
				this.model = undefined;
				this.panelSubscriptions.forEach((s) => s.dispose());
				this.panelSubscriptions = [];
				this.loadRun++;
			}),
		];
	}

	private post(message: ToSide): void {
		if (message.type === 'scrollTo') {
			this.lastScrollTo = message.line;
		}
		void this.panel?.webview.postMessage(message);
	}

	// Shows a file. The rows have the text of the editor until the tokens of the engine come.
	private showFile(doc: vscode.TextDocument): void {
		this.isCardOpen = false;
		const lines: string[] = [];
		for (let i = 0; i < doc.lineCount; i++) {
			lines.push(doc.lineAt(i).text);
		}
		this.model = { doc, file: doc.uri.fsPath, rows: plainRows(lines) };
		if (this.panel) {
			this.panel.title = `DataFlow: ${doc.uri.path.split('/').pop()}`;
		}
		this.sendAll();
		void this.loadTokens();
	}

	// Sends the full state, for example when the webview starts again after it was hidden
	private sendAll(): void {
		this.post({ type: 'settings', settings: this.settings() });
		this.post({
			type: 'styles', styles: this.styles, brackets: BRACKETS, traceable: TRACEABLE, callable: CALLABLE, typeNames: TYPE_NAMES, navigable: NAVIGABLE,
			includeFile: INCLUDE_FILE,
		});
		this.post({ type: 'frame', frame: this.frame() });
		this.post({ type: 'story', story: this.lastStory });
		this.postGuide();
		const model = this.model;
		if (!model) {
			return;
		}
		this.post({ type: 'file', file: model.file, lineCount: model.rows.length, rows: model.rows });
		if (model.inactive) {
			this.post({ type: 'inactive', file: model.file, ranges: model.inactive });
		}
		this.postFlow();
		this.postLogic();
		this.postCost();
		this.postHeat();
		this.postIncludes();
		this.postCalls();
		this.postThreads();
		this.postModel();
		this.postRipple();
		const editor = this.editorForSync();
		const cursor = this.cursorPlace;
		if (editor) {
			this.keepCursor(editor);
			this.viewGuard.moved(Date.now());
			this.post({ type: 'scrollTo', line: (editor.visibleRanges[0]?.start.line ?? 0) + 1 });
			this.post({ type: 'cursor', line: editor.selection.active.line + 1 });
		} else if (cursor) {
			this.post({ type: 'center', line: cursor.pos.line + 1 });
			this.post({ type: 'cursor', line: cursor.pos.line + 1 });
		}
	}

	// Asks the engine for the tokens of the file. The part with the visible lines comes first.
	private async loadTokens(): Promise<void> {
		const engine = this.engine();
		const model = this.model;
		if (!engine || engine.currentState !== 'ready' || !model || !this.panel) {
			return;
		}
		const run = ++this.loadRun;
		// the visible lines: of the text editor, else of the side view, which shows its cursor in its middle part
		const visible = this.editorForSync()?.visibleRanges[0];
		const top = visible?.start.line ?? this.cursorPlace?.pos.line ?? this.viewTop - 1;
		const first = Math.max(1, top + 1 - MARGIN_LINES);
		const last = (visible?.end.line ?? top) + 1 + MARGIN_LINES;
		const parts: [number, number][] = [[first, last]];
		const isLevelPerType = this.isLevelPerType(model.doc);
		void this.checkSemanticTokens(model.doc);
		try {
			for (let i = 0; i < parts.length; i++) {
				const res = await engine.tokens(model.file, parts[i][0], parts[i][1], isLevelPerType);
				if (run !== this.loadRun || model !== this.model) {
					return;
				}
				if (i === 0) {
					// the other parts, in chunks: first the lines below the visible lines, then the lines above them
					for (let from = last + 1; from <= res.lineCount; from += CHUNK_LINES) {
						parts.push([from, Math.min(res.lineCount, from + CHUNK_LINES - 1)]);
					}
					for (let to = first - 1; to >= 1; to -= CHUNK_LINES) {
						parts.push([Math.max(1, to - CHUNK_LINES + 1), to]);
					}
				}
				this.applyRows(model, res.lineCount, res.version, toRows(res.legend, res.lines), res);
			}
			void this.loadInactive(model, run);
		} catch (error) {
			if (run === this.loadRun && model === this.model) {
				model.error = `DataFlow has no tokens for this file: ${error instanceof Error ? error.message : error}`;
				this.post({ type: 'frame', frame: this.frame() });
			}
		}
	}

	// Asks the engine for the lines that a condition of the preprocessor skips. The tokens come first, because the engine
	// can need a pass of the preprocessor for them
	private async loadInactive(model: FileModel, run: number): Promise<void> {
		const engine = this.engine();
		if (!engine || engine.currentState !== 'ready') {
			return;
		}
		try {
			const res = await engine.inactive(model.file);
			if (run !== this.loadRun || model !== this.model) {
				return;
			}
			model.inactive = res.ranges;
			this.post({ type: 'inactive', file: model.file, ranges: res.ranges });
		} catch {
			// the lines stay active
		}
	}

	private applyRows(model: FileModel, lineCount: number, version: number, rows: SideRow[], parse: FileResult): void {
		if (model.rows.length !== lineCount) {
			// the parsed text has a different number of lines. The other parts bring the missing rows
			model.rows = Array.from({ length: lineCount }, (_, i) => model.rows[i] ?? { line: i + 1, text: '', spans: [] });
		}
		// a row that an edit changed after this version keeps the text of the editor
		const isNewer = (row: SideRow) => (model.edited?.get(row.line) ?? -1) > version;
		rows = rows.filter((row) => !isNewer(row));
		for (const row of rows) {
			model.rows[row.line - 1] = row;
		}
		for (const [line, edit] of model.edited ?? []) {
			if (edit <= version) {
				model.edited!.delete(line);
			}
		}
		if (model.waitFor !== undefined && version >= model.waitFor) {
			model.waitFor = undefined;
		}
		const changed = model.version !== version || model.parse?.parseCount !== parse.parseCount;
		model.version = version;
		model.parse = parse;
		model.error = undefined;
		this.post({ type: 'rows', lineCount, version, rows });
		if (changed) {
			this.post({ type: 'frame', frame: this.frame() });
		}
		if (this.pendingModel && version >= model.doc.version) {
			this.postModel();
		}
	}

	// An edit of the editor shows at once in the side view. An edit in one line changes the text of its row, and the
	// tokens move with the text. The tokens of the engine replace the row after the parse. An edit that adds or removes
	// lines waits for the parse, because it moves the other rows and the data of the lenses
	private applyEdit(model: FileModel, e: vscode.TextDocumentChangeEvent): void {
		if (e.contentChanges.length === 0) {
			return;
		}
		const isMultiLine = e.contentChanges.some((c) => c.range.start.line !== c.range.end.line || /[\r\n]/.test(c.text));
		if (isMultiLine || model.waitFor !== undefined) {
			model.waitFor = Math.max(model.waitFor ?? 0, e.document.version);
			model.edited?.clear();
			return;
		}
		// the changes of one line from its end, so that each change has the positions of the text before it
		const changes = [...e.contentChanges].sort((x, y) => y.range.start.character - x.range.start.character);
		const lines = new Set(changes.map((c) => c.range.start.line));
		const rows: SideRow[] = [];
		for (const line of lines) {
			const old = model.rows[line];
			if (!old || line >= e.document.lineCount) {
				continue;
			}
			let spans = old.spans;
			for (const c of changes.filter((x) => x.range.start.line === line)) {
				spans = shiftSpans(spans, c.range.start.character, c.range.end.character, c.text.length);
			}
			const row = { line: line + 1, text: e.document.lineAt(line).text, spans };
			model.rows[line] = row;
			(model.edited ??= new Map()).set(line + 1, e.document.version);
			rows.push(row);
		}
		if (rows.length > 0) {
			this.post({ type: 'rows', lineCount: model.rows.length, version: model.version ?? -1, rows });
		}
	}

	// A change of the theme can start a load while an older load runs, and the older load can end last. So only the
	// newest load sends its styles. For example, VS Code with a new profile starts with a dark theme, then it changes
	// to the theme of the settings.
	private async loadStyles(): Promise<void> {
		const load = ++this.stylesLoad;
		const result = await loadThemeStyles(this.hasSemanticTokens);
		if (load !== this.stylesLoad) {
			return;
		}
		this.styles = result.styles;
		this.stylesError = result.error;
		this.post({
			type: 'styles', styles: this.styles, brackets: BRACKETS, traceable: TRACEABLE, callable: CALLABLE, typeNames: TYPE_NAMES, navigable: NAVIGABLE,
			includeFile: INCLUDE_FILE,
		});
	}

	// Without an extension that gives semantic tokens, for example the C/C++ extension or clangd, the text editor shows
	// only the colors of the grammar, and so does the side view. An extension can start after the side view, so each
	// load of the tokens asks again, and with no semantic tokens, DataFlow asks again after SEMANTIC_RETRY_MS
	private async checkSemanticTokens(doc: vscode.TextDocument, retries = 3): Promise<void> {
		clearTimeout(this.semanticRetry);
		let hasTokens = true;
		try {
			hasTokens = !!await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
		} catch {
			// keep the semantic colors
		}
		if (!sameDoc(doc, this.model?.doc)) {
			return;
		}
		if (!hasTokens && retries > 0) {
			this.semanticRetry = setTimeout(() => void this.checkSemanticTokens(doc, retries - 1), SEMANTIC_RETRY_MS);
		}
		if (hasTokens !== this.hasSemanticTokens) {
			this.hasSemanticTokens = hasTokens;
			await this.loadStyles();
		}
	}

	// The text editor of the file of the side view: the active editor, or a visible editor
	private editorForSync(): vscode.TextEditor | undefined {
		const doc = this.model?.doc;
		const active = vscode.window.activeTextEditor;
		if (active && sameDoc(active.document, doc)) {
			return active;
		}
		return vscode.window.visibleTextEditors.find((e) => sameDoc(e.document, doc));
	}

	// The text editor scrolled. The side view shows the same first line.
	private fromEditor(editor: vscode.TextEditor): void {
		const now = Date.now();
		if (this.editorGuard.isEcho(now)) {
			return;
		}
		this.viewGuard.moved(now);
		this.post({ type: 'scrollTo', line: (editor.visibleRanges[0]?.start.line ?? 0) + 1 });
	}

	// The side view scrolled. The text editor shows the same first line.
	private fromView(line: number): void {
		const now = Date.now();
		const editor = this.editorForSync();
		if (this.viewGuard.isEcho(now) || !editor) {
			return;
		}
		this.editorGuard.moved(now);
		const target = Math.max(0, Math.min(line - 1 + revealPadding(editor), editor.document.lineCount - 1));
		const pos = new vscode.Position(target, 0);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
	}

	// A click in the side view moves the cursor of the text editor of the file. The focus stays in the side view. With no
	// such editor, the side view has its own cursor, and the lenses follow it as they follow the cursor of the editor.
	// isCenter: the line comes from a list, so the side view shows the line in its middle part if the line is not there
	private select(line: number, col: number, isCenter = false): void {
		this.viewSelection = undefined;
		const editor = this.editorForSync();
		const at = new vscode.Position(Math.max(0, line - 1), Math.max(0, col));
		if (!editor) {
			if (this.model) {
				this.setViewCursor(this.model.doc, at, isCenter);
			}
			return;
		}
		const pos = editor.document.validatePosition(at);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	// A selection of code in the side view. The text editor of the file gets the same selection. With no such editor,
	// the side view keeps the selection for the MCP server, and its cursor goes to the end of the selection
	private selectRange(line: number, col: number, endLine: number, endCol: number): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const range = model.doc.validateRange(new vscode.Range(Math.max(0, line - 1), Math.max(0, col), Math.max(0, endLine - 1), Math.max(0, endCol)));
		const editor = this.editorForSync();
		if (editor) {
			editor.selection = new vscode.Selection(range.start, range.end);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return;
		}
		this.viewSelection = range.isEmpty ? undefined : { doc: model.doc, range };
		this.setViewCursor(model.doc, range.end, false);
	}

	private setViewCursor(doc: vscode.TextDocument, pos: vscode.Position, isCenter: boolean): void {
		const at = doc.validatePosition(pos);
		this.viewCursor = { doc, pos: at };
		this.closeCard();
		if (isCenter) {
			this.post({ type: 'center', line: at.line + 1 });
		}
		this.post({ type: 'cursor', line: at.line + 1 });
		this.onCursor();
	}

	// The cursor of the text editor of the file. When the editor hides, the side view keeps it as its own cursor
	private keepCursor(editor: vscode.TextEditor): void {
		this.viewCursor = { doc: editor.document, pos: editor.selection.active };
	}

	// An edit adds or removes lines above the cursor of the side view, for example an edit of a model with no text editor.
	// The cursor stays on its line. An edit that replaces the line of the cursor puts the cursor at the start of the edit.
	// VS Code gives the changes from the end of the document to its start
	private shiftCursor(e: vscode.TextDocumentChangeEvent): void {
		const cursor = this.viewCursor;
		if (!cursor || !sameDoc(cursor.doc, e.document)) {
			return;
		}
		let pos = cursor.pos;
		for (const c of e.contentChanges) {
			const added = c.text.split(/\r\n|\r|\n/).length - 1;
			const removed = c.range.end.line - c.range.start.line;
			if (c.range.end.line < pos.line) {
				pos = new vscode.Position(pos.line + added - removed, pos.character);
			} else if (removed > 0 && c.range.start.line <= pos.line) {
				pos = c.range.start;
			}
		}
		if (pos.isEqual(cursor.pos)) {
			return;
		}
		this.viewCursor = { doc: cursor.doc, pos };
		if (this.cursorPlace) {
			this.post({ type: 'cursor', line: pos.line + 1 });
		}
	}

	// Flow Lens of the file of the side view. A trace of a different file shows nothing.
	// The trace of Flow Lens in the file of the side view. A variable shows only in the file of its function. A data
	// member shows in each file with an access.
	private postFlow(): void {
		const trace = this.store.state.trace;
		const model = this.model;
		this.lastTrace = trace;
		if (!trace || !model) {
			this.lastFlow = null;
		} else if (trace.member) {
			const doc = model.doc;
			this.lastFlow = buildSideMemberFlow(trace, model.file, (line) => (line >= 0 && line < doc.lineCount ? doc.lineAt(line).text : undefined));
		} else {
			this.lastFlow = trace.file === model.file ? buildSideFlow(trace, trace.pulse) : null;
		}
		this.post({ type: 'flow', flow: this.lastFlow });
	}

	// Logic Map of the file of the side view. A function of a different file shows nothing.
	private postLogic(): void {
		const { logicPath } = this.store.state;
		this.lastLogicPath = logicPath;
		this.lastLogic = logicPath && this.model && logicPath.file === this.model.file ? buildSideLogic(logicPath) : null;
		this.post({ type: 'logic', logic: this.lastLogic });
	}

	// The call graph of the file of the side view. The graph of a different file shows nothing.
	private postCalls(): void {
		const layer = this.store.state.callsLayer;
		this.lastCallsLayer = layer;
		this.lastCalls = layer && this.model && layer.file === this.model.file ? layer : null;
		this.post({ type: 'calls', calls: this.lastCalls });
	}

	// The threads of the file of the side view. The threads of a different file show nothing.
	private postThreads(): void {
		const layer = this.store.state.threadsLayer;
		this.lastThreadsLayer = layer;
		this.lastThreads = layer && this.model && layer.file === this.model.file ? layer : null;
		this.post({ type: 'threads', threads: this.lastThreads });
	}

	// The layers of the clients in the file of the side view, as one layer. An edit moves the lines of a layer at once,
	// but the side view shows the text of the last parse. So a layer that an edit moved waits for the rows of the new text
	private postModel(): void {
		const layers = this.store.state.modelLayers;
		this.lastModelLayers = layers;
		const model = this.model;
		const layer = model ? mergeModelLayers(layers.filter((l) => fileKey(l.file) === fileKey(model.file))) : null;
		const isMoved = !!layer && !!this.lastModel && fileKey(this.lastModel.file) === fileKey(layer.file);
		if (isMoved && model && model.version !== undefined && model.version >= 0 && model.version < model.doc.version) {
			this.pendingModel = layer!;
			return;
		}
		this.pendingModel = undefined;
		this.lastModel = layer;
		this.post({ type: 'model', model: this.lastModel });
	}

	// The guided review. It is the same in each file, so the side view keeps it when the file changes. While the lens Heat
	// shows, each step gets the heat of its hottest function
	private postGuide(): void {
		const { guide, guideHeat } = this.store.state;
		this.lastGuide = guide;
		this.lastGuideHeat = guideHeat;
		const heat = guide && guideHeat?.seq === guide.seq ? guideHeat.steps : undefined;
		this.lastGuideView = guide && heat ? { ...guide, steps: guide.steps.map((s, i) => (heat[i] ? { ...s, heat: heat[i] } : s)) } : guide ?? null;
		this.post({ type: 'guide', guide: this.lastGuideView });
	}

	// The guide that the side view got last, with the heat of the steps, for the tests
	get guideView(): SideGuide | null {
		return this.lastGuideView;
	}

	// Shows a step of the guided review: the guide goes to the step, and the text editor and the side view go to its lines
	async goToGuideStep(index: number): Promise<void> {
		const guide = this.store.state.guide;
		if (!guide) {
			return;
		}
		const next = withCurrent(guide, index);
		if (next !== guide) {
			this.store.update({ guide: next });
		}
		const step = next.steps[next.current];
		try {
			await this.openPlace(step.file, step.first);
		} catch {
			void vscode.window.showWarningMessage(`DataFlow cannot open ${step.name}, the file of step ${next.current + 1} of the guided review.`);
		}
	}

	// The summary of the guided review on the clipboard, for example for a comment on the pull request
	async copyGuideSummary(): Promise<void> {
		const guide = this.store.state.guide;
		if (!guide) {
			return;
		}
		await vscode.env.clipboard.writeText(guideSummary(guide));
		vscode.window.setStatusBarMessage('DataFlow: The summary of the review is on the clipboard.', 4000);
	}

	// The include hierarchy of the file of the side view. The hierarchy of a different file shows nothing.
	private postIncludes(): void {
		const layer = this.store.state.includesLayer;
		this.lastIncludesLayer = layer;
		this.lastIncludes = layer && this.model && layer.file === this.model.file ? layer : null;
		this.post({ type: 'includes', includes: this.lastIncludes });
		// new include data can come from a new text, so the result of a check is old
		if (this.lastForwardCheck) {
			this.forwardCheckRun++;
			this.postForwardCheck(null);
		}
	}

	// The button Check of the forward declarations of the include on a line: the engine parses a copy of the file in memory
	// with the declarations in the place of the include. The file does not change
	private async checkForward(line: number, text: string): Promise<void> {
		const engine = this.engine();
		const file = this.model?.file;
		if (!engine || engine.currentState !== 'ready' || !file) {
			vscode.window.setStatusBarMessage('DataFlow: Wait for the engine.', 4000);
			return;
		}
		const run = ++this.forwardCheckRun;
		this.postForwardCheck({ file, line, state: 'running' });
		try {
			const res = await engine.checkForward(file, line, text);
			if (run === this.forwardCheckRun) {
				this.postForwardCheck({ file, line, state: 'done', ms: res.ms, errorCount: res.errorCount, errors: res.errors });
			}
		} catch (error) {
			if (run === this.forwardCheckRun) {
				this.postForwardCheck({ file, line, state: 'failed', message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private postForwardCheck(check: SideForwardCheck | null): void {
		this.lastForwardCheck = check;
		this.post({ type: 'forwardCheck', check });
	}

	// Hidden C++ of the file of the side view. The items of a different file show nothing.
	private postCost(): void {
		const { costLayer } = this.store.state;
		this.lastCostLayer = costLayer;
		this.lastCost = costLayer && this.model && costLayer.file === this.model.file ? buildSideCost(costLayer) : null;
		this.post({ type: 'cost', cost: this.lastCost });
	}

	// The heat of the functions of the file of the side view, with the scan of the call graph. The heat of a different
	// file shows nothing.
	private postHeat(): void {
		const { heatLayer, callGraph } = this.store.state;
		this.lastHeatLayer = heatLayer;
		this.lastCallGraph = callGraph;
		const result = callGraph?.result;
		const graph: SideCallGraph | undefined = callGraph && {
			state: callGraph.state, done: callGraph.done, total: callGraph.total, ...(callGraph.error ? { error: callGraph.error } : {}),
			...(result ? { units: result.units, functions: result.functions, failed: result.failed.length } : {}),
			frames: result?.frames ?? [],
		};
		this.lastHeat = heatLayer && this.model && heatLayer.file === this.model.file ? {
			file: heatLayer.file, isLoading: heatLayer.isLoading, functions: heatLayer.model?.functions ?? [],
			notices: heatLayer.model?.notices ?? [], ...(heatLayer.error ? { error: heatLayer.error } : {}), ...(graph ? { graph } : {}),
		} : null;
		this.post({ type: 'heat', heat: this.lastHeat });
	}

	// Change Ripple of the file of the side view
	private postRipple(): void {
		this.lastRipple = buildSideRipple(this.store.state.rippleLayer, this.model?.file);
		this.post({ type: 'ripple', ripple: this.lastRipple });
	}

	// The story of the review. The rows of the cards and of the diff get the tokens of the engine. Without the engine,
	// the rows have the text of the file and no tokens.
	private async loadStory(): Promise<void> {
		const { review, rippleLayer } = this.store.state;
		const isNewReview = rippleLayer !== this.lastRippleLayer;
		this.lastReview = review;
		this.lastRippleLayer = rippleLayer;
		const run = ++this.storyRun;
		if (isNewReview) {
			this.storySeq++;
			this.storyRows = new Map();
			const rows = rippleLayer ? await this.loadStoryRows(rippleLayer) : new Map<string, Map<number, SideRow>>();
			if (run !== this.storyRun) {
				return;
			}
			this.storyRows = rows;
		}
		this.lastStory = buildSideStory(review, rippleLayer, (file, line) => this.storyRows.get(fileKey(file))?.get(line), this.storySeq);
		this.post({ type: 'story', story: this.lastStory });
	}

	private async loadStoryRows(layer: RippleLayerState): Promise<Map<string, Map<number, SideRow>>> {
		const out = new Map<string, Map<number, SideRow>>();
		for (const [key, { file, lines }] of storyLines(layer)) {
			const rows = new Map<number, SideRow>();
			out.set(key, rows);
			const engine = this.engine();
			try {
				if (!engine || engine.currentState !== 'ready') {
					throw new Error('The engine is not ready.');
				}
				for (const [first, last] of lineRanges(lines, 20)) {
					const res = await engine.tokens(file, first, last, this.isLevelPerType(this.model?.doc));
					toRows(res.legend, res.lines).forEach((row) => rows.set(row.line, row));
				}
			} catch {
				const text = await vscode.workspace.fs.readFile(vscode.Uri.file(file)).then((b) => Buffer.from(b).toString('utf8'), () => '');
				const fileLines = text.split(/\r?\n/);
				lines.filter((l) => l <= fileLines.length).forEach((l) => rows.set(l, { line: l, text: fileLines[l - 1], spans: [] }));
			}
		}
		return out;
	}

	// A click on a card of the story: the side view shows the file at the line, and the text editor goes to the line.
	// The focus stays in the side view.
	// The definition of a function whose declaration is at the place: the definition provider of the editor finds it, for
	// example the C/C++ extension or clangd. The side view then shows the file of the definition with its calls
	private async openDefinition(file: string, line: number, col: number): Promise<void> {
		const at = new vscode.Position(Math.max(0, line - 1), Math.max(0, col));
		let found: vscode.Location | undefined;
		try {
			let timer: NodeJS.Timeout | undefined;
			const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), DEFINITION_MS); });
			const request = vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
				'vscode.executeDefinitionProvider', vscode.Uri.file(file), at);
			const result = await Promise.race([Promise.resolve(request), limit]).finally(() => clearTimeout(timer));
			const places = (result ?? []).map((l) => ('targetUri' in l ? new vscode.Location(l.targetUri, l.targetSelectionRange ?? l.targetRange) : l));
			// the declaration itself is no answer
			found = places.find((p) => fileKey(p.uri.fsPath) !== fileKey(file) || p.range.start.line !== at.line);
		} catch {
			// a provider that fails gives no definition
		}
		if (!found) {
			void vscode.window.showInformationMessage('DataFlow found no definition of the function. The C/C++ extension or clangd can find it in a different source file.');
			return;
		}
		await this.openPlace(found.uri.fsPath, found.range.start.line + 1, found.range.start.character);
	}

	// Ctrl+click on a name, or F12 in the side view: the side view goes to the definition of the name, and the focus stays
	// in the side view. A visible text editor of the file of the definition gets its cursor there, as for a click in the
	// side view. Else only the side view moves, so the text editor stays at its place. The definition providers of VS
	// Code answer first, for example the C/C++ extension, else the engine. A click on the definition of a function shows
	// "Show Calls", as the text editor shows the references. More than one definition gives a list
	async goToDefinition(line: number, col: number, isCallable: boolean): Promise<void> {
		const model = this.model;
		if (model) {
			await this.goToDefinitionIn(model.doc, model.doc.validatePosition(new vscode.Position(Math.max(0, line - 1), Math.max(0, col))), isCallable);
		}
	}

	// A click on a member in the panel of "Outline": the side view goes to the member, as for Ctrl+click. The column is a
	// UTF-8 column from 1, as the engine gives it. toDefinition: Ctrl+click on a function with no known definition, so the
	// definition providers find it
	private async outlineGo(file: string, line: number, byteCol: number, toDefinition: boolean): Promise<void> {
		let doc: vscode.TextDocument;
		try {
			doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		} catch {
			return;
		}
		const row = Math.min(Math.max(0, line - 1), doc.lineCount - 1);
		const pos = new vscode.Position(row, toUtf16Column(doc.lineAt(row).text, byteCol));
		if (toDefinition) {
			await this.goToDefinitionIn(doc, pos, false);
		} else {
			await this.jumpTo({ file, line: pos.line, col: pos.character });
		}
	}

	private async goToDefinitionIn(doc: vscode.TextDocument, at: vscode.Position, isCallable: boolean): Promise<void> {
		const wordRange = doc.getWordRangeAtPosition(at);
		const word = wordRange ? doc.getText(wordRange) : 'the name';
		const found = await this.definitionPlaces(doc, at);
		const places = otherPlaces(found, { key: fileKey(doc.uri.fsPath), line: at.line, col: at.character });
		if (places.length === 1) {
			await this.jumpTo({ file: places[0].file, line: places[0].line, col: places[0].col });
		} else if (places.length > 1) {
			const sites = await Promise.all(places.map(async (p) => {
				const target = await vscode.workspace.openTextDocument(vscode.Uri.file(p.file));
				const text = p.line < target.lineCount ? target.lineAt(p.line).text.trim() : '';
				return { file: p.file, line: p.line + 1, col: p.col, caller: '', kind: 'other' as const, text };
			}));
			this.showCallList({ seq: Date.now(), kind: 'definitions', fn: word, sites, isSearching: false, isFromMenu: true });
		} else if (found.length > 0 && isCallable) {
			void vscode.commands.executeCommand('dataflow.showCalls', { line: at.line + 1, col: at.character });
		} else {
			vscode.window.setStatusBarMessage(found.length > 0 ? `DataFlow: This is the definition of ${word}.` : `DataFlow found no definition of ${word}.`, 4000);
		}
	}

	// F12 while the side view has the focus: the definition of the name at the cursor of the side view
	goToDefinitionAtCursor(): void {
		const pos = this.editorForSync()?.selection.active ?? this.cursorPlace?.pos;
		if (!pos) {
			vscode.window.setStatusBarMessage('DataFlow: Click a name in the side view, then push F12.', 4000);
			return;
		}
		void this.goToDefinition(pos.line + 1, pos.character, CALLABLE.includes(this.styleAt(pos) ?? -1));
	}

	// Back and Forward of the side view: the mouse buttons, and Alt+Left and Alt+Right while the side view has the focus
	async goBack(): Promise<void> {
		await this.goInHistory(true);
	}

	async goForward(): Promise<void> {
		await this.goInHistory(false);
	}

	private async goInHistory(isBack: boolean): Promise<void> {
		const current = this.sidePlace();
		const to = current && (isBack ? this.history.goBack(current) : this.history.goForward(current));
		if (!to) {
			vscode.window.setStatusBarMessage(`DataFlow: The side view has no place to go ${isBack ? 'back' : 'forward'} to.`, 3000);
			return;
		}
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(to.file));
			this.moveTo(doc, doc.validatePosition(new vscode.Position(to.line, to.col)));
		} catch {
			// the file of the place is gone
		}
	}

	// The definitions of the name at a place: from the definition providers of VS Code, else from the engine. The engine
	// knows the definitions in the translation unit, and else the declarations
	private async definitionPlaces(doc: vscode.TextDocument, at: vscode.Position): Promise<DefinitionPlace[]> {
		const out: DefinitionPlace[] = [];
		const add = (uri: vscode.Uri, range: vscode.Range) => out.push({
			file: uri.fsPath, key: fileKey(uri.fsPath), line: range.start.line, col: range.start.character, endLine: range.end.line, endCol: range.end.character,
		});
		try {
			const result = await withLimit(vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
				'vscode.executeDefinitionProvider', doc.uri, at), DEFINITION_MS);
			for (const l of result ?? []) {
				if ('targetUri' in l) {
					add(l.targetUri, l.targetSelectionRange ?? l.targetRange);
				} else {
					add(l.uri, l.range);
				}
			}
		} catch {
			// a provider that fails gives no definition
		}
		const client = this.engine();
		if (out.length > 0 || !client || client.currentState !== 'ready') {
			return out;
		}
		try {
			const result = await client.definition(doc.uri.fsPath, at.line + 1, toUtf8Column(doc.lineAt(at.line).text, at.character));
			for (const t of result.targets) {
				const target = await vscode.workspace.openTextDocument(vscode.Uri.file(t.file));
				const line = Math.min(Math.max(0, t.line - 1), target.lineCount - 1);
				const pos = new vscode.Position(line, toUtf16Column(target.lineAt(line).text, t.col));
				add(target.uri, target.getWordRangeAtPosition(pos) ?? new vscode.Range(pos, pos));
			}
		} catch {
			// the engine gives no definition, for example during a parse
		}
		return out;
	}

	// A jump of the side view: Ctrl+click, F12, a click in the list of definitions. The place that the side view leaves
	// goes into the history for Back
	private async jumpTo(place: SidePlace): Promise<void> {
		const from = this.sidePlace();
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(place.file));
		if (from) {
			this.history.push(from);
		}
		this.moveTo(doc, doc.validatePosition(new vscode.Position(place.line, place.col)));
	}

	// Moves the side view to a place. The focus stays in the side view. A visible text editor of the file gets its cursor
	// there, as for a click in the side view, and the side view follows that editor. Else only the side view moves, with
	// its own cursor
	private moveTo(doc: vscode.TextDocument, pos: vscode.Position): void {
		this.store.update({ sideMode: 'file' });
		if (!sameDoc(doc, this.model?.doc)) {
			this.showFile(doc);
		}
		const editor = this.editorForSync();
		if (!editor) {
			this.showPlace(doc, pos);
			return;
		}
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	// The place of the side view, for the history: the cursor of the text editor of its file, else the cursor of the side
	// view, else its first visible line
	private sidePlace(): SidePlace | undefined {
		const model = this.model;
		if (!model) {
			return undefined;
		}
		const pos = this.editorForSync()?.selection.active ?? this.cursorPlace?.pos ?? new vscode.Position(Math.max(0, this.viewTop - 1), 0);
		return { file: model.doc.uri.fsPath, line: pos.line, col: pos.character };
	}

	// The style index of the token at a place of the file of the side view
	private styleAt(pos: vscode.Position): number | undefined {
		const spans = this.model?.rows[pos.line]?.spans ?? [];
		for (let i = 0; i + 2 < spans.length; i += 3) {
			if (spans[i] <= pos.character && pos.character < spans[i + 1]) {
				return spans[i + 2];
			}
		}
		return undefined;
	}

	// Shows a place in the text editor beside the side view and in the side view. With no C++ text editor on the screen,
	// for example with Claude Code in the other editor group, only the side view moves, so the other group stays
	private async openPlace(file: string, line: number, col = 0): Promise<void> {
		this.store.update({ sideMode: 'file' });
		const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, col));
		if (!this.hasCodeEditor) {
			this.showPlace(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), pos);
			return;
		}
		await this.openEditor(file, pos, true);
	}

	// The button of the file name: the text editor of the file gets the focus. With no visible text editor of the file,
	// the file opens in the text editor beside the side view, at the cursor of the side view
	private async focusEditor(): Promise<void> {
		const model = this.model;
		const editor = this.editorForSync();
		if (editor) {
			await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn });
		} else if (model) {
			await this.openEditor(model.file, this.cursorPlace?.pos ?? new vscode.Position(Math.max(0, this.viewTop - 1), 0), false);
		}
	}

	// Opens the file in the text editor beside the side view at the position. preserveFocus keeps the focus in the side view
	private async openEditor(file: string, pos: vscode.Position, preserveFocus: boolean): Promise<void> {
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(file),
			{ viewColumn: this.editorColumn(), selection: new vscode.Range(pos, pos), preserveFocus });
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		if (!sameDoc(editor.document, this.model?.doc)) {
			this.showFile(editor.document);
		}
	}

	// True if each type of bracket has its own colors in the text editor. Then the level of a bracket counts only the
	// brackets of its type
	private isLevelPerType(doc: vscode.TextDocument | undefined): boolean {
		const config = vscode.workspace.getConfiguration('editor', doc ? { uri: doc.uri, languageId: doc.languageId } : undefined);
		return config.get<boolean>('bracketPairColorization.independentColorPoolPerBracketType', false);
	}

	private settings(): SideSettings {
		const doc = this.model?.doc;
		const config = vscode.workspace.getConfiguration('editor', doc ? { uri: doc.uri, languageId: doc.languageId } : undefined);
		const options = this.editorForSync()?.options;
		const positive = (value: unknown, fallback: number) => {
			const n = Number(value);
			return Number.isFinite(n) && n > 0 ? n : fallback;
		};
		const fontSize = Math.min(100, Math.max(6, config.get<number>('fontSize', 14)));
		const tabSize = positive(options?.tabSize ?? config.get('tabSize'), 4);
		return {
			rowHeight: editorLineHeight(fontSize, config.get<number>('lineHeight', 0), process.platform === 'darwin'),
			tabSize,
			indentSize: positive(options?.indentSize ?? config.get('indentSize'), tabSize),
			ligatures: fontFeatureSettings(config.get('fontLigatures')),
			letterSpacing: config.get<number>('letterSpacing', 0),
			guides: config.get<boolean>('guides.indentation', true),
			activeGuide: config.get<boolean | string>('guides.highlightActiveIndentation', true) !== false,
			bracketColors: config.get<boolean>('bracketPairColorization.enabled', true),
			// the key for "go to definition" does not conflict with the key for more cursors, as in the text editor
			gotoKey: config.get<string>('multiCursorModifier', 'alt') === 'ctrlCmd' ? 'alt' : process.platform === 'darwin' ? 'meta' : 'ctrl',
		};
	}

	private frame(): SideFrame {
		const state = this.store.state;
		const model = this.model;
		return {
			file: model?.file,
			fn: model && state.file === model.file && state.fn ? functionTitle(state.fn, true) : undefined,
			engine: state.engine,
			parsing: !!model && state.parsing.includes(model.file),
			parseMs: model?.parse?.parseMs,
			errorCount: model?.parse?.errorCount,
			errors: model?.parse?.errors.slice(0, 5),
			databases: state.databases.map((db) => db.makefile ?? db.path),
			project: state.project?.name,
			message: model?.error ?? state.message ?? this.stylesError,
			lenses: state.lenses,
			lastLens: state.lastLens,
			fnRange: model && state.file === model.file && state.fn ? [state.fn.range.begin.line, state.fn.range.end.line] : undefined,
			isModelShown: state.isModelShown,
			animate: animationsOn(),
			mode: state.sideMode,
			mcp: state.mcp,
		};
	}

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'side.js'));
		// The webview makes its styles with constructable stylesheets, so the policy allows no inline styles.
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
