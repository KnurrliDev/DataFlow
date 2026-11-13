import * as vscode from 'vscode';
import { CompileDbInfo } from '../cdb/manager';
import { CallGraphResult, EngineFunction, EngineState, MemberModel } from '../engine/client';
import type { CostCategory, CostItemInfo, CostMark } from '../lenses/cost';
import type { FlowView } from '../lenses/flow';
import type { HeatModel } from '../lenses/heat';
import type { LogicView, LogicWarning } from '../lenses/logic';
import type { ReviewState } from '../lenses/ripple';
import type { PathStep } from '../logic/paths';
import type { DiffLine } from '../review/git';
import type { SideCalls, SideGuide, SideIncluders, SideIncludes, SideMcp, SideModel, SideStepHeat, SideThreads } from '../side/protocol';
import type { RippleModel } from '../review/ripple';

export type Lens = 'flow' | 'logic' | 'cost' | 'review' | 'includes' | 'calls' | 'threads' | 'heat';

// The heat of the functions of the file. While a computation runs, the old model of the same file stays
export interface HeatLayerState {
	file: string;
	isLoading: boolean;
	model?: HeatModel;
	error?: string;
}

// The heat of the steps of the guide with the number seq: the hottest function in the lines of each step. The guide
// itself does not keep the heat, because the workspace stores the guide
export interface GuideHeatState {
	seq: number;
	steps: (SideStepHeat | undefined)[];
}

// The scan of the call graph of the engine, for the reach of the heat score. stopped: the user stopped the scan
export interface CallGraphView {
	state: 'scanning' | 'stopped' | 'ready' | 'failed';
	done: number; // the progress of the scan
	total: number;
	error?: string;
	result?: CallGraphResult; // the last complete scan
}

// The variable or the data member that Flow Lens traces. Lines start at 0.
export interface TraceState {
	file: string; // the file of the function of a variable, or the file of the translation unit of a member
	fn?: EngineFunction; // the function of a variable. For a member, the function at the cursor, if there is one
	view: FlowView; // the view in the file
	variables: { name: string; type: string; declLine: number }[]; // the variables of the function, or the data members of the class
	pulse: number; // a new value makes the rails of the side view pulse. 0 means no pulse
	isSelected: boolean; // the cursor or a click selected the variable. With the cursor on no variable, no line is dimmed
	member?: MemberTraceState;
}

// The trace of a data member of a class. It has accesses in more than one file, so the side view makes the view of the
// file that it shows. Lines start at 1, as in the engine.
export interface MemberTraceState {
	model: MemberModel; // with the accesses of the other source files that the user parsed
	at?: { file: string; line: number }; // the access that started the trace. The tag of the declaration goes on its line
	others?: MemberOtherFile[]; // the other source files of the class. Undefined while the search runs
}

// A source file of the project with "Class::" that is not a part of the first trace
export interface MemberOtherFile {
	file: string;
	mentions: number; // the mentions of the name of the member in the file
	state: 'found' | 'parsing' | 'parsed' | 'failed';
	error?: string;
}

// The path of Logic Map in its function. The view has lines from 0, as VS Code. The steps, the warnings and the line
// of the why-list have lines from 1.
export interface LogicPathState {
	file: string;
	fn: EngineFunction;
	view: LogicView;
	steps: PathStep[];
	chosen: string[]; // the keys of the controls with a choice of the user. The other controls have the default option
	hasCfg: boolean; // false if the engine has no control flow graph for the function. Then the model has no blocks
	warnings: LogicWarning[];
	why?: { line: number; items: { key: string; text: string; option: string; options?: string[] }[] }; // why the line of the cursor runs
}

// The items of Hidden C++ in the file, and the items of the function at the cursor. Lines start at 1.
export interface CostLayerState {
	file: string;
	marks: CostMark[]; // the items that show
	counts: Record<CostCategory, number>; // the items of the file in each category, also in the categories that do not show
	enabled: CostCategory[]; // the categories that show
	fn?: string; // the function at the cursor
	items: CostItemInfo[]; // the items of the function at the cursor that show
	hidden: number; // the patterns that the user marked as not useful
}

// The last review of Change Ripple, for the story of the side view: the ripple, and the hunks of the diff of each file
export interface RippleLayerState {
	model: RippleModel;
	files: { file: string; hunks: DiffLine[][] }[];
	base: string; // for example "main (merge base 1a2b3c4)"
}

// The side view shows the file of the editor, or the story of a review
export type SideMode = 'file' | 'story';

// The state of the tool. The side view and the status bar only show this state.
export interface DataFlowState {
	engine: EngineState;
	engineVersion?: string;
	clangVersion?: string;
	databases: CompileDbInfo[];
	project?: { name: string; root: string }; // a project that is not open in VS Code
	parsing: string[];
	file?: string;
	fn?: EngineFunction | null;
	parseMs?: number;
	errorCount?: number;
	errors?: string[];
	lenses: Record<Lens, boolean>;
	lastLens?: Lens; // the lens that turned on last
	trace?: TraceState;
	logicPath?: LogicPathState; // the path of Logic Map in its function
	costLayer?: CostLayerState; // the items of Hidden C++ in the file
	includesLayer?: SideIncludes; // the include hierarchy of the file
	includersLayer?: SideIncluders; // the source files of the compile databases that include a file, for Included by
	callsLayer?: SideCalls; // the call graph of the file
	threadsLayer?: SideThreads; // the threads and the shared data of the file
	heatLayer?: HeatLayerState; // the heat of the functions of the file
	callGraph?: CallGraphView; // the scan of the call graph. Undefined: no scan
	guideHeat?: GuideHeatState; // the heat of the steps of the guide, while the lens Heat shows
	review?: ReviewState; // the state of the last review
	rippleLayer?: RippleLayerState; // the ripple of the last review
	modelLayers: SideModel[]; // the blocks and the notes of a language model, one layer for each file
	isModelShown: boolean; // the layers of the model show in the code view. The switch Model of the toolbar hides them
	guide?: SideGuide; // the guided review: the plan of a model to review the changes of the branch
	mcp: SideMcp; // the MCP server of DataFlow
	sideMode: SideMode;
	message?: string;
}

export class StateStore implements vscode.Disposable {
	private current: DataFlowState = {
		engine: 'stopped',
		databases: [],
		parsing: [],
		lenses: { flow: true, logic: true, cost: true, review: false, includes: true, calls: true, threads: true, heat: false },
		modelLayers: [],
		isModelShown: true,
		mcp: { state: 'off' },
		sideMode: 'file',
	};
	private readonly emitter = new vscode.EventEmitter<DataFlowState>();
	readonly onDidChange = this.emitter.event;

	get state(): DataFlowState {
		return this.current;
	}

	update(change: Partial<DataFlowState>): void {
		this.current = { ...this.current, ...change };
		this.emitter.fire(this.current);
	}

	toggleLens(lens: Lens): void {
		const isOn = !this.current.lenses[lens];
		this.update({ lenses: { ...this.current.lenses, [lens]: isOn }, lastLens: isOn ? lens : this.current.lastLens });
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
