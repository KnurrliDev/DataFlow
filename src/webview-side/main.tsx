import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
	FromSide, SideCallList, SideCalls, SideCommand, SideCost, SideDetailsTab, SideExtensionTab, SideFlow, SideForwardCheck, SideFrame, SideGuide, SideHeat, SideIncluders, SideIncludes,
	SideLens, SideLogic, SideModel, SideOutline, SideRipple, SideRow, SideSettings, SideStory, SideThreads, SideWhy, ToSide,
} from '../side/protocol';
import { CallListPanel } from './calllist';
import { OutlinePanel } from './outline';
import { CallDetails, CallGraph, CallView } from './calls';
import { CodeView } from './CodeView';
import { CostDetails, CostGroup } from './cost';
import { FlowDetails, VariableChips } from './flow';
import { GuideBar, GuideDetails, sameFileName, walkMarks } from './guide';
import { HeatDetails } from './heat';
import { IncludeDetails } from './includes';
import { BAR_WARNINGS, LogicDetails, LogicGroup, PLAY_STEP_MS, PlayProps } from './logic';
import { ModelBar, ModelDetails } from './model';
import { RippleBar, StoryView } from './ripple';
import { setBracketColors, setTokenStyles } from './styles';
import { ExtensionTabDetails } from './tab';
import { selectedItem, ThreadDetails } from './threads';
import { vscode } from './vscode';

// The script of the side view. It shows the model that the extension sends and sends the user actions back.
// docs/side-view-strategy.md describes the side view. Phase S2 added Flow Lens, phase S3 added Logic Map, phase S4
// added Hidden C++ and phase S5 added the story of Change Ripple.

interface ViewState {
	file?: string;
	lineCount: number;
	rows: (SideRow | undefined)[]; // the row of line n is rows[n - 1]
	inactive?: [number, number][]; // the ranges of lines that a condition of the preprocessor skips
	maxColumns: number;
	settings: SideSettings;
	frame?: SideFrame;
	cursor?: number;
	cardAt?: { line: number; col: number; seq: number }; // the position of the command "Show Card at Cursor"
	scrollTo?: { line: number; seq: number };
	center?: { line: number; seq: number }; // a line that the view shows in its middle part, if the line is not there
	flow: SideFlow | null;
	logic: SideLogic | null;
	cost: SideCost | null;
	includes: SideIncludes | null;
	includeSel?: number; // the selected node of Include Hierarchy
	includers?: SideIncluders; // the source files of the compile databases that include a file
	forwardCheck?: SideForwardCheck; // the result of the button Check of the forward declarations of an include
	calls: SideCalls | null;
	threads: SideThreads | null;
	threadSel?: string; // the selected item of Threads and races
	heat: SideHeat | null;
	callView: CallView; // the function in the center of Call Hierarchy, the levels and the library calls
	isCallGraphOpen: boolean;
	ripple: SideRipple | null;
	story: SideStory | null;
	model: SideModel | null; // the blocks and the notes of a language model in the file
	modelSel?: string; // the selected block of the model
	guide: SideGuide | null; // the guide: a guided review of a model, or a diff walk
	tabs: SideExtensionTab[]; // the tabs of the extensions in the details column
	why?: SideWhy;
	traceable: Set<number>;
	callable: Set<number>; // the style indices of functions and methods: their menu has "Show Calls"
	navigable: Set<number>; // the style indices of names: Ctrl+click goes to their definition
	includeFile: number; // the style index of a string: on an #include line, the file of the include
	callList: SideCallList | null; // the list of "Show Calls"
	outline: SideOutline | null; // the panel of "Outline"
	typeNames: Set<number>; // the style indices of classes, enums and type aliases: their menu has "Outline"
	isDetailsOpen: boolean;
	detailsLens: SideDetailsTab;
}

// The lenses with a details column, in the sequence of the tabs
const DETAIL_LENSES: SideLens[] = ['flow', 'logic', 'cost', 'includes', 'calls', 'threads', 'heat'];
const LENS_NAMES: Record<Exclude<SideDetailsTab, `ext:${string}`>, string> = {
	flow: 'Flow Lens', logic: 'Logic Map', cost: 'Hidden C++', review: 'Change Ripple', includes: 'Includes', calls: 'Calls', threads: 'Threads',
	heat: 'Heat', model: 'Model', guide: 'Guide',
};

// The model has blocks or notes in the file
const hasModelLayers = (model: SideModel | null) => !!model
	&& (model.blocks.length > 0 || model.notes.length > 0 || model.comments.length > 0 || model.details.length > 0);

const DEFAULT_SETTINGS: SideSettings = {
	rowHeight: 19, tabSize: 4, indentSize: 4, ligatures: '"liga" off, "calt" off', letterSpacing: 0, guides: true, activeGuide: true,
	bracketColors: true, gotoKey: 'ctrl',
};

const post = (message: FromSide) => vscode.postMessage(message);
let cardSeq = 0; // the number of the last message showCard

// The number of columns of the longest line, with the tabs expanded
function maxColumnsOf(rows: (SideRow | undefined)[], tabSize: number): number {
	let max = 0;
	for (const row of rows) {
		if (!row || row.text.length <= max) {
			continue;
		}
		let columns = 0;
		for (const c of row.text) {
			columns = c === '\t' ? columns + tabSize - (columns % tabSize) : columns + 1;
		}
		max = Math.max(max, columns);
	}
	return max;
}

function basename(file: string): string {
	return file.split(/[\\/]/).pop() ?? file;
}

// A side view narrower than 640 px is compact. Its details column is closed at the start, and it shows over the code.
const COMPACT = window.matchMedia('(max-width: 640px)');

function useCompact(): boolean {
	const [isCompact, setCompact] = useState(COMPACT.matches);
	useEffect(() => {
		const onChange = () => setCompact(COMPACT.matches);
		COMPACT.addEventListener('change', onChange);
		return () => COMPACT.removeEventListener('change', onChange);
	}, []);
	return isCompact;
}

function Toolbar({ state, isStory, isDetailsShown, onDetails }: { state: ViewState; isStory: boolean; isDetailsShown: boolean; onDetails: () => void }) {
	const file = state.file ?? state.frame?.file;
	const fn = state.frame?.fn;
	const lenses = state.frame?.lenses;
	const lensButton = (lens: SideLens, dot: string, title?: string) => (
		<button type="button" class="lens" aria-pressed={!!lenses?.[lens]} title={title} onClick={() => post({ type: 'toggleLens', lens })}>
			<span class={`lens-dot ${dot}`} />{LENS_NAMES[lens]}
		</button>
	);
	return (
		<header class="toolbar">
			{isStory ? <span class="file">Review of the changes</span>
				: file ? (
					<button type="button" class="file" title={`${file}\nOpen the file in the text editor at the cursor of the side view.`}
						onClick={() => post({ type: 'openEditor' })}>
						{basename(file)}
					</button>
				) : <span>No C++ file</span>}
			{!isStory && fn && <span class="sep">›</span>}
			{!isStory && fn && <span class="fn" title={fn}>{fn}</span>}
			<span class="grow" />
			{/* the switch of the layers of a model comes first, so it shows also when a narrow toolbar cuts the last lens buttons */}
			{!isStory && hasModelLayers(state.model) && (
				<button type="button" class="lens" aria-pressed={state.frame?.isModelShown !== false}
					title="Show or hide the layers of the model in the code: the blocks, the notes, the comments and the details"
					onClick={() => post({ type: 'command', command: 'dataflow.toggleModelLayers' })}>
					<span class="lens-dot c-model" />Model
				</button>
			)}
			<div class="lenses" role="group" aria-label="Lenses">
				{lensButton('flow', 'c-definition', 'Put the cursor on a variable or a data member, or click it, to trace it.')}
				{lensButton('logic', 'c-path')}
				{lensButton('cost', 'c-write')}
				{lensButton('includes', 'c-read')}
				{lensButton('calls', 'c-check')}
				{lensButton('threads', 'c-ripple')}
				{lensButton('heat', 'c-heat', 'The heat of each function: how much a change of the function can break.')}
				{lensButton('review', 'c-ripple ring', 'Review the changes of the branch: the code that the changes can affect, as a story.')}
			</div>
			{!isStory && (DETAIL_LENSES.some((lens) => lenses?.[lens]) || hasModelLayers(state.model) || !!state.guide) && (
				<button type="button" class="lens" aria-pressed={isDetailsShown} onClick={onDetails} title="Show or hide the details column">
					Details
				</button>
			)}
		</header>
	);
}

const NO_CFG = 'No rails: Clang made no control flow graph for this function.';

// The controls of Flow Lens in the bar of the lenses during a trace: the variables of the function, the problems and
// Clear. A line with more accesses that have the same problem shows the problem one time. Flow Lens always traces the
// variable at the cursor.
function FlowGroup({ flow }: { flow: SideFlow }) {
	const problems = flow.findings.filter((f, i) => flow.findings.findIndex((g) => g.line === f.line && g.text === f.text) === i);
	const more = problems.slice(BAR_WARNINGS);
	return (
		<span class="lensgroup" role="group" aria-label="Flow Lens">
			<span class="lens-dot c-definition" title="Flow Lens" />
			{flow.member && (flow.member.className || flow.member.qualifiedClass) && (
				<span class="sub mono">{flow.member.className || flow.member.qualifiedClass}::</span>
			)}
			<VariableChips flow={flow} />
			{problems.slice(0, BAR_WARNINGS).map((f) => (
				<button type="button" class="link finding" onClick={() => post({ type: 'revealLine', line: f.line })}>
					Line {f.line}: {f.text}
				</button>
			))}
			{more.length > 0 && (
				<span class="problem" title={more.map((f) => `Line ${f.line}: ${f.text}`).join('\n')}>
					{more.length === 1 ? '1 more problem' : `${more.length} more problems`}
				</span>
			)}
			{!flow.hasCfg && <span class="sub notice">{NO_CFG}</span>}
			<button type="button" class="lens" onClick={() => post({ type: 'clearTrace' })}>Clear</button>
		</span>
	);
}

const PROJECT_TITLE = 'A project that is not open in VS Code. DataFlow uses its compile database and opens only its files, '
	+ 'so the extensions that start for a folder do not configure or build it.';

// With no file: the button that opens a file of the project, or that selects a project
function EmptyView({ frame }: { frame?: SideFrame }) {
	const project = frame?.project;
	return (
		<div class="empty">
			<p>Open a C++ file. The side view shows the file of the active editor.</p>
			<button type="button" class="link" title={PROJECT_TITLE}
				onClick={() => post({ type: 'command', command: project ? 'dataflow.openProjectFile' : 'dataflow.openProject' })}>
				{project ? `Open a file of ${project}` : 'Open a project that is not open in VS Code'}
			</button>
		</div>
	);
}

function StatusLine({ frame }: { frame?: SideFrame }) {
	const command = (c: SideCommand) => () => post({ type: 'command', command: c });
	if (!frame) {
		return <footer class="status" />;
	}
	const databases = frame.databases.length === 0 ? 'No compile database'
		: frame.databases.length === 1 ? '1 compile database' : `${frame.databases.length} compile databases`;
	return (
		<footer class="status">
			<span>Engine: {frame.engine}</span>
			{frame.parsing && <span>Parsing</span>}
			{frame.parseMs !== undefined && <span>Parse: {Math.round(frame.parseMs)} ms</span>}
			{!!frame.errorCount && (
				<span class="error" title={frame.errors?.join('\n')}>
					{frame.errorCount === 1 ? '1 error' : `${frame.errorCount} errors`}
				</span>
			)}
			<span title={frame.databases.join('\n')}>{databases}</span>
			{frame.mcp.state === 'on' && (
				<span title={`The MCP server of DataFlow runs on ${frame.mcp.url}`}>MCP{frame.mcp.client ? `: ${frame.mcp.client}` : ': on'}</span>
			)}
			{frame.mcp.state === 'failed' && <span class="error" title={frame.mcp.error}>MCP: failed</span>}
			<span class={frame.message ? 'grow error' : 'grow'} title={frame.message}>{frame.message ?? ''}</span>
			<button type="button" onClick={command('dataflow.openProject')} title={PROJECT_TITLE}>
				{frame.project ? `Project: ${frame.project}` : 'Project'}
			</button>
			<button type="button" onClick={command('dataflow.selectCompileCommands')}>Compile database</button>
			<button type="button" onClick={command('dataflow.showLog')}>Log</button>
			<button type="button" onClick={command('dataflow.restartEngine')}>Restart</button>
		</footer>
	);
}

function App() {
	const saved = vscode.getState();
	const [state, setState] = useState<ViewState>({
		lineCount: 0, rows: [], maxColumns: 0, settings: DEFAULT_SETTINGS, flow: null, logic: null, cost: null, includes: null, ripple: null,
		story: null, calls: null, threads: null, heat: null, model: null, guide: null, tabs: [], callView: { focus: -1, depth: 1, showLibrary: false }, isCallGraphOpen: false,
		traceable: new Set(), callable: new Set(), navigable: new Set(), includeFile: -1, callList: null, outline: null, typeNames: new Set(),
		isDetailsOpen: saved?.isDetailsOpen ?? true, detailsLens: saved?.detailsLens ?? 'flow',
	});
	// the place of the last click of a menu in the code, for the list of "Show Calls"
	const menuPoint = useRef<{ x: number; y: number } | undefined>(undefined);
	// the time of the message that changed the rows, until the code view renders them
	const changedAt = useRef<number | undefined>(undefined);
	// the details column in the compact mode. It is not in the saved state, so it is closed after a restore
	const isCompact = useCompact();
	const isCompactRef = useRef(isCompact);
	isCompactRef.current = isCompact;
	const [isOverlayOpen, setOverlayOpen] = useState(false);

	const showDetails = (lens: SideDetailsTab) => {
		vscode.setState({ ...vscode.getState(), detailsLens: lens });
		setState((s) => ({ ...s, detailsLens: lens }));
	};
	// shows the tab of the lens, and opens the details column
	const openDetails = (lens: SideDetailsTab) => {
		showDetails(lens);
		if (isCompactRef.current) {
			setOverlayOpen(true);
		} else {
			vscode.setState({ ...vscode.getState(), isDetailsOpen: true });
			setState((s) => ({ ...s, isDetailsOpen: true }));
		}
	};

	useEffect(() => {
		const onMessage = (event: MessageEvent<ToSide>) => {
			const message = event.data;
			switch (message.type) {
				case 'file':
					changedAt.current = performance.now();
					vscode.setState({ ...vscode.getState(), file: message.file });
					setState((s) => ({
						...s, file: message.file, lineCount: message.lineCount, rows: message.rows.slice(),
						maxColumns: maxColumnsOf(message.rows, s.settings.tabSize), inactive: s.file === message.file ? s.inactive : [],
					}));
					break;
				case 'inactive':
					changedAt.current = performance.now();
					setState((s) => (s.file === message.file ? { ...s, inactive: message.ranges } : s));
					break;
				case 'rows':
					changedAt.current = performance.now();
					setState((s) => {
						const rows = s.rows.slice(0, message.lineCount);
						for (let i = rows.length; i < message.lineCount; i++) {
							rows.push(undefined);
						}
						for (const row of message.rows) {
							rows[row.line - 1] = row;
						}
						return { ...s, lineCount: message.lineCount, rows, maxColumns: maxColumnsOf(rows, s.settings.tabSize) };
					});
					break;
				case 'styles':
					setTokenStyles(message.styles, message.brackets);
					setState((s) => ({
						...s, traceable: new Set(message.traceable), callable: new Set(message.callable), navigable: new Set(message.navigable),
						includeFile: message.includeFile, typeNames: new Set(message.typeNames),
					}));
					break;
				case 'callList':
					setState((s) => ({ ...s, callList: message.list }));
					break;
				case 'outline':
					setState((s) => ({ ...s, outline: message.outline }));
					break;
				case 'settings':
					setBracketColors(message.settings.bracketColors);
					setState((s) => ({ ...s, settings: message.settings, maxColumns: maxColumnsOf(s.rows, message.settings.tabSize) }));
					break;
				case 'scrollTo':
					// the text editor scrolls the view again, so an old line of the cursor of the side view does not go to the middle
					// part when the code view starts again, for example after the story of a review
					setState((s) => ({ ...s, scrollTo: { line: message.line, seq: (s.scrollTo?.seq ?? 0) + 1 }, center: undefined }));
					break;
				case 'cursor':
					setState((s) => ({ ...s, cursor: message.line }));
					break;
				case 'center':
					setState((s) => ({ ...s, center: { line: message.line, seq: (s.center?.seq ?? 0) + 1 } }));
					break;
				case 'showCard':
					cardSeq += 1;
					setState((s) => ({ ...s, cardAt: { line: message.line, col: message.col, seq: cardSeq } }));
					break;
				case 'hideCard':
					setState((s) => ({ ...s, cardAt: undefined }));
					break;
				case 'frame':
					setState((s) => ({ ...s, frame: message.frame }));
					break;
				case 'flow':
					setState((s) => ({ ...s, flow: message.flow }));
					break;
				case 'logic':
					setState((s) => ({ ...s, logic: message.logic }));
					break;
				case 'cost':
					setState((s) => ({ ...s, cost: message.cost }));
					break;
				case 'heat':
					setState((s) => ({ ...s, heat: message.heat }));
					break;
				case 'calls':
					// the function in the center follows the cursor. A function that the user put in the center stays while the
					// cursor stays in the same function
					setState((s) => {
						const next = message.calls;
						const isSame = !!next && next.file === s.calls?.file && next.focus === s.calls?.focus;
						return { ...s, calls: next, callView: { ...s.callView, focus: isSame ? s.callView.focus : next?.focus ?? -1 } };
					});
					break;
				case 'threads':
					// the selected item stays while the analysis has it
					setState((s) => ({ ...s, threads: message.threads }));
					break;
				case 'includes':
					// the selection stays while the file stays
					setState((s) => ({
						...s, includes: message.includes, includeSel: message.includes?.file === s.includes?.file ? s.includeSel : undefined,
					}));
					break;
				case 'includers':
					setState((s) => ({ ...s, includers: message.includers ?? undefined }));
					break;
				case 'forwardCheck':
					setState((s) => ({ ...s, forwardCheck: message.check ?? undefined }));
					break;
				case 'ripple':
					setState((s) => ({ ...s, ripple: message.ripple }));
					break;
				case 'story':
					setState((s) => ({ ...s, story: message.story }));
					break;
				case 'why':
					setState((s) => ({ ...s, why: message.why }));
					break;
				case 'model':
					// the selected block stays while the model has it
					setState((s) => ({ ...s, model: message.model, modelSel: message.model?.blocks.some((b) => b.id === s.modelSel) ? s.modelSel : undefined }));
					break;
				case 'guide':
					setState((s) => ({ ...s, guide: message.guide }));
					break;
				case 'tabs':
					setState((s) => ({ ...s, tabs: message.tabs }));
					break;
				case 'details':
					// for example the command "Why Does This Line Run"
					openDetails(message.lens);
					break;
			}
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	const onRendered = (rows: number) => {
		if (changedAt.current !== undefined && rows > 0) {
			const inactiveRows = document.querySelectorAll('.row.inactive').length;
			post({ type: 'rendered', ms: performance.now() - changedAt.current, rows, inactiveRows });
			changedAt.current = undefined;
		}
	};
	const onScroll = (line: number) => {
		vscode.setState({ ...vscode.getState(), file: state.file, line });
		post({ type: 'scroll', line });
	};
	const toggleDetails = () => {
		if (isCompact) {
			setOverlayOpen((isOpen) => !isOpen);
			return;
		}
		vscode.setState({ ...vscode.getState(), isDetailsOpen: !state.isDetailsOpen });
		setState((s) => ({ ...s, isDetailsOpen: !s.isDetailsOpen }));
	};
	// Escape closes the details column over the code
	useEffect(() => {
		if (!isCompact || !isOverlayOpen) {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setOverlayOpen(false);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [isCompact, isOverlayOpen]);

	const isFlowOn = !!state.frame?.lenses.flow;
	const isLogicOn = !!state.frame?.lenses.logic;
	const isCostOn = !!state.frame?.lenses.cost;
	const isIncludesOn = !!state.frame?.lenses.includes;
	const isCallsOn = !!state.frame?.lenses.calls;
	const isThreadsOn = !!state.frame?.lenses.threads;
	const isHeatOn = !!state.frame?.lenses.heat;
	const isReviewOn = !!state.frame?.lenses.review;
	// the side view shows the story of the review, or the file of the editor
	const isStory = isReviewOn && state.frame?.mode === 'story';
	const animate = !!state.frame?.animate;
	// the layer of a lens shows only when the lens is on
	const flow = isFlowOn ? state.flow : null;
	const logic = isLogicOn ? state.logic : null;
	const cost = isCostOn ? state.cost : null;
	const includes = isIncludesOn ? state.includes : null;
	const calls = isCallsOn ? state.calls : null;
	const threads = isThreadsOn ? state.threads : null;
	const heat = isHeatOn ? state.heat : null;
	const threadItem = selectedItem(threads, state.threadSel);
	// the text of a line of the file of the side view, for the lanes of Threads and races
	const lineTextOf = (file: string, line: number) => (sameFileName(file, state.file) ? state.rows[line - 1]?.text : undefined);
	// puts a function in the center of Call Hierarchy. The extension asks VS Code for its callers in other files
	const focusCall = (fn: number) => {
		setState((s) => ({ ...s, callView: { ...s.callView, focus: fn } }));
		post({ type: 'callFocus', fn });
	};
	const setCallView = (view: CallView) => setState((s) => ({ ...s, callView: view }));
	const ripple = isReviewOn ? state.ripple : null;
	// the switch Model of the toolbar hides the layers of the model in the code view and the bar MODEL. The tab Model of
	// the details column stays
	const shownModel = state.frame?.isModelShown === false ? null : state.model;
	const isDetailsShown = !isStory && (isCompact ? isOverlayOpen : state.isDetailsOpen);

	// the change of the story. A new review shows its first change
	const [storyIndex, setStoryIndex] = useState(0);
	useEffect(() => setStoryIndex(0), [state.story?.seq]);
	const storyChange = Math.min(storyIndex, Math.max(0, (state.story?.changes.length ?? 1) - 1));

	// When a lens turns on, the details column shows its tab. At the start, the column shows the saved tab, or the tab of
	// the lens that turned on last, for example the lens that opened the side view.
	const lensesBefore = useRef<Record<'flow' | 'logic' | 'cost' | 'includes' | 'calls' | 'threads' | 'heat', boolean> | undefined>(undefined);
	const hasFrame = !!state.frame;
	useEffect(() => {
		if (!hasFrame) {
			return;
		}
		const before = lensesBefore.current;
		const now = { flow: isFlowOn, logic: isLogicOn, cost: isCostOn, includes: isIncludesOn, calls: isCallsOn, threads: isThreadsOn, heat: isHeatOn };
		lensesBefore.current = now;
		const last = state.frame?.lastLens;
		if (!before) {
			if (!saved?.detailsLens && last && DETAIL_LENSES.includes(last) && state.frame?.lenses[last]) {
				showDetails(last);
			}
			return;
		}
		const turnedOn = (['heat', 'threads', 'calls', 'includes', 'cost', 'logic', 'flow'] as const).find((lens) => now[lens] && !before[lens]);
		if (turnedOn) {
			showDetails(turnedOn);
		}
	}, [hasFrame, isFlowOn, isLogicOn, isCostOn, isIncludesOn, isCallsOn, isThreadsOn, isHeatOn]);
	// the tabs of the extensions come after the tabs of DataFlow
	const detailLenses: SideDetailsTab[] = [
		...DETAIL_LENSES.filter((lens) => state.frame?.lenses[lens]),
		...(hasModelLayers(state.model) ? ['model' as const] : []),
		...(state.guide ? ['guide' as const] : []),
		...state.tabs.map((t) => `ext:${t.client}` as const),
	];
	const tabOf = (lens: SideDetailsTab) => state.tabs.find((t) => `ext:${t.client}` === lens);
	const tabName = (lens: SideDetailsTab) => (lens.startsWith('ext:') ? tabOf(lens)?.title ?? lens : LENS_NAMES[lens as keyof typeof LENS_NAMES]);
	// the lines of the current step of the guide, if the step is in the file of the side view
	const guideStep = state.guide?.steps[state.guide.current];
	const guideLines = guideStep && sameFileName(guideStep.file, state.file)
		? {
			first: guideStep.first, last: guideStep.last, label: `${state.guide!.current + 1}/${state.guide!.steps.length} ${guideStep.title}`,
			isWalk: state.guide!.kind === 'diff',
		}
		: undefined;
	// the added and the removed lines of a diff walk in the file of the side view
	const diffMarks = useMemo(() => walkMarks(state.guide, state.file, state.lineCount), [state.guide, state.file, state.lineCount]);
	const detailsLens = detailLenses.includes(state.detailsLens) ? state.detailsLens : detailLenses[0];

	// The tab Calls or the graph shows the callers. Only then the extension asks the call hierarchy of VS Code for the
	// callers in other files, because a request can stop the language server of the C/C++ extension
	const isCallsShown = !!calls && ((isDetailsShown && detailsLens === 'calls') || !!state.isCallGraphOpen);
	useEffect(() => {
		post({ type: 'callsShown', isShown: isCallsShown });
	}, [isCallsShown]);

	// "Play path" of Logic Map: the current step, one step after the other. A new path stops it. The code view marks the
	// line of the current step, or of the step under the mouse, and it scrolls to the line of each step of the play.
	const [playStep, setPlayStep] = useState<number | undefined>(undefined);
	const [hoverLine, setHoverLine] = useState<number | undefined>(undefined);
	const steps = logic?.steps ?? [];
	const pathKey = steps.map((s) => `${s.kind}:${s.line}:${s.value ?? ''}`).join('|');
	useEffect(() => setPlayStep(undefined), [pathKey, logic?.fn]);
	useEffect(() => {
		if (playStep === undefined) {
			return;
		}
		const isLast = playStep + 1 >= steps.length;
		const timer = window.setTimeout(() => setPlayStep(isLast ? undefined : playStep + 1), isLast ? 2 * PLAY_STEP_MS : PLAY_STEP_MS);
		return () => clearTimeout(timer);
	}, [playStep, steps.length]);
	const play: PlayProps = {
		animate,
		isPlaying: playStep !== undefined,
		onPlay: () => setPlayStep((step) => (step === undefined && steps.length > 0 ? 0 : undefined)),
	};
	const stepLine = playStep !== undefined ? steps[playStep]?.line : hoverLine;

	return (
		<div class={state.frame?.animate === false ? 'app no-motion' : 'app'}>
			<Toolbar state={state} isStory={isStory} isDetailsShown={isDetailsShown} onDetails={toggleDetails} />
			{state.guide && <GuideBar guide={state.guide} onOpen={() => openDetails('guide')} />}
			{!isStory && (flow || isLogicOn || cost) && (
				<div class="lensbar lens-groups">
					{flow && <FlowGroup flow={flow} />}
					{isLogicOn && <LogicGroup logic={logic} play={play} />}
					{cost && <CostGroup cost={cost} />}
				</div>
			)}
			{!isStory && shownModel && hasModelLayers(shownModel) && (
				<ModelBar model={shownModel} cursor={state.cursor} fn={state.frame?.fn} fnRange={state.frame?.fnRange} onOpen={() => openDetails('model')} />
			)}
			{isReviewOn && <RippleBar story={state.story} isStory={isStory} index={storyChange} onIndex={setStoryIndex} />}
			{!isStory && calls && state.isCallGraphOpen && (
				<CallGraph calls={calls} view={state.callView} onView={setCallView} onFocus={focusCall}
					onClose={() => setState((s) => ({ ...s, isCallGraphOpen: false }))} />
			)}
			<div class="main">
				{isStory ? (
					<StoryView story={state.story} index={storyChange} settings={state.settings} animate={animate} />
				) : state.file ? (
					<CodeView
						file={state.file}
						rows={state.rows}
						inactive={state.inactive}
						lineCount={state.lineCount}
						maxColumns={state.maxColumns}
						settings={state.settings}
						cursor={state.cursor}
						cardAt={state.cardAt}
						scrollTo={state.scrollTo}
						center={state.center}
						flow={flow}
						logic={logic}
						cost={cost}
						includes={includes}
						calls={calls}
						threads={threads}
						threadItem={threadItem}
						heat={heat}
						ripple={ripple}
						model={shownModel}
						guideLines={guideLines}
						diff={diffMarks}
						why={state.why}
						stepLine={stepLine}
						reveal={playStep !== undefined && steps[playStep] ? { line: steps[playStep].line, seq: playStep } : undefined}
						isFlowOn={isFlowOn}
						animate={animate}
						traceable={state.traceable}
						callable={state.callable}
						typeNames={state.typeNames}
						navigable={state.navigable}
						includeFile={state.includeFile}
						onContextPoint={(x, y) => {
							menuPoint.current = { x, y };
						}}
						onGoToDefinition={(line, col, isCallable) => post({ type: 'goToDefinition', line, col, isCallable })}
						onHistory={(isBack) => post({ type: isBack ? 'goBack' : 'goForward' })}
						onScroll={onScroll}
						onSelect={(line, col) => post({ type: 'select', line, col })}
						onSelectRange={(range) => post({ type: 'selectRange', ...range })}
						onTrace={(line, col) => post({ type: 'trace', line, col })}
						onIncludeHint={(node) => {
							setState((s) => ({ ...s, includeSel: node }));
							openDetails('includes');
						}}
						onCallHint={(fn) => {
							focusCall(fn);
							openDetails('calls');
						}}
						onThreadHint={() => openDetails('threads')}
						onHeatHint={() => openDetails('heat')}
						onModelTag={(block) => {
							if (block) {
								setState((s) => ({ ...s, modelSel: block }));
							}
							openDetails('model');
						}}
						onRendered={onRendered}
					/>
				) : (
					<EmptyView frame={state.frame} />
				)}
				{state.callList && (
					<CallListPanel list={state.callList} point={state.callList.isFromMenu ? menuPoint.current : undefined}
						onClose={() => setState((s) => ({ ...s, callList: null }))} />
				)}
				{state.outline && (
					<OutlinePanel outline={state.outline} point={state.outline.isFromMenu ? menuPoint.current : undefined} gotoKey={state.settings.gotoKey}
						onClose={() => setState((s) => ({ ...s, outline: null }))} />
				)}
				{detailsLens && isDetailsShown && (
					<aside class={isCompact ? 'details overlay' : 'details'} aria-label={`Details of ${tabName(detailsLens)}`}>
						{detailLenses.length > 1 && (
							<div class="tabs" role="tablist" aria-label="Lenses">
								{detailLenses.map((lens) => (
									<button type="button" class={lens.startsWith('ext:') ? 'tab ext' : 'tab'} role="tab" aria-selected={lens === detailsLens}
										title={lens.startsWith('ext:') ? `The tab of the extension ${tabOf(lens)?.client ?? ''}` : undefined} onClick={() => showDetails(lens)}>
										{tabName(lens)}
									</button>
								))}
							</div>
						)}
						{detailsLens === 'logic' && <LogicDetails logic={logic} play={play} current={playStep} onHover={setHoverLine} />}
						{detailsLens === 'cost' && <CostDetails cost={cost} />}
						{detailsLens === 'calls' && (
							<CallDetails calls={calls} view={state.callView} isGraphOpen={state.isCallGraphOpen} onView={setCallView} onFocus={focusCall}
								onGraph={() => setState((s) => ({ ...s, isCallGraphOpen: !s.isCallGraphOpen }))} />
						)}
						{detailsLens === 'includes' && (
							<IncludeDetails includes={includes} includers={state.includers} forwardCheck={state.forwardCheck} selected={state.includeSel}
								onSelect={(node) => setState((s) => ({ ...s, includeSel: node }))} />
						)}
						{detailsLens === 'flow' && <FlowDetails flow={flow} />}
						{detailsLens === 'threads' && (
							<ThreadDetails threads={threads} selected={threadItem?.key} text={lineTextOf} onSelect={(key) => setState((s) => ({ ...s, threadSel: key }))} />
						)}
						{detailsLens === 'guide' && <GuideDetails guide={state.guide} file={state.file} rows={state.rows} settings={state.settings} />}
						{detailsLens === 'heat' && <HeatDetails heat={heat} cursor={state.cursor} />}
						{detailsLens.startsWith('ext:') && tabOf(detailsLens) && <ExtensionTabDetails tab={tabOf(detailsLens)!} />}
						{detailsLens === 'model' && (
							<ModelDetails model={state.model} isShown={!!shownModel} fn={state.frame?.fn} fnRange={state.frame?.fnRange} mcp={state.frame?.mcp}
								selected={state.modelSel}
								onSelect={(id) => setState((s) => ({ ...s, modelSel: id }))} />
						)}
					</aside>
				)}
			</div>
			<StatusLine frame={state.frame} />
		</div>
	);
}

render(<App />, document.getElementById('root')!);
