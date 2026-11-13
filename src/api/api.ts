import * as vscode from 'vscode';
import type * as Api from '../../api/dataflow-api';
import type { EngineFunction } from '../engine/client';
import { fileKey } from '../lenses/member';
import { callGraphFacts, DataFlowMcpHost, type HostDeps } from '../mcp/host';
import { createTools } from '../mcp/tools';
import { guideFacts } from '../review/guide';
import type { SideGuide } from '../side/protocol';
import type { CallGraphView, DataFlowState, StateStore } from '../state/store';

// The API of DataFlow for other extensions. The exports of the extension give getApi. Each API object has its own host
// of the MCP tools with the name of its client, so the blocks, the notes and the guides of an extension show its name.
// The methods run the tools, and their results are the parsed JSON of the tools. api/dataflow-api.d.ts has the types.

export const API_VERSION = 1;
const DEFAULT_CLIENT = 'extension';

export interface ApiDeps {
	store: StateStore;
	hostDeps: HostDeps; // the dependencies of the host of the MCP server. Each API object sets its own client
	currentPlace(): { doc: vscode.TextDocument; pos: vscode.Position } | undefined;
	log(message: string): void;
}

// The reason of a state of the engine with no work, as the status bar tells it. Before the first search of the compile
// databases, the state stopped has no reason
export function engineError(state: DataFlowState): string | undefined {
	if (state.engine === 'failed') {
		return state.message ?? 'The engine stopped. See the DataFlow log.';
	}
	if (state.engine === 'stopped' && state.isDatabaseSearchDone && state.databases.length === 0) {
		return 'No compile database. Run "DataFlow: Select Compile Database", or set dataflow.compileCommands.';
	}
	return undefined;
}

const engineEvent = (state: DataFlowState): Api.EngineStateEvent => {
	const error = engineError(state);
	return { state: state.engine, compileDatabases: state.databases.map((d) => d.makefile ?? d.path), ...(error ? { error } : {}) };
};

// The events of the API. All API objects share them. They come from the changes of the state of DataFlow
export class ApiEvents implements vscode.Disposable {
	private readonly engine = new vscode.EventEmitter<Api.EngineStateEvent>();
	private readonly view = new vscode.EventEmitter<Api.ViewEvent>();
	private readonly guide = new vscode.EventEmitter<Api.GuideFacts | null>();
	private readonly callGraph = new vscode.EventEmitter<Api.CallGraphFacts>();
	readonly onDidChangeEngineState = this.engine.event;
	readonly onDidChangeView = this.view.event;
	readonly onDidChangeGuide = this.guide.event;
	readonly onDidChangeCallGraph = this.callGraph.event;

	private lastEngine: string;
	// the function at the cursor comes with each update of the cursor, so a new object starts the check of the view
	private lastFn: EngineFunction | null | undefined;
	private lastFile: string | undefined;
	private lastView: string;
	private lastGuide: SideGuide | undefined;
	private lastCallGraph: CallGraphView | undefined;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly deps: ApiDeps) {
		const state = deps.store.state;
		this.lastEngine = JSON.stringify(engineEvent(state));
		this.lastFn = state.fn;
		this.lastFile = state.file;
		this.lastView = JSON.stringify(this.viewOf(state));
		this.lastGuide = state.guide;
		this.lastCallGraph = state.callGraph;
		this.subscription = deps.store.onDidChange((s) => this.onState(s));
	}

	dispose(): void {
		this.subscription.dispose();
		[this.engine, this.view, this.guide, this.callGraph].forEach((e) => e.dispose());
	}

	private onState(state: DataFlowState): void {
		const engine = engineEvent(state);
		const engineKey = JSON.stringify(engine);
		if (engineKey !== this.lastEngine) {
			this.lastEngine = engineKey;
			this.engine.fire(engine);
		}
		// the view changes only with an update of the cursor: the line of the cursor and the function at the cursor agree
		if (state.fn !== this.lastFn || state.file !== this.lastFile) {
			this.lastFn = state.fn;
			this.lastFile = state.file;
			const view = this.viewOf(state);
			const viewKey = JSON.stringify(view);
			if (viewKey !== this.lastView) {
				this.lastView = viewKey;
				this.view.fire(view);
			}
		}
		if (state.guide !== this.lastGuide) {
			this.lastGuide = state.guide;
			this.guide.fire(state.guide ? guideFacts(state.guide) : null);
		}
		if (state.callGraph !== this.lastCallGraph) {
			this.lastCallGraph = state.callGraph;
			this.callGraph.fire(callGraphFacts(state.callGraph));
		}
	}

	private viewOf(state: DataFlowState): Api.ViewEvent {
		const file = state.file;
		const fn = state.fn;
		const place = this.deps.currentPlace();
		const line = place && file && fileKey(place.doc.uri.fsPath) === fileKey(file) ? place.pos.line + 1 : null;
		return {
			file: file ?? null,
			function: fn ? { name: fn.qualifiedName || fn.name, lines: [fn.range.begin.line, fn.range.end.line] } : null,
			line,
		};
	}
}

// The API object of a version for a client. A different version throws an error
export function createApi(deps: ApiDeps, events: ApiEvents, version: unknown, options?: Api.DataFlowApiOptions): Api.DataFlowApi {
	if (version !== API_VERSION) {
		throw new Error(`DataFlow has no API version ${String(version)}. Use version ${API_VERSION}.`);
	}
	const name = options?.client;
	const client = typeof name === 'string' && name.trim().length > 0 ? name.trim() : DEFAULT_CLIENT;
	const tools = createTools(new DataFlowMcpHost({ ...deps.hostDeps, client: () => client }));
	const byName = new Map(tools.map((t) => [t.name, t]));
	deps.log(`The extension "${client}" uses the API of DataFlow.`);

	const call = async <T>(tool: string, args?: object): Promise<T> => {
		const t = byName.get(tool);
		if (!t) {
			throw new Error(`DataFlow has no tool ${tool}. The tools are ${tools.map((x) => x.name).join(', ')}.`);
		}
		if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
			throw new Error(`The arguments of ${tool} must be an object.`);
		}
		const result = await t.call({ ...(args ?? {}) } as Record<string, unknown>);
		return JSON.parse(result.text) as T;
	};

	return {
		version: API_VERSION,
		get engineState() {
			return deps.store.state.engine;
		},
		get engineError() {
			return engineError(deps.store.state);
		},
		get compileDatabases() {
			return deps.store.state.databases.map((d) => d.makefile ?? d.path);
		},
		tools: tools.map((t) => ({
			name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, isReadOnly: t.isReadOnly, isDestructive: t.isDestructive === true,
		})),
		onDidChangeEngineState: events.onDidChangeEngineState,
		onDidChangeView: events.onDidChangeView,
		onDidChangeGuide: events.onDidChangeGuide,
		onDidChangeCallGraph: events.onDidChangeCallGraph,
		callTool: (tool, args) => call<unknown>(tool, args),

		getView: () => call('get_view'),
		listFunctions: (args) => call('list_functions', args),
		getStructure: (args) => call('get_structure', args),
		getFlow: (args) => call('get_flow', args),
		getCalls: (args) => call('get_calls', args),
		getThreads: (args) => call('get_threads', args),
		getHidden: (args) => call('get_hidden', args),
		getIncludes: (args) => call('get_includes', args),
		getOutline: (args) => call('get_outline', args),
		getHeat: (args) => call('get_heat', args),
		getCallGraph: () => call('get_call_graph'),
		getLogic: (args) => call('get_logic', args),
		getRipple: () => call('get_ripple'),
		getReview: (args) => call('get_review', args),
		getDiff: (args) => call('get_diff', args),

		showBlocks: (args) => call('show_blocks', args),
		showFlow: (args) => call('show_flow', args),
		showLogicPath: (args) => call('show_logic_path', args),
		showLine: (args) => call('show_line', args),
		highlight: (args) => call('highlight', args),
		commentLines: (args) => call('comment_lines', args),
		addDetail: (args) => call('add_detail', args),
		clear: (args) => call('clear', args),
		setLens: (args) => call('set_lens', args),
		clearFlow: () => call('clear_flow'),
		startRipple: () => call('start_ripple'),
		clearRipple: () => call('clear_ripple'),
		scanCallGraph: () => call('scan_call_graph'),
		stopCallGraph: () => call('stop_call_graph'),
		showReviewPlan: (args) => call('show_review_plan', args),
		showDiffWalk: (args) => call('show_diff_walk', args),
		reviewStep: (args) => call('review_step', args),
		closeGuide: (args) => call('close_guide', args),
	};
}
