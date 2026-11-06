// The "vscode" module gives the extension access to the VS Code API.
// VS Code gives this module to the extension when the extension runs.
// The "@types/vscode" package contains only the type declarations.
import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CompileDbInfo, CompileDbManager } from './cdb/manager';
import { findProjectFiles, isInside, MAX_PROJECT_FILES, SKIP_FOLDERS } from './cdb/project';
import { ProjectSettings } from './cdb/settings';
import {
	defaultTarget, findEngine, findUnrealProject, launcherInstalls, readRegistry, UBT_DB_FILE, ubtArguments, ubtProgram, UNREAL_DB_FILE, UNREAL_DB_FOLDER,
	unrealDbPath, UnrealProject, unrealTargets, writeUnrealDatabase,
} from './cdb/unreal';
import { mkdir, readFile, rm, stat } from 'fs/promises';
import { HomeView } from './home';
import {
	CallGraphModel, CostModel, EngineClient, EngineFunction, FlowModel, FlowOptions, FunctionSelector, LogicModel, LogicOptions, MemberEntry,
	MemberModel, MemberOptions, ThreadsModel,
} from './engine/client';
import { ALL_COST_CATEGORIES, buildCostMarks, CostCategory, costCounts, CostFilter, functionItems } from './lenses/cost';
import { buildFlowView, findVariable, LineText, ordinalOf, toUtf16Column, toUtf8Column, variableAt } from './lenses/flow';
import { buildLogicView, logicWarnings } from './lenses/logic';
import { addExternalCallers, buildSideCalls, callFunctionAt, callsOf, callTargetAt, ExternalCaller, graphLabels, wordAt } from './lenses/calls';
import { buildSideIncluders, buildSideIncludes } from './lenses/includes';
import { buildSideThreads } from './lenses/threads';
import { classScope, findIncluder, includeLine, isSourceFile, searchClassFiles, type ClassFile } from './lenses/classFiles';
import { buildMemberView, fileKey, memberRefAt, mergeMemberModels, sameFile, threadEntries } from './lenses/member';
import { buildReviewState } from './lenses/ripple';
import {
	ANY, buildControls, Choices, Control, dominators, evaluatePath, moveChoices, pathChoices, PathResult, pathSteps, WhyItem, whyLine,
} from './logic/paths';
import { DataFlowMcpHost } from './mcp/host';
import { LayerKeeper } from './mcp/layers';
import { McpManager } from './mcp/manager';
import { createPrompts, createTools } from './mcp/tools';
import { INCLUDE_FILE, isCppFile, openReviewRepository, ReviewDiff, ReviewRepository } from './review/git';
import { MAX_REVIEW_FILES, moveGuide, type ReviewFilesInput } from './review/guide';
import { CallSite, RippleModel, runRipple } from './review/ripple';
import { targetCandidates, targetItems } from './review/targets';
import { SideViewController } from './side/controller';
import type { SideAction, SideCallListSite, SideViewState } from './side/protocol';
import { Lens, LogicPathState, StateStore } from './state/store';
import { StatusBar } from './statusbar';

// The objects that the integration tests read. Code gets this API from getExtension(...).exports.
export interface DataFlowApi {
	store: StateStore;
	side: SideViewController;
	home: HomeView;
	mcp: McpManager;
	mcpHost: DataFlowMcpHost;
	layers: LayerKeeper;
}

const CPP_LANGUAGES = new Set(['c', 'cpp', 'cuda-cpp']);
const isCpp = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && CPP_LANGUAGES.has(doc.languageId);
const lineTextOf = (doc: vscode.TextDocument): LineText => (line) => (line >= 0 && line < doc.lineCount ? doc.lineAt(line).text : undefined);

// Flow Lens follows the cursor after the cursor stops for this time
const FOLLOW_DELAY_MS = 300;
// After an edit of a different file of a member trace, for example the header of the class, the trace comes again
// after this time. A header of the preamble makes a full parse of the translation unit, so a short pause is better.
const MEMBER_REFRESH_MS = 800;

// The key of the patterns that the user marked as not useful, in the state of the workspace
const HIDDEN_PATTERNS = 'dataflow.cost.hidden';

// The key of the target branches of Change Ripple that the user selected, by the folder of the repository, in the global
// state. A project that is not open in VS Code keeps its target branch in all windows.
const TARGETS_KEY = 'dataflow.ripple.targets';

// The C++ extensions that give a call hierarchy. If none is active, Change Ripple follows only the callers in the
// same file, and the side view tells the user.
const CALL_HIERARCHY_EXTENSIONS = ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'];
const CALL_HIERARCHY_MS = 5000;
// Call Hierarchy asks a C/C++ extension with no answer again after this time, a maximum of this number of times
const CALL_RETRY_MS = 10000;
const CALL_RETRIES = 6;
const CALL_HIERARCHY_FAILED = 'The call hierarchy of the C/C++ extension stopped with an error, so Called by shows only the callers in this file. '
	+ 'DataFlow does not ask it again in this window, because a request can stop its language server.';
const CALL_LIST_FAILED = 'The call hierarchy of the C/C++ extension stopped with an error, so the list has only the calls in this file. '
	+ 'DataFlow does not ask it again in this window, because a request can stop its language server.';
// the same default as the setting dataflow.ripple.asyncFunctions. Async, AsyncTask, AsyncThread, AsyncPool and
// UE::Tasks::Launch are the functions of Unreal Engine
const DEFAULT_ASYNC_FUNCTIONS = ['std::async', 'QtConcurrent::run', 'tf::Executor::async', 'Async', 'AsyncTask', 'AsyncThread', 'AsyncPool', 'UE::Tasks::Launch'];

// The variable that Flow Lens traces. After an edit, the name and the ordinal find the variable again.
interface Trace {
	file: string;
	uri: string;
	fn: string; // the qualified name of the function
	name: string;
	ordinal: number;
	model: FlowModel;
}

// The data member that Flow Lens traces. After an edit, the class and the name find the member again.
interface MemberTrace {
	file: string; // the file of the translation unit of the trace
	uri: string;
	className: string; // the qualified name of the class
	name: string;
	model: MemberModel; // the trace of the translation unit of file
	at?: { file: string; line: number }; // the access that started the trace. Lines start at 1
	others?: ClassFile[]; // the other source files of the class, from a search for "Class::". Undefined while it runs
	extra: Map<string, MemberExtra>; // the other source files that the user parsed, by the key of the file
}

// A different source file of the class, and the trace of the member in its translation unit
interface MemberExtra {
	file: string;
	state: 'parsing' | 'parsed' | 'failed';
	model?: MemberModel;
	error?: string;
	unit?: string; // the source file that includes an .inc file. The engine parses it for the .inc file
}

// The search for the other source files of a class keeps the list of the files of the project for this time
const PROJECT_FILES_MS = 60000;

// A save updates the review after this time, so that Save All starts one update
const REVIEW_UPDATE_MS = 1000;

// The connection to Claude Code. DataFlow offers it if the Claude Code extension is installed. After "Not now" it waits
// this time before it offers it again. The global state keeps 'never' or the time of the last offer
const CLAUDE_CODE_EXTENSION = 'anthropic.claude-code';
const CLAUDE_OFFER_KEY = 'dataflow.claude.offer';
// 'never' after "Do not ask again" for the compile database of an Unreal project
const UNREAL_OFFER_KEY = 'dataflow.unreal.offer';
const CLAUDE_OFFER_MS = 7 * 24 * 60 * 60 * 1000;

// The names of the folders that the list of the files of a project skips
function skipFolders(): string[] {
	const value = vscode.workspace.getConfiguration('dataflow').get<unknown>('project.skipFolders');
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : SKIP_FOLDERS;
}

// The function of Logic Map. The choices of a function stay when the cursor goes to another function.
interface LogicState {
	file: string;
	uri: string;
	key: string; // the file and the qualified name of the function
	model: LogicModel;
	controls: Control[];
	dom: Set<number>[];
	path?: PathResult;
}

// VS Code calls this function one time, when the first activation event occurs.
// The extension becomes active when a C or C++ file opens, or when one of its commands starts.
export function activate(context: vscode.ExtensionContext): DataFlowApi {
	// When you debug the extension, you can see this text in the Debug Console of the first VS Code window.
	console.log('The DataFlow extension is now active.');

	// Connect the command ID to a handler function.
	// The command ID must be the same as the "command" value in package.json.
	const disposable = vscode.commands.registerCommand('dataflow.helloWorld', () => {
		const message = 'Hello World from DataFlow!';
		vscode.window.showInformationMessage(message);

		// Code that runs this command with executeCommand gets this value. The tests use this value.
		return message;
	});

	// When VS Code deactivates the extension, it calls dispose() on each item in this list.
	// This removes the command handler.
	context.subscriptions.push(disposable);

	const log = vscode.window.createOutputChannel('DataFlow', { log: true });
	const store = new StateStore();
	const cdb = new CompileDbManager(context, log);
	const statusBar = new StatusBar(store);
	const home = new HomeView(store, cdb);
	context.subscriptions.push(log, store, cdb, statusBar, home, vscode.window.registerTreeDataProvider('dataflow.home', home));

	// The settings of a project that is not open in VS Code. VS Code does not read its .vscode/settings.json, so DataFlow
	// reads the settings of Logic Map, Flow Lens, Change Ripple and Hidden C++ from this file. A setting of the file wins
	// over the setting of VS Code, as a setting of a folder does.
	const projectSettings = new ProjectSettings((message) => log.warn(message));
	const PROJECT_SECTIONS = ['dataflow.logic', 'dataflow.flow', 'dataflow.ripple', 'dataflow.cost'];
	const settingOf = <T>(section: string, key: string, uri: vscode.Uri | undefined, fallback: T): T => {
		const project = cdb.project;
		if (project && PROJECT_SECTIONS.includes(section)
			&& (!uri || (isInside(uri.fsPath, project.root) && !vscode.workspace.getWorkspaceFolder(uri)))) {
			const value = projectSettings.get(project.root, `${section}.${key}`);
			if (value !== undefined && (Array.isArray(fallback) ? Array.isArray(value) : typeof value === typeof fallback)) {
				return value as T;
			}
		}
		return vscode.workspace.getConfiguration(section, uri).get<T>(key, fallback);
	};

	let engine: EngineClient | undefined;
	let cursorRequest: vscode.CancellationTokenSource | undefined;
	let cursorTimer: NodeJS.Timeout | undefined;
	const changeTimers = new Map<string, NodeJS.Timeout>();
	context.subscriptions.push({ dispose: () => engine?.dispose() });

	// The side view shows the lenses beside the text editor. It opens when a lens turns on. The text editor shows no
	// decorations of DataFlow.
	const side = new SideViewController(context.extensionUri, store, () => engine, (action, editor) => onSideAction(action, editor),
		() => onSideCursor());

	// The C++ editor of the last change of the cursor. When the focus is in the side view, no editor is active, but the
	// side view moves the cursor of this editor.
	let cursorEditor: vscode.TextEditor | undefined;
	const currentEditor = (): vscode.TextEditor | undefined => {
		const active = vscode.window.activeTextEditor;
		if (active) {
			return active;
		}
		return cursorEditor && vscode.window.visibleTextEditors.includes(cursorEditor) ? cursorEditor : undefined;
	};

	// The place of the cursor that the lenses follow: the cursor of the active C++ editor, else the cursor of the side
	// view, else the cursor of the C++ editor of the last change of the cursor. With Claude Code in front of the C++
	// editor, only the side view shows the file, and a click in the side view moves its cursor.
	type Place = { doc: vscode.TextDocument; pos: vscode.Position };
	const placeOf = (editor: vscode.TextEditor | undefined): Place | undefined => {
		return editor && isCpp(editor.document) ? { doc: editor.document, pos: editor.selection.active } : undefined;
	};
	const currentPlace = (): Place | undefined => {
		const active = vscode.window.activeTextEditor;
		if (active && isCpp(active.document)) {
			return placeOf(active);
		}
		return side.cursorPlace ?? (active ? undefined : placeOf(currentEditor()));
	};

	// The cursor in a document: of a text editor of the document, else of the side view
	const cursorIn = (doc: vscode.TextDocument): vscode.Position | undefined => {
		const place = side.cursorPlace;
		return vscode.window.visibleTextEditors.find((e) => e.document === doc)?.selection.active ?? (place?.doc === doc ? place.pos : undefined);
	};
	context.subscriptions.push(side, vscode.window.registerWebviewPanelSerializer(SideViewController.viewType, {
		deserializeWebviewPanel: (webviewPanel, state) => side.restore(webviewPanel, state as SideViewState | undefined),
	}));

	// Flow Lens: the traced variable or data member, and the last flow model with the document version that the engine
	// parsed
	let trace: Trace | undefined;
	let memberTrace: MemberTrace | undefined;
	let flowCache: { file: string; version: number; model: FlowModel } | undefined;
	let flowRequest: vscode.CancellationTokenSource | undefined;
	let followTimer: NodeJS.Timeout | undefined;
	let memberRefreshTimer: NodeJS.Timeout | undefined;
	let pulseCount = 0;

	// Logic Map: the model of the function at the cursor, and the choices of each function
	let logic: LogicState | undefined;
	const choicesOf = new Map<string, Choices>();
	let logicRequest: vscode.CancellationTokenSource | undefined;
	let followedLine: string | undefined; // the function and the line of the cursor that Logic Map followed last

	// Hidden C++: the items of all functions of the file in the editor
	let cost: { file: string; uri: string; model: CostModel } | undefined;
	let costRequest: vscode.CancellationTokenSource | undefined;

	// Include Hierarchy: the file, and the last line with an include of the file. An edit at or above this line, or an
	// edit with a '#', makes the hierarchy dirty. The next change that goes to the engine loads it again.
	let includes: { file: string; uri: string; lastLine: number } | undefined;
	let includesRequest: vscode.CancellationTokenSource | undefined;
	let isIncludesDirty = false;
	let includersRequest: { file: string; source: vscode.CancellationTokenSource } | undefined;

	// Call Hierarchy: the call graph of the file, the function at the cursor, and the callers in other files of each
	// function from the call hierarchy of VS Code
	let calls: { file: string; uri: string; model: CallGraphModel; focus: number; external: Map<number, ExternalCaller[]> } | undefined;
	let callsRequest: vscode.CancellationTokenSource | undefined;

	// Threads and races: the last analysis of the threads of a file
	let threads: { file: string; uri: string; model: ThreadsModel } | undefined;
	let threadsRequest: vscode.CancellationTokenSource | undefined;

	// The first failure of the call hierarchy of VS Code in this window. DataFlow does not ask it again. runningHierarchy
	// settles when the running request settles
	let callHierarchyFailure: string | undefined;
	// The tab Calls or the graph of the side view shows. Only then Call Hierarchy asks VS Code for the callers in other
	// files without a click of the user
	let isCallsShown = false;
	let runningHierarchy: Promise<void> | undefined;
	const isHierarchyRunning = () => runningHierarchy !== undefined;

	// Change Ripple: the last review and the root of its repository. A newer review stops an older review.
	let review: { model: RippleModel; diff: ReviewDiff; root: string } | undefined;
	let reviewRun = 0;
	let reviewUpdate: NodeJS.Timeout | undefined;

	// VS Code opens .inc files as plain text. In the folder of a compile database, an .inc file is a part of a C or C++
	// file, for example of a unity build. Thus DataFlow sets its language to C++. If the user sets the language back
	// to plain text, the document keeps it.
	const adopted = new WeakSet<vscode.TextDocument>();
	const adoptIncludeFile = (doc: vscode.TextDocument): void => {
		const file = doc.uri.fsPath;
		if (doc.uri.scheme !== 'file' || doc.languageId !== 'plaintext' || !INCLUDE_FILE.test(file) || adopted.has(doc)
			|| !cdb.databases.some((db) => isInside(file, db.folder))) {
			return;
		}
		adopted.add(doc);
		vscode.languages.setTextDocumentLanguage(doc, 'cpp').then(undefined, (error) => log.warn(`${file} did not change to C++: ${error}`));
	};

	const startEngine = async (): Promise<void> => {
		const databases = await cdb.discover();
		const project = cdb.project;
		watchProjectSettings();
		store.update({ databases, project: project && { name: project.name, root: project.root }, message: undefined });
		for (const doc of vscode.workspace.textDocuments) {
			adoptIncludeFile(doc);
		}
		if (databases.length === 0) {
			log.warn('No compile database. Run "DataFlow: Select Compile Database", or set dataflow.compileCommands.');
			store.update({ engine: 'stopped' });
			// an Unreal project gets its database from UnrealBuildTool
			const unreal = unrealProjects().find((p) => p.hasSource);
			if (unreal) {
				log.info(`${unreal.name} is an Unreal project. Run "DataFlow: Make Unreal Compile Database".`);
				void offerUnrealDatabase(unreal);
			}
			return;
		}
		const enginePath = resolveEnginePath(context);
		if (!enginePath) {
			store.update({ engine: 'failed', message: 'DataFlow found no engine. Build it, or set dataflow.engine.path.' });
			return;
		}

		const config = vscode.workspace.getConfiguration('dataflow');
		const client = new EngineClient({
			enginePath,
			compileCommands: databases.map((db) => db.path),
			maxThreads: config.get<number>('engine.maxThreads') || undefined,
			cacheSize: config.get<number>('engine.cacheSize'),
			log,
		});
		engine = client;
		client.onDidChangeState((state) => store.update({ engine: state }));
		client.onStatus((status) => {
			const parsing = store.state.parsing.filter((f) => f !== status.file);
			store.update({ parsing: status.state === 'parsing' ? [...parsing, status.file] : parsing });
		});
		for (const doc of vscode.workspace.textDocuments) {
			if (isCpp(doc)) {
				client.didOpen(doc.uri.fsPath, doc.getText(), doc.version);
			}
		}
		try {
			const info = await client.start();
			store.update({ clangVersion: info.clang });
			scheduleCursorUpdate(0);
		} catch (error) {
			store.update({ message: `The engine did not start: ${error}` });
		}
	};

	// A restart waits for the restart before it. Two restarts at the same time would start two engines, and the first one
	// would run with no owner. A change of the project, of the settings and of the compile database can come quickly.
	let restarting = Promise.resolve();
	const restartNow = async (): Promise<void> => {
		// a review in the side view runs again with the new engine. Until then, its story tells that the review runs. If
		// the engine does not start, the story tells why
		const isReviewShown = !!store.state.review && side.isOpen;
		const old = engine;
		engine = undefined;
		await old?.stop();
		old?.dispose();
		store.update({ parsing: [], fn: undefined });
		clearTrace();
		clearLogic();
		clearCost();
		clearIncludes();
		clearCalls();
		clearThreads();
		includeContexts.clear();
		headerUnits.clear();
		if (isReviewShown) {
			reviewRun++;
			review = undefined;
			store.update({ review: { isRunning: true, other: [] }, rippleLayer: undefined });
		} else {
			clearReview();
		}
		flowCache = undefined;
		await startEngine();
		if (isReviewShown) {
			void runReview();
		}
	};
	const restartEngine = (): Promise<void> => (restarting = restarting.then(restartNow, restartNow));

	// The Unreal projects of the workspace folders and of the project of DataFlow
	const unrealProjects = (): UnrealProject[] => {
		const roots = [...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), ...(cdb.project ? [cdb.project.root] : [])];
		return [...new Map(roots.map((r) => [fileKey(r), r])).values()].map(findUnrealProject).filter((p): p is UnrealProject => !!p);
	};

	// Runs a program with no shell, and gives each line of its output. The result is the exit code, or 'cancelled' if the
	// token stopped the program
	const runProgram = (program: string, args: string[], cwd: string, token: vscode.CancellationToken, onLine: (line: string) => void): Promise<number | 'cancelled'> =>
		new Promise((resolve) => {
			const child = spawn(program, args, { cwd, windowsHide: true });
			let isCancelled = false;
			const cancel = token.onCancellationRequested(() => {
				isCancelled = true;
				// UnrealBuildTool starts more processes, so the whole tree stops
				if (process.platform === 'win32' && child.pid) {
					execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
				} else {
					child.kill();
				}
			});
			let rest = '';
			const onData = (data: Buffer) => {
				const lines = (rest + data.toString()).split(/\r?\n/);
				rest = lines.pop() ?? '';
				lines.filter((l) => l.trim()).forEach(onLine);
			};
			child.stdout.on('data', onData);
			child.stderr.on('data', onData);
			const finish = (code: number) => {
				cancel.dispose();
				if (rest.trim()) {
					onLine(rest);
				}
				resolve(isCancelled ? 'cancelled' : code);
			};
			child.on('error', (error) => {
				onLine(String(error));
				finish(-1);
			});
			child.on('close', (code) => finish(code ?? -1));
		});

	// Lets UnrealBuildTool write the compile database of an Unreal project into Intermediate/DataFlow, with the target of
	// the setting, else the editor target. A notification shows the progress, and its button Cancel stops UnrealBuildTool.
	// Then DataFlow writes its database with copies of the response files, and the engine starts again with it. The
	// database manager starts it, so the watcher of the new file and the command give one start
	const makeUnrealDatabase = async (given?: UnrealProject): Promise<boolean> => {
		const projects = given ? [given] : unrealProjects();
		const project = projects.length > 1
			? (await vscode.window.showQuickPick(projects.map((p) => ({ label: p.name, description: p.root, project: p })), { placeHolder: 'Select the Unreal project' }))?.project
			: projects[0];
		if (!project) {
			if (projects.length === 0) {
				void vscode.window.showWarningMessage('DataFlow found no .uproject file in the workspace folders or in the project.');
			}
			return false;
		}
		if (!project.hasSource) {
			void vscode.window.showWarningMessage(`${project.name} has no C++ code: the project has no folder Source.`);
			return false;
		}
		const config = vscode.workspace.getConfiguration('dataflow.unreal', vscode.Uri.file(project.root));
		const engineRoot = await findEngine(project, { setting: config.get<string>('enginePath') || undefined, registry: readRegistry, launcherInstalls });
		const program = engineRoot && ubtProgram(engineRoot);
		if (!engineRoot || !program) {
			const engineName = project.engineAssociation ? `Unreal Engine ${project.engineAssociation}` : 'an Unreal Engine in a folder above the project';
			const pick = await vscode.window.showErrorMessage(`DataFlow found no ${engineName} with UnrealBuildTool for ${project.name}. `
				+ 'Set dataflow.unreal.enginePath to the folder of the engine.', 'Open Settings');
			if (pick) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'dataflow.unreal.enginePath');
			}
			return false;
		}
		const target = defaultTarget(unrealTargets(project.root), project.name, config.get<string>('target') ?? '');
		if (!target) {
			void vscode.window.showWarningMessage(`${project.name} has no target: its folder Source has no .Target.cs file.`);
			return false;
		}
		const args = ubtArguments(project, target.name, config.get<string>('configuration') || 'Development', config.get<string[]>('arguments') ?? []);
		// UnrealBuildTool does not make the folder of the database. The file of a run that failed must not count
		const ubtFile = path.join(project.root, UNREAL_DB_FOLDER, UBT_DB_FILE);
		await mkdir(path.dirname(ubtFile), { recursive: true });
		await rm(ubtFile, { force: true });
		log.info(`UnrealBuildTool of ${engineRoot}: ${args.join(' ')}`);
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `DataFlow: UnrealBuildTool makes the compile database of ${target.name}`, cancellable: true },
			(progress, token) => runProgram(program, args, project.root, token, (line) => {
				log.info(`UnrealBuildTool: ${line}`);
				progress.report({ message: line.length > 100 ? `${line.slice(0, 99)}…` : line });
			}),
		);
		if (result === 0 && existsSync(ubtFile)) {
			try {
				const copies = await writeUnrealDatabase(ubtFile, unrealDbPath(project.root));
				log.info(`DataFlow wrote ${unrealDbPath(project.root)} with ${copies} copies of the response files of UnrealBuildTool.`);
			} catch (error) {
				log.error(`DataFlow did not write ${unrealDbPath(project.root)}: ${error instanceof Error ? error.message : String(error)}`);
				void vscode.window.showErrorMessage(`DataFlow did not write the compile database of ${project.name}. The log of DataFlow has the cause.`);
				return false;
			}
			void vscode.window.showInformationMessage(`DataFlow: the compile database of ${project.name} is ready.`);
			cdb.refresh();
			return true;
		}
		if (result !== 'cancelled') {
			const pick = await vscode.window.showErrorMessage(`UnrealBuildTool did not make the compile database of ${project.name}. The log of DataFlow has its output.`, 'Show Log');
			if (pick) {
				log.show();
			}
		}
		return false;
	};

	// Offers the compile database to an Unreal project with no database: one time in a session, until the user selects
	// "Do not ask again" for the workspace
	let isUnrealOffered = false;
	const offerUnrealDatabase = async (project: UnrealProject): Promise<void> => {
		if (isUnrealOffered || context.workspaceState.get(UNREAL_OFFER_KEY) === 'never') {
			return;
		}
		isUnrealOffered = true;
		const pick = await vscode.window.showInformationMessage(`${project.name} is an Unreal project with no compile database. `
			+ `DataFlow can let UnrealBuildTool make one: it runs UnrealHeaderTool and writes ${path.join(UNREAL_DB_FOLDER, UNREAL_DB_FILE)}.`,
		'Make', 'Not now', 'Do not ask again');
		if (pick === 'Make') {
			await makeUnrealDatabase(project);
		} else if (pick === 'Do not ask again') {
			await context.workspaceState.update(UNREAL_OFFER_KEY, 'never');
		}
	};

	// An .inc file of a unity build can need the code before its #include in the source file, for example a declaration
	// of an earlier header. If its parse alone has errors, the engine parses it again after the lines of the source file
	// before the #include. Each file gets one try for each engine, and its lenses come again from the new parse.
	const includeContexts = new Set<string>();
	const useIncluderContext = async (file: string): Promise<void> => {
		const key = fileKey(file);
		const client = engine;
		if (!client || includeContexts.has(key)) {
			return;
		}
		includeContexts.add(key);
		const unit = await findIncluder(await projectSourceFiles(), readSource, file);
		const text = unit ? await readSource(unit) : undefined;
		const line = unit && text ? includeLine(text, file) : 0;
		if (!unit || line === 0 || engine !== client) {
			return;
		}
		log.info(`${path.basename(file)} has errors alone. The engine parses it after the lines of ${unit} before line ${line}.`);
		client.setContext(file, unit, line);
		side.onDidChangeParse(file);
		clearTrace();
		clearLogic();
		clearCost();
		clearIncludes();
		clearCalls();
		clearThreads();
		flowCache = undefined;
		scheduleCursorUpdate(0);
	};

	// The source file of a header for Hidden C++: a source file of the project that includes the header. The engine finds
	// the instantiations of the templates of the header in it, so only a header with a template needs it.
	const headerUnits = new Map<string, Promise<string | undefined>>();
	const unitOfHeader = (doc: vscode.TextDocument): Promise<string | undefined> => {
		const file = doc.uri.fsPath;
		if (isSourceFile(file) || !/\btemplate\s*</.test(doc.getText())) {
			return Promise.resolve(undefined);
		}
		const key = fileKey(file);
		let unit = headerUnits.get(key);
		if (!unit) {
			unit = projectSourceFiles().then((files) => findIncluder(files, readSource, file)).catch(() => undefined);
			headerUnits.set(key, unit);
		}
		return unit;
	};

	// Asks the engine for the function at the cursor. A newer request cancels the older one.
	const updateCursor = async (): Promise<void> => {
		const place = currentPlace();
		if (!place || !isCpp(place.doc)) {
			return;
		}
		if (!engine || engine.currentState !== 'ready') {
			return;
		}
		cursorRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		cursorRequest = request;
		const doc = place.doc;
		const file = doc.uri.fsPath;
		const pos = place.pos;
		try {
			const res = await engine.functionAt(file, pos.line + 1, pos.character + 1, request.token);
			if (request.token.isCancellationRequested) {
				return;
			}
			store.update({ file, fn: res.function, parseMs: res.parseMs, errorCount: res.errorCount, errors: res.errors });
			if (res.errorCount > 0 && INCLUDE_FILE.test(file)) {
				void useIncluderContext(file);
			}
			if (store.state.lenses.logic && res.function) {
				// a lambda has its own logic. Its name in the key comes from the engine: <function>::(lambda <n>)
				const lambda = res.lambda ? `::(lambda ${res.lambda.index + 1})` : '';
				if (logic?.key !== `${file}#${res.function.qualifiedName}${lambda}`) {
					void loadLogic(doc, { line: pos.line + 1, col: pos.character + 1 });
				} else {
					updateWhy();
					followLogic();
				}
			}
			if (store.state.lenses.cost) {
				if (cost?.file !== file) {
					void loadCost(doc);
				} else {
					updateCostItems();
				}
			}
			if (store.state.lenses.includes && includes?.file !== file) {
				void loadIncludes(doc);
			}
			if (store.state.lenses.calls) {
				if (calls?.file !== file) {
					void loadCalls(doc);
				} else {
					updateCallFocus(doc, pos.line + 1);
				}
			}
			if (store.state.lenses.threads && threads?.file !== file) {
				void loadThreads(doc);
			}
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				log.debug(`functionAt: ${error}`);
			}
		}
	};

	const scheduleCursorUpdate = (delay = 150): void => {
		clearTimeout(cursorTimer);
		cursorTimer = setTimeout(() => void updateCursor(), delay);
	};

	// Sends the text of the document to the engine. Then the function at the cursor and the trace update.
	const sendChange = (doc: vscode.TextDocument): void => {
		const file = doc.uri.fsPath;
		clearTimeout(changeTimers.get(file));
		changeTimers.delete(file);
		engine?.didChange(file, doc.getText(), doc.version);
		side.onDidSendChange(doc);
		scheduleCursorUpdate(0);
		if (trace?.file === file) {
			void refreshTrace(doc);
		}
		if (memberTrace && sameFile(memberTrace.file, file)) {
			void refreshMemberTrace(doc);
		}
		// a different file of the trace, for example the header of the class: the engine parses the unit again with the
		// new text of the header, and the lines of its accesses move
		const traced = memberTrace;
		if (traced && !sameFile(traced.file, file)
			&& (sameFile(traced.model.member.decl.file, file) || traced.model.refs.some((r) => sameFile(r.file, file)))) {
			clearTimeout(memberRefreshTimer);
			memberRefreshTimer = setTimeout(() => {
				const tuDoc = memberTrace === traced ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === traced.uri) : undefined;
				if (tuDoc) {
					void refreshMemberTrace(tuDoc);
				}
			}, MEMBER_REFRESH_MS);
		}
		if (memberTrace?.extra.get(fileKey(file))?.state === 'parsed') {
			void parseMemberFile(file);
		}
		if (logic?.file === file) {
			void loadLogic(doc, logicSelector(logic.model));
		}
		if (cost?.file === file) {
			void loadCost(doc);
		}
		if (includes?.file === file && isIncludesDirty) {
			isIncludesDirty = false;
			void loadIncludes(doc);
		}
		if (calls?.file === file) {
			void loadCalls(doc);
		}
		if (threads?.file === file) {
			void loadThreads(doc);
		}
	};

	// Sends the text now if a change waits for its timer
	const flushChange = (doc: vscode.TextDocument): void => {
		if (changeTimers.has(doc.uri.fsPath)) {
			sendChange(doc);
		}
	};

	// The flow model of the function at the position. The cache keeps the last model and its document version.
	const getFlow = async (client: EngineClient, doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<FlowModel> => {
		const file = doc.uri.fsPath;
		const line = pos.line + 1;
		const cached = flowCache;
		if (cached && cached.file === file && cached.version === doc.version &&
			cached.model.function.range.begin.line <= line && line <= cached.model.function.range.end.line) {
			return cached.model;
		}
		flushChange(doc);
		const version = doc.version;
		const model = await client.flow(file, { line, col: toUtf8Column(doc.lineAt(pos.line).text, pos.character) }, flowOptionsOf(doc.uri), token);
		flowCache = { file, version, model };
		return model;
	};

	// Shows the flow of one variable. A new variable gets the pulse. The same variable gets new data only.
	const showTrace = (doc: vscode.TextDocument, model: FlowModel, index: number, animate: boolean, isSelected = true): void => {
		const next: Trace = {
			file: doc.uri.fsPath,
			uri: doc.uri.toString(),
			fn: model.function.qualifiedName,
			name: model.variables[index].name,
			ordinal: ordinalOf(model, index),
			model,
		};
		const isSame = !!trace && trace.uri === next.uri && trace.fn === next.fn && trace.name === next.name && trace.ordinal === next.ordinal;
		if (isSame && trace!.model === model) {
			// the cursor is on the traced variable again
			if (store.state.trace && store.state.trace.isSelected !== isSelected) {
				store.update({ trace: { ...store.state.trace, isSelected } });
			}
			return;
		}
		trace = next;
		memberTrace = undefined;
		const lineText = lineTextOf(doc);
		const view = buildFlowView(model, index, lineText);
		const isPulse = animate && !isSame && animationsOn();
		const variables = model.variables.map((v) => ({ name: v.name, type: v.type, declLine: model.refs[v.declRef].line - 1 }));
		const pulse = isPulse ? ++pulseCount : store.state.trace?.pulse ?? 0;
		store.update({ trace: { file: next.file, fn: model.function, view, variables, pulse, isSelected } });
	};

	// The functions that run a callable on a different thread. Flow Lens shows the thread of each access of a member.
	const asyncFunctionsOf = (uri: vscode.Uri): string[] =>
		settingOf('dataflow.ripple', 'asyncFunctions', uri, DEFAULT_ASYNC_FUNCTIONS);

	// The functions that only read their arguments and their object. Flow Lens shows their calls as reads.
	const flowOptionsOf = (uri: vscode.Uri): FlowOptions =>
		({ readFunctions: settingOf<string[]>('dataflow.flow', 'readFunctions', uri, []) });

	// The options of a member trace. The threads analysis of the translation unit follows the calls into the headers of
	// the project folders. entries are the threads of other source files that call into this one.
	const memberOptionsOf = (uri: vscode.Uri, entries: MemberEntry[] = []): MemberOptions => ({
		asyncFunctions: asyncFunctionsOf(uri), ...flowOptionsOf(uri), roots: projectRoots(), ...(entries.length > 0 ? { entries } : {}),
	});

	// The trace of the member at the position, or undefined if no member is there
	const getMember = async (client: EngineClient, doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<MemberModel | undefined> => {
		flushChange(doc);
		const at = { line: pos.line + 1, col: toUtf8Column(doc.lineAt(pos.line).text, pos.character) };
		return client.member(doc.uri.fsPath, at, memberOptionsOf(doc.uri), token);
	};

	// Shows the trace of a data member. A new member gets the pulse. The same member gets new data only. lineText gives
	// the lines of the file of the translation unit.
	const showMemberTrace = (file: string, uri: string, lineText: LineText, model: MemberModel, animate: boolean, isSelected: boolean,
		at?: { file: string; line: number }): void => {
		const old = memberTrace;
		const isSame = !!old && old.className === model.member.qualifiedClass && old.name === model.member.name && sameFile(old.file, file);
		const isSameClass = !!old && old.className === model.member.qualifiedClass && sameFile(old.file, file);
		const next: MemberTrace = {
			file, uri, className: model.member.qualifiedClass, name: model.member.name, model, at: at ?? (isSame ? old?.at : undefined),
			others: isSame ? old?.others : undefined, extra: isSame ? old!.extra : new Map(),
		};
		trace = undefined;
		memberTrace = next;
		const isPulse = animate && !isSame && animationsOn();
		publishMemberTrace(lineText, isPulse ? ++pulseCount : store.state.trace?.pulse ?? 0, isSelected);
		if (!isSame) {
			void searchMemberFiles(next);
			// the files that the user parsed for a different member of the class: the trace of this member in them
			for (const e of isSameClass ? old!.extra.values() : []) {
				if (e.state === 'parsed') {
					void parseMemberFile(e.file);
				}
			}
		}
	};

	// Sends the member trace to the side view: the trace of its translation unit and the traces of the other source files
	// that the user parsed
	const publishMemberTrace = (lineText?: LineText, pulse = store.state.trace?.pulse ?? 0, isSelected = store.state.trace?.isSelected ?? true): void => {
		const current = memberTrace;
		if (!current) {
			return;
		}
		const extras = [...current.extra.values()].flatMap((e) => (e.state === 'parsed' && e.model ? [{ file: e.file, model: e.model }] : []));
		const model = mergeMemberModels(current.model, extras);
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === current.uri);
		const others = current.others?.map((o) => {
			const e = current.extra.get(fileKey(o.file));
			return { file: o.file, mentions: o.mentions, state: e?.state ?? 'found' as const, error: e?.error };
		});
		store.update({
			trace: {
				file: current.file,
				fn: current.model.function ?? undefined,
				view: buildMemberView(model, current.file, lineText ?? (doc ? lineTextOf(doc) : () => undefined)),
				variables: current.model.fields.map((f) => ({ name: f.name, type: f.type, declLine: f.line - 1 })),
				pulse,
				isSelected,
				member: { model, at: current.at, others },
			},
		});
	};

	// The C/C++ source files of the project folders, with no build folders. The list stays for PROJECT_FILES_MS
	let projectFiles: { key: string; time: number; files: string[] } | undefined;
	const projectSourceFiles = async (): Promise<string[]> => {
		const roots = [...new Set([...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), ...(store.state.project ? [store.state.project.root] : [])])];
		const key = roots.join('|');
		if (!projectFiles || projectFiles.key !== key || Date.now() - projectFiles.time > PROJECT_FILES_MS) {
			const files = (await Promise.all(roots.map((r) => findProjectFiles(r, MAX_PROJECT_FILES, skipFolders())))).flat().filter(isSourceFile);
			projectFiles = { key, time: Date.now(), files: [...new Map(files.map((f) => [fileKey(f), f])).values()] };
		}
		return projectFiles.files;
	};

	// The text of a file: the text of the editor if the file is open, else the file on disk
	const readSource = async (file: string): Promise<string | undefined> => {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && sameFile(d.uri.fsPath, file));
		if (doc) {
			return doc.getText();
		}
		try {
			return await readFile(file, 'utf8');
		} catch {
			return undefined;
		}
	};

	// Finds the other source files of the member that are not a part of the trace: the files with "Class::", and the files
	// that include the header of the member and name it
	const searchMemberFiles = async (current: MemberTrace): Promise<void> => {
		try {
			const files = (await projectSourceFiles()).filter((f) => !sameFile(f, current.file) && !current.model.refs.some((r) => sameFile(r.file, f)));
			const decl = current.model.member.decl.file;
			const header = isSourceFile(decl) ? undefined : decl;
			const { className, qualifiedClass } = current.model.member;
			const others = await searchClassFiles(files, readSource, className, current.name, header, undefined, classScope(qualifiedClass, className));
			if (memberTrace === current) {
				current.others = others;
				publishMemberTrace();
			}
		} catch (error) {
			log.debug(`member files: ${error}`);
			if (memberTrace === current) {
				current.others = [];
				publishMemberTrace();
			}
		}
	};

	// Adds the accesses of a different source file of the class: the engine parses its translation unit and traces the
	// member by its class and its name. The threads of the trace that call functions of other files go with the request,
	// so that these functions run on them. An .inc file of a unity build has no context of its own: the engine parses the
	// source file that includes it.
	const parseMemberFile = async (file: string): Promise<void> => {
		const current = memberTrace;
		const client = engine;
		if (!current || !client || client.currentState !== 'ready') {
			return;
		}
		const key = fileKey(file);
		current.extra.set(key, { file, state: 'parsing' });
		publishMemberTrace();
		let entry: MemberExtra;
		try {
			const unit = /\.inc$/i.test(file) ? await findIncluder(await projectSourceFiles(), readSource, file) : undefined;
			// the threads of the first unit and of the parsed files that call into other files
			const parsed = [...current.extra.values()].flatMap((e) => (e.state === 'parsed' && e.model ? [{ file: e.file, model: e.model }] : []));
			const entries = threadEntries(mergeMemberModels(current.model, parsed));
			const model = await client.member(unit ?? file, { className: current.className, member: current.name }, memberOptionsOf(vscode.Uri.file(file), entries));
			const scope = current.model.member.kind === 'global' ? current.className || 'the global namespace' : `class ${current.className}`;
			entry = model ? { file, state: 'parsed', model, unit }
				: { file, state: 'failed', unit, error: `The translation unit of ${path.basename(unit ?? file)} has no ${current.name} in ${scope}.` };
		} catch (error) {
			entry = { file, state: 'failed', error: String(error) };
		}
		if (memberTrace === current) {
			current.extra.set(key, entry);
			publishMemberTrace();
		}
	};

	// Parses the other source files of the class one after the other, so that the engine parses one unit at a time
	const parseMemberFiles = async (): Promise<void> => {
		const current = memberTrace;
		for (const o of current?.others ?? []) {
			if (memberTrace !== current) {
				return;
			}
			if (!current!.extra.has(fileKey(o.file))) {
				await parseMemberFile(o.file);
			}
		}
	};

	// After an edit of the file of the translation unit, gets the trace of the member again by its class and its name
	const refreshMemberTrace = async (doc: vscode.TextDocument): Promise<void> => {
		const current = memberTrace;
		const client = engine;
		if (!current || !client || client.currentState !== 'ready') {
			return;
		}
		try {
			const model = await client.member(current.file, { className: current.className, member: current.name }, memberOptionsOf(doc.uri));
			if (memberTrace !== current) {
				return;
			}
			if (!model) {
				clearTrace();
				return;
			}
			showMemberTrace(current.file, current.uri, lineTextOf(doc), model, false, store.state.trace?.isSelected ?? true);
		} catch (error) {
			log.debug(`member refresh: ${error}`);
			if (memberTrace === current) {
				clearTrace();
			}
		}
	};

	// Traces a different data member of the class of the traced member: a click on its button in the side view
	const traceField = async (index: number): Promise<void> => {
		const current = memberTrace;
		const client = engine;
		const field = current?.model.fields[index];
		if (!current || !field || !client || client.currentState !== 'ready') {
			return;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === current.uri);
		try {
			const model = await client.member(current.file, { className: current.className, member: field.name }, memberOptionsOf(vscode.Uri.parse(current.uri)));
			if (memberTrace === current && model) {
				showMemberTrace(current.file, current.uri, doc ? lineTextOf(doc) : () => undefined, model, true, true);
			}
		} catch (error) {
			log.debug(`member: ${error}`);
		}
	};

	const clearTrace = (): void => {
		trace = undefined;
		memberTrace = undefined;
		if (store.state.trace) {
			store.update({ trace: undefined });
		}
	};

	// The cursor is on no variable. The trace stays, but the side view does not dim the lines with no reference
	const deselectTrace = (): void => {
		if (store.state.trace?.isSelected) {
			store.update({ trace: { ...store.state.trace, isSelected: false } });
		}
	};

	const selectTrace = (): void => {
		if (store.state.trace && !store.state.trace.isSelected) {
			store.update({ trace: { ...store.state.trace, isSelected: true } });
		}
	};

	// Traces the variable at the cursor. In follow mode (quiet), a position with no variable keeps the old trace, but no
	// line is dimmed.
	const traceAtCursor = (quiet: boolean): Promise<void> => {
		const place = currentPlace();
		return traceAt(place?.doc, place?.pos, quiet);
	};

	// Traces the variable at the position. If no variable is there, traces the data member of a class at the position.
	const traceAt = async (doc: vscode.TextDocument | undefined, pos: vscode.Position | undefined, quiet: boolean): Promise<void> => {
		const client = engine;
		if (!doc || !pos || !isCpp(doc) || !client || client.currentState !== 'ready') {
			if (!quiet) {
				vscode.window.setStatusBarMessage('DataFlow: Open a C++ file and wait for the engine.', 4000);
			}
			return;
		}
		flowRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		flowRequest = request;
		const showLens = (): void => {
			if (!store.state.lenses.flow) {
				store.toggleLens('flow');
			}
			if (!quiet) {
				side.open();
			}
		};

		// the cursor on an access of the traced member: the trace stays
		if (memberTrace && memberRefAt(memberTrace.model, doc.uri.fsPath, pos.line, pos.character, lineTextOf(doc)) !== undefined) {
			showLens();
			selectTrace();
			return;
		}

		// a variable of the function at the cursor
		let model: FlowModel | undefined;
		try {
			model = await getFlow(client, doc, pos, request.token);
		} catch (error) {
			if (request.token.isCancellationRequested) {
				return;
			}
			log.debug(`flow: ${error}`);
		}
		if (request.token.isCancellationRequested) {
			return;
		}
		const index = model ? variableAt(model, pos.line, pos.character, lineTextOf(doc)) : undefined;
		if (model && index !== undefined) {
			showLens();
			showTrace(doc, model, index, true);
			return;
		}

		// a data member of a class
		let member: MemberModel | undefined;
		try {
			member = await getMember(client, doc, pos, request.token);
		} catch (error) {
			if (request.token.isCancellationRequested) {
				return;
			}
			log.debug(`member: ${error}`);
		}
		if (request.token.isCancellationRequested) {
			return;
		}
		if (member) {
			showLens();
			showMemberTrace(doc.uri.fsPath, doc.uri.toString(), lineTextOf(doc), member, true, true, { file: doc.uri.fsPath, line: pos.line + 1 });
			return;
		}
		if (quiet) {
			deselectTrace();
		} else {
			clearTrace();
			vscode.window.setStatusBarMessage('DataFlow: No variable or data member at the cursor.', 4000);
		}
	};

	// After an edit, gets the flow of the traced function again and finds the variable by its name
	const refreshTrace = async (doc: vscode.TextDocument): Promise<void> => {
		const current = trace;
		const client = engine;
		if (!current || !client || client.currentState !== 'ready') {
			return;
		}
		const version = doc.version;
		try {
			// the line of the function selects the right overload. after an edit, the overload is the nearest one
			const model = await client.flow(current.file, { function: current.fn, line: current.model.function.range.begin.line }, flowOptionsOf(doc.uri));
			if (trace !== current) {
				return;
			}
			flowCache = { file: current.file, version, model };
			const index = findVariable(model, current.name, current.ordinal);
			if (index === undefined) {
				clearTrace();
				return;
			}
			showTrace(doc, model, index, false, store.state.trace?.isSelected ?? true);
		} catch (error) {
			log.debug(`flow refresh: ${error}`);
			if (trace === current) {
				clearTrace();
			}
		}
	};

	// Flow Lens always follows the cursor: it traces the variable at the cursor. A position with no variable keeps the
	// old trace, but no line is dimmed. placeOf gives the cursor when the timer ends.
	const scheduleFollow = (placeOf: () => Place | undefined): void => {
		clearTimeout(followTimer);
		if (store.state.lenses.flow) {
			followTimer = setTimeout(() => {
				const place = placeOf();
				void traceAt(place?.doc, place?.pos, true);
			}, FOLLOW_DELAY_MS);
		}
	};

	// The cursor of the side view moved while no text editor shows its file. The lenses follow it as they follow the
	// cursor of the editor.
	const onSideCursor = (): void => {
		scheduleCursorUpdate(0);
		scheduleFollow(() => side.cursorPlace);
	};

	const logicOptions = (doc: vscode.TextDocument): LogicOptions => {
		return {
			eventFunctions: settingOf<string[]>('dataflow.logic', 'eventFunctions', doc.uri, []),
			nullableFunctions: settingOf<string[]>('dataflow.logic', 'nullableFunctions', doc.uri, []),
			checkFunctions: settingOf<string[]>('dataflow.logic', 'nullCheckFunctions', doc.uri, []),
		};
	};

	// The function of a logic model for a new request after an edit: by its name, so an edit above it does not matter.
	// A lambda goes by its function and its index in the function
	const logicSelector = (model: LogicModel): FunctionSelector => (model.enclosing && model.lambda !== undefined
		? { function: model.enclosing.qualifiedName, line: model.enclosing.range.begin.line, lambda: model.lambda }
		: { function: model.function.qualifiedName, line: model.function.range.begin.line });

	// Asks the engine for the logic model of a function. A newer request cancels the older one. A new model of the same
	// function keeps the choices of the user, also after an edit of a condition
	const loadLogic = async (doc: vscode.TextDocument, fn: FunctionSelector): Promise<void> => {
		const client = engine;
		if (!client || client.currentState !== 'ready' || !store.state.lenses.logic) {
			return;
		}
		logicRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		logicRequest = request;
		try {
			const model = await client.logic(doc.uri.fsPath, fn, logicOptions(doc), request.token);
			if (request.token.isCancellationRequested || !store.state.lenses.logic) {
				return;
			}
			const key = `${doc.uri.fsPath}#${model.function.qualifiedName}`;
			const controls = buildControls(model);
			const chosen = choicesOf.get(key);
			if (logic?.key === key && chosen) {
				choicesOf.set(key, moveChoices(logic.controls, controls, chosen));
			}
			logic = { file: doc.uri.fsPath, uri: doc.uri.toString(), key, model, controls, dom: dominators(model) };
			showLogic();
			followLogic();
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				log.debug(`logic: ${error}`);
			}
		}
	};

	// Why a line (from 1) of the function of Logic Map runs. Undefined if the line is not in the function.
	const whyOf = (line: number): { line: number; items: WhyItem[] } | undefined => {
		const range = logic?.model.function.range;
		if (!logic || !range || line < range.begin.line || line > range.end.line) {
			return undefined;
		}
		const items = whyLine(logic.model, logic.controls, logic.dom, line);
		return items ? { line, items } : undefined;
	};

	// Why the line at the cursor runs, if the cursor is in the function of Logic Map. When the focus is in the side
	// view, the cursor is in the editor of the last change of the cursor, or in the side view with no text editor.
	const whyAt = (): { line: number; items: WhyItem[] } | undefined => {
		const place = currentPlace();
		if (!logic || !place || place.doc.uri.toString() !== logic.uri) {
			return undefined;
		}
		return whyOf(place.pos.line + 1);
	};

	// Why the line at the cursor runs, for the side view
	const whyState = (): LogicPathState['why'] => {
		const why = whyAt();
		return why && {
			line: why.line, items: why.items.map((w) => ({ key: w.key, text: w.text, option: w.option, ...(w.options ? { options: w.options } : {}) })),
		};
	};

	// Evaluates the path, and shows it in the side view. No request to the engine. The path is one path: each control
	// has the choice of the user, or the default option, which runs the most lines.
	const showLogic = (): void => {
		const state = logic;
		const doc = state && vscode.workspace.textDocuments.find((d) => d.uri.toString() === state.uri);
		if (!state || !doc) {
			return;
		}
		const chosen = choicesOf.get(state.key) ?? {};
		const choices = pathChoices(state.model, state.controls, chosen);
		state.path = evaluatePath(state.model, state.controls, choices);
		store.update({
			logicPath: {
				file: state.file, fn: state.model.function, view: buildLogicView(state.model, state.path, lineTextOf(doc)),
				steps: pathSteps(state.model, state.controls, choices, state.path), chosen: Object.keys(chosen), hasCfg: state.model.entry >= 0,
				warnings: logicWarnings(state.model, state.path), why: whyState(),
			},
		});
	};

	const updateWhy = (): void => {
		const current = store.state.logicPath;
		if (logic?.path && current) {
			store.update({ logicPath: { ...current, why: whyState() } });
		}
	};

	// Sets one choice. 'any' removes the choice.
	const setChoice = (key: string, value: string): void => {
		if (!logic) {
			return;
		}
		const choices = { ...(choicesOf.get(logic.key) ?? {}) };
		if (value === ANY) {
			delete choices[key];
		} else {
			choices[key] = value;
		}
		choicesOf.set(logic.key, choices);
		followedLine = undefined;
		showLogic();
	};

	const resetChoices = (): void => {
		if (logic) {
			choicesOf.delete(logic.key);
			followedLine = undefined;
			showLogic();
		}
	};

	// Sets the choices that make a line run. Without a line, the line at the cursor.
	const applyWhy = (line?: number): void => {
		const why = line === undefined ? whyAt() : whyOf(line);
		if (!logic || !why) {
			return;
		}
		const choices = { ...(choicesOf.get(logic.key) ?? {}) };
		why.items.forEach((item) => { choices[item.key] = item.option; });
		choicesOf.set(logic.key, choices);
		showLogic();
	};

	// Logic Map always follows the cursor: if the line at the cursor cannot run on the path, the path gets the choices
	// that make the line run. Each line of the cursor is followed one time. So a choice in the side view stays until the
	// cursor goes to a different line, or until the user clicks the line again.
	const followLogic = (): void => {
		const place = currentPlace();
		if (!logic?.path || !place || place.doc.uri.toString() !== logic.uri) {
			return;
		}
		const line = place.pos.line + 1;
		const key = `${logic.key}:${line}`;
		if (key === followedLine) {
			return;
		}
		followedLine = key;
		if (logic.path.dead.includes(line)) {
			applyWhy(line);
		}
	};

	const clearLogic = (): void => {
		logicRequest?.cancel();
		logic = undefined;
		if (store.state.logicPath) {
			store.update({ logicPath: undefined });
		}
	};

	const costFilter = (): CostFilter => ({
		categories: new Set(settingOf<CostCategory[]>('dataflow.cost', 'categories', undefined, ALL_COST_CATEGORIES)),
		hidden: new Set(context.workspaceState.get<string[]>(HIDDEN_PATTERNS, [])),
	});

	// Asks the engine for the hidden C++ of the file. A newer request cancels the older one.
	const loadCost = async (doc: vscode.TextDocument): Promise<void> => {
		const client = engine;
		if (!client || client.currentState !== 'ready' || !store.state.lenses.cost) {
			return;
		}
		costRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		costRequest = request;
		try {
			const minCopyBytes = settingOf('dataflow.cost', 'minCopyBytes', doc.uri, 16);
			const unit = await unitOfHeader(doc);
			if (request.token.isCancellationRequested) {
				return;
			}
			// a unit that fails, for example with no compile command, gives the items of the header alone
			const model = await client.cost(doc.uri.fsPath, minCopyBytes, request.token, unit).catch((error) => {
				if (!unit || request.token.isCancellationRequested) {
					throw error;
				}
				log.debug(`cost of ${doc.uri.fsPath} in ${unit}: ${error}`);
				return client.cost(doc.uri.fsPath, minCopyBytes, request.token);
			});
			if (request.token.isCancellationRequested || !store.state.lenses.cost) {
				return;
			}
			cost = { file: doc.uri.fsPath, uri: doc.uri.toString(), model };
			showCost();
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				log.debug(`cost: ${error}`);
			}
		}
	};

	// The name and the items of the function at the cursor, for the details column
	const costOfFunction = (current: { file: string; model: CostModel }, filter: CostFilter) => {
		const fn = store.state.file === current.file ? store.state.fn : undefined;
		return functionItems(current.model, filter, fn ? { qualifiedName: fn.qualifiedName, line: fn.range.begin.line } : undefined);
	};

	// The cursor moved in the file of Hidden C++: the side view gets the items of the function at the cursor. The marks of
	// the file stay.
	const updateCostItems = (): void => {
		const layer = store.state.costLayer;
		if (cost && layer) {
			const { fn, items } = costOfFunction(cost, costFilter());
			store.update({ costLayer: { ...layer, fn, items } });
		}
	};

	// Shows the items of the filter in the side view. The filter needs no request to the engine.
	const showCost = (): void => {
		const current = cost;
		if (!current) {
			return;
		}
		const filter = costFilter();
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === current.uri);
		const { fn, items } = costOfFunction(current, filter);
		store.update({
			costLayer: {
				file: current.file, marks: doc ? buildCostMarks(current.model, filter, lineTextOf(doc)) : [], counts: costCounts(current.model, filter),
				enabled: [...filter.categories], fn, items, hidden: filter.hidden.size,
			},
		});
	};

	// Asks the engine for the include hierarchy of the file. The project folders tell which headers are project headers
	const loadIncludes = async (doc: vscode.TextDocument): Promise<void> => {
		const client = engine;
		if (!client || client.currentState !== 'ready' || !store.state.lenses.includes) {
			return;
		}
		includesRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		includesRequest = request;
		const roots = projectRoots();
		try {
			const model = await client.includes(doc.uri.fsPath, roots, request.token);
			if (request.token.isCancellationRequested || !store.state.lenses.includes) {
				return;
			}
			const layer = buildSideIncludes(model, doc.uri.fsPath);
			const lastLine = Math.max(-1, ...(layer?.hints.map((h) => h.line - 1) ?? []));
			includes = { file: doc.uri.fsPath, uri: doc.uri.toString(), lastLine };
			store.update({ includesLayer: layer ?? undefined });
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				log.debug(`includes: ${error}`);
			}
		}
	};

	// Asks the engine for the source files of the compile databases that include a file, for the tab Included by. The
	// first request scans all source files, so the tab shows "scanning" until the answer comes. A later request for the
	// same file keeps the last answer until the new one comes
	const loadIncluders = async (file: string): Promise<void> => {
		const client = engine;
		if (!client || client.currentState !== 'ready' || includersRequest?.file === file) {
			return;
		}
		includersRequest?.source.cancel();
		const request = { file, source: new vscode.CancellationTokenSource() };
		includersRequest = request;
		const last = store.state.includersLayer;
		if (last?.file !== file || last.state !== 'ready') {
			store.update({ includersLayer: { file, state: 'scanning', units: [], unitCount: 0, failed: 0, isUnit: false } });
		}
		const roots = projectRoots();
		try {
			const res = await client.includers(file, roots, request.source.token);
			if (!request.source.token.isCancellationRequested) {
				store.update({ includersLayer: buildSideIncluders(res, file, roots) });
			}
		} catch (error) {
			if (!request.source.token.isCancellationRequested) {
				log.debug(`includers: ${error}`);
				store.update({ includersLayer: { file, state: 'failed', units: [], unitCount: 0, failed: 0, isUnit: false, error: String(error) } });
			}
		} finally {
			if (includersRequest === request) {
				includersRequest = undefined;
			}
		}
	};

	// The roots of the project: the workspace folders and the project that is not open in VS Code
	const projectRoots = (): string[] => {
		const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
		if (store.state.project) {
			roots.push(store.state.project.root);
		}
		return roots;
	};

	// Asks the engine for the call graph of the file. The event functions of Logic Map and the async functions of Change
	// Ripple give the events and the calls on other threads.
	const loadCalls = async (doc: vscode.TextDocument): Promise<void> => {
		const client = engine;
		if (!client || client.currentState !== 'ready' || !store.state.lenses.calls) {
			return;
		}
		callsRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		callsRequest = request;
		try {
			const model = await client.calls(doc.uri.fsPath, {
				eventFunctions: settingOf<string[]>('dataflow.logic', 'eventFunctions', doc.uri, []),
				asyncFunctions: asyncFunctionsOf(doc.uri),
				roots: projectRoots(),
			}, request.token);
			if (request.token.isCancellationRequested || !store.state.lenses.calls) {
				return;
			}
			// a new graph can give the functions different indexes, so the callers in other files come again
			const line = (cursorIn(doc)?.line ?? 0) + 1;
			calls = { file: doc.uri.fsPath, uri: doc.uri.toString(), model, focus: callFunctionAt(model, line), external: new Map() };
			showCalls(doc);
			void loadExternalCallers(calls.focus);
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				log.debug(`calls: ${error}`);
			}
		}
	};

	// Shows the graph with the function at the cursor and the callers in other files
	const showCalls = (doc: vscode.TextDocument): void => {
		const current = calls;
		if (!current) {
			return;
		}
		let layer = buildSideCalls(current.model, current.file, current.focus, lineTextOf(doc));
		for (const [fn, callers] of current.external) {
			layer = addExternalCallers(layer, fn, callers);
		}
		if (callHierarchyFailure) {
			layer = { ...layer, notice: CALL_HIERARCHY_FAILED };
		}
		store.update({ callsLayer: layer });
	};

	// The call hierarchy of VS Code fails if the language server of its provider stops. cpptools 1.34.4 stops with an
	// access violation on a request for some code. VS Code restarts a language server only 5 times in 3 minutes, and
	// then the editor has no IntelliSense. Thus after the first failure, DataFlow does not ask again in this window.
	const failCallHierarchy = (error: unknown): void => {
		if (callHierarchyFailure) {
			return;
		}
		callHierarchyFailure = error instanceof Error ? error.message : String(error);
		log.warn(`The call hierarchy of VS Code failed: ${callHierarchyFailure}. DataFlow does not ask it again in this window, because a request can stop the language server of the C/C++ extension.`);
		const doc = calls && vscode.workspace.textDocuments.find((d) => d.uri.toString() === calls!.uri);
		if (doc) {
			showCalls(doc);
		}
	};

	// Runs a command of the call hierarchy of VS Code. A command gets no answer in CALL_HIERARCHY_MS, or no answer
	// from a provider that is not ready, as undefined. A failed provider rejects the command. A request can stop the
	// server after the time limit, so a late failure counts too. Only one request runs at a time: a provider that is busy
	// with its index gets no second request. With wait, the command waits for the running request first. Else it gets
	// no answer
	const callHierarchyCommand = async <T>(wait: boolean, command: string, ...args: unknown[]): Promise<T | undefined | 'failed'> => {
		if (callHierarchyFailure) {
			return 'failed';
		}
		const running = runningHierarchy;
		if (running) {
			if (!wait) {
				return undefined;
			}
			await withTimeout(running, CALL_HIERARCHY_MS);
			if (callHierarchyFailure) {
				return 'failed';
			}
			if (isHierarchyRunning()) {
				return undefined;
			}
		}
		log.debug(`call hierarchy: ${command}`);
		const request = Promise.resolve(vscode.commands.executeCommand<T | undefined>(command, ...args));
		const settled: Promise<void> = request.then(() => undefined, (error) => failCallHierarchy(error)).finally(() => {
			if (runningHierarchy === settled) {
				runningHierarchy = undefined;
			}
		});
		runningHierarchy = settled;
		try {
			return await withTimeout(request, CALL_HIERARCHY_MS);
		} catch {
			return 'failed';
		}
	};

	// The cursor moved in the file of the graph: a different function gets the hints
	const updateCallFocus = (doc: vscode.TextDocument, line: number): void => {
		const current = calls;
		if (!current) {
			return;
		}
		const focus = callFunctionAt(current.model, line);
		if (focus !== current.focus) {
			current.focus = focus;
			showCalls(doc);
			void loadExternalCallers(focus);
		}
	};

	// Asks the call hierarchy of VS Code for the callers of a function in other files. With no C/C++ extension, there are
	// none. A function with no definition in the file gets no request.
	// A request can stop the language server of the C/C++ extension, so DataFlow asks only while the user looks at the
	// callers: the tab Calls or the graph shows, or the user clicked a function there (isClick).
	// A C/C++ extension that starts with the file has no index yet and gives no answer. The request then comes again
	// after CALL_RETRY_MS, a maximum of CALL_RETRIES times.
	const loadExternalCallers = async (fn: number, attempt = 0, isClick = false): Promise<void> => {
		const current = calls;
		const f = current?.model.functions[fn];
		if (!current || !f || f.where !== 'main' || callHierarchyFailure || (attempt === 0 && current.external.has(fn))) {
			return;
		}
		if (!isClick && (!isCallsShown || !side.isVisible)) {
			current.external.delete(fn); // the next show of the tab or the graph asks again
			return;
		}
		current.external.set(fn, []);
		const callers = await editorIncomingCalls(current.file, f.line, f.col);
		if (calls !== current || callers === 'failed') {
			return;
		}
		if (!callers) {
			const hasProvider = CALL_HIERARCHY_EXTENSIONS.some((id) => vscode.extensions.getExtension(id));
			if (hasProvider && attempt < CALL_RETRIES) {
				setTimeout(() => void loadExternalCallers(fn, attempt + 1, isClick), CALL_RETRY_MS);
			}
			return;
		}
		current.external.set(fn, callers);
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === current.uri);
		if (doc) {
			showCalls(doc);
		}
	};

	const clearCalls = (): void => {
		callsRequest?.cancel();
		calls = undefined;
		if (store.state.callsLayer) {
			store.update({ callsLayer: undefined });
		}
	};

	// Asks the engine for the threads of the file and the data that they share. The async functions of Change Ripple
	// start threads too
	const loadThreads = async (doc: vscode.TextDocument): Promise<void> => {
		const client = engine;
		if (!client || client.currentState !== 'ready' || !store.state.lenses.threads) {
			return;
		}
		threadsRequest?.cancel();
		const request = new vscode.CancellationTokenSource();
		threadsRequest = request;
		try {
			const model = await client.threads(doc.uri.fsPath, { asyncFunctions: asyncFunctionsOf(doc.uri), roots: projectRoots() }, request.token);
			if (request.token.isCancellationRequested || !store.state.lenses.threads) {
				return;
			}
			log.debug(`threads: ${model.threads.length} threads, ${model.items.length} items in ${Math.round(model.analysisMs)} ms${model.cached ? ' (cached)' : ''}`);
			threads = { file: doc.uri.fsPath, uri: doc.uri.toString(), model };
			store.update({ threadsLayer: buildSideThreads(model, doc.uri.fsPath, lineTextOf(doc)) });
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				log.debug(`threads: ${error}`);
			}
		}
	};

	const clearThreads = (): void => {
		threadsRequest?.cancel();
		threads = undefined;
		if (store.state.threadsLayer) {
			store.update({ threadsLayer: undefined });
		}
	};

	const clearIncludes = (): void => {
		includesRequest?.cancel();
		includes = undefined;
		isIncludesDirty = false;
		if (store.state.includesLayer) {
			store.update({ includesLayer: undefined });
		}
	};

	const clearCost = (): void => {
		costRequest?.cancel();
		cost = undefined;
		if (store.state.costLayer) {
			store.update({ costLayer: undefined });
		}
	};

	// "Not useful" hides the pattern of an item, for example all copies of one type, in this workspace
	const setHiddenPatterns = async (patterns: string[]): Promise<void> => {
		await context.workspaceState.update(HIDDEN_PATTERNS, patterns);
		showCost();
	};
	const notUseful = (pattern: string) => setHiddenPatterns([...new Set([...context.workspaceState.get<string[]>(HIDDEN_PATTERNS, []), pattern])]);
	const showHidden = () => setHiddenPatterns([]);

	const setCostCategory = (id: string, enabled: boolean): Thenable<void> => {
		const config = vscode.workspace.getConfiguration('dataflow.cost');
		const categories = new Set<string>(config.get<string[]>('categories', ALL_COST_CATEGORIES));
		if (enabled) {
			categories.add(id);
		} else {
			categories.delete(id);
		}
		return config.update('categories', ALL_COST_CATEGORIES.filter((c) => categories.has(c)), vscode.ConfigurationTarget.Global);
	};

	// The callers of a function from the call hierarchy of VS Code. undefined if no provider answers for C++.
	const editorCallers = async (file: string, fn: EngineFunction): Promise<CallSite[] | undefined> => {
		try {
			const uri = vscode.Uri.file(file);
			const doc = await vscode.workspace.openTextDocument(uri);
			const at = fn.nameAt ?? fn.range.begin;
			const pos = new vscode.Position(at.line - 1, toUtf16Column(doc.lineAt(at.line - 1).text, at.col));
			const items = await callHierarchyCommand<vscode.CallHierarchyItem[]>(true, 'vscode.prepareCallHierarchy', uri, pos);
			if (items === 'failed') {
				return undefined;
			}
			if (!items || items.length === 0) {
				// no item: a provider that finds no function here, or no provider for C++
				return CALL_HIERARCHY_EXTENSIONS.some((id) => vscode.extensions.getExtension(id)?.isActive) ? [] : undefined;
			}
			const calls = await callHierarchyCommand<vscode.CallHierarchyIncomingCall[]>(true, 'vscode.provideIncomingCalls', items[0]);
			if (calls === 'failed') {
				return undefined;
			}
			const out: CallSite[] = [];
			for (const call of calls ?? []) {
				if (call.from.uri.scheme !== 'file') {
					continue;
				}
				const callerDoc = await vscode.workspace.openTextDocument(call.from.uri);
				for (const r of call.fromRanges) {
					out.push({ file: call.from.uri.fsPath, line: r.start.line + 1, col: toUtf8Column(callerDoc.lineAt(r.start.line).text, r.start.character) });
				}
			}
			return out;
		} catch (error) {
			log.debug(`call hierarchy: ${error}`);
			return undefined;
		}
	};

	// The callers of a function from the call hierarchy of VS Code: each calling function with its calls. Lines start at
	// 1, columns are UTF-16 code units from 0. undefined if no provider answers for C++, 'failed' if the provider failed.
	const editorIncomingCalls = async (file: string, line: number, col: number): Promise<ExternalCaller[] | undefined | 'failed'> => {
		try {
			const uri = vscode.Uri.file(file);
			const doc = await vscode.workspace.openTextDocument(uri);
			const pos = new vscode.Position(line - 1, toUtf16Column(doc.lineAt(line - 1).text, col));
			const items = await callHierarchyCommand<vscode.CallHierarchyItem[]>(false, 'vscode.prepareCallHierarchy', uri, pos);
			if (items === 'failed' || !items || items.length === 0) {
				return items === 'failed' ? 'failed' : undefined;
			}
			const incoming = await callHierarchyCommand<vscode.CallHierarchyIncomingCall[]>(true, 'vscode.provideIncomingCalls', items[0]);
			if (incoming === 'failed') {
				return 'failed';
			}
			return (incoming ?? []).filter((c) => c.from.uri.scheme === 'file').map((c) => ({
				name: c.from.name,
				file: c.from.uri.fsPath,
				line: c.from.selectionRange.start.line + 1,
				col: c.from.selectionRange.start.character,
				sites: c.fromRanges.map((r) => ({ line: r.start.line + 1, col: r.start.character })),
			}));
		} catch (error) {
			log.debug(`call hierarchy: ${error}`);
			return undefined;
		}
	};

	// "Show Calls": the calls of the function of the name at a place. The menu of the side view gives the place of the
	// click, else the place is the cursor. The calls in the file come at once from the call graph of the engine. The
	// calls in other files come later from the call hierarchy of VS Code, if a C/C++ extension gives it. A newer list
	// stops the search of an older list
	let callListSeq = 0;
	const showCallList = async (arg?: unknown): Promise<void> => {
		const menu = arg && typeof arg === 'object' ? arg as { line?: unknown; col?: unknown } : undefined;
		const menuDoc = side.document;
		const isFromMenu = !!menu && Number.isInteger(menu.line) && Number.isInteger(menu.col) && !!menuDoc;
		const place = isFromMenu ? { doc: menuDoc!, pos: new vscode.Position(Math.max(0, (menu!.line as number) - 1), menu!.col as number) } : currentPlace();
		const client = engine;
		if (!place || !isCpp(place.doc)) {
			vscode.window.setStatusBarMessage('DataFlow: Put the cursor on the name of a function, or right-click the name in the side view.', 4000);
			return;
		}
		if (!client || client.currentState !== 'ready') {
			vscode.window.setStatusBarMessage('DataFlow: Wait for the engine.', 4000);
			return;
		}
		const doc = place.doc;
		const file = doc.uri.fsPath;
		const lineText = lineTextOf(doc);
		let model: CallGraphModel;
		try {
			model = calls && sameFile(calls.file, file) ? calls.model : await client.calls(file, {
				eventFunctions: settingOf<string[]>('dataflow.logic', 'eventFunctions', doc.uri, []),
				asyncFunctions: asyncFunctionsOf(doc.uri),
				roots: projectRoots(),
			});
		} catch (error) {
			vscode.window.setStatusBarMessage(`DataFlow: The engine gave no calls: ${error}`, 4000);
			return;
		}
		const fn = callTargetAt(model, file, place.pos.line + 1, place.pos.character, lineText);
		if (fn < 0) {
			const word = wordAt(lineText(place.pos.line) ?? '', place.pos.character);
			vscode.window.setStatusBarMessage(`DataFlow: ${word ? `${word} is not a function of this file or of its calls.` : 'No name of a function at the place.'}`, 4000);
			return;
		}
		const seq = ++callListSeq;
		const target = model.functions[fn];
		const own: SideCallListSite[] = callsOf(model, fn, file, lineText).map((c) => ({ ...c, text: (lineText(c.line - 1) ?? '').trim() }));
		const show = (sites: SideCallListSite[], isSearching: boolean, note?: string) => {
			if (seq === callListSeq) {
				side.showCallList({ seq, fn: graphLabels(model)[fn], sites, isSearching, isFromMenu, ...(note ? { note } : {}) });
			}
		};
		if (target.where === 'library') {
			show(own, false, 'A function of a library: the list has only the calls in this file.');
			return;
		}
		if (callHierarchyFailure) {
			show(own, false, CALL_LIST_FAILED);
			return;
		}
		show(own, true);
		const external = await editorIncomingCalls(target.file, target.line, target.col);
		if (external === 'failed') {
			show(own, false, CALL_LIST_FAILED);
			return;
		}
		if (!external) {
			const hasProvider = CALL_HIERARCHY_EXTENSIONS.some((id) => vscode.extensions.getExtension(id));
			show(own, false, hasProvider
				? 'The C/C++ extension gave no calls in other files, for example because its index is not ready. Try again later.'
				: 'No C/C++ extension gives a call hierarchy, so the list has only the calls in this file.');
			return;
		}
		// the calls in other files. The call graph has the calls in this file already
		const texts = new Map<string, Promise<string[]>>();
		const linesOf = (f: string): Promise<string[]> => {
			let lines = texts.get(fileKey(f));
			if (!lines) {
				const open = vscode.workspace.textDocuments.find((d) => sameFile(d.uri.fsPath, f));
				lines = open ? Promise.resolve(open.getText().split(/\r?\n/)) : readFile(f, 'utf8').then((t) => t.split(/\r?\n/), () => []);
				texts.set(fileKey(f), lines);
			}
			return lines;
		};
		const others: SideCallListSite[] = [];
		for (const c of external) {
			if (sameFile(c.file, file)) {
				continue;
			}
			const lines = await linesOf(c.file);
			const caller = `${c.name.replace(/\(.*$/, '')}()`;
			for (const s of c.sites) {
				others.push({ file: c.file, line: s.line, col: s.col, caller, kind: 'other', text: (lines[s.line - 1] ?? '').trim() });
			}
		}
		others.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
		show([...own, ...others], false);
	};

	// Shows the last review in the side view
	const showReview = (): void => {
		if (!review) {
			return;
		}
		const state = buildReviewState(review.model, review.diff.label, review.diff.target);
		if (callHierarchyFailure && review.model.isCallHierarchyMissing) {
			state.notice = 'The call hierarchy of the C/C++ extension stopped with an error. Change Ripple follows only the callers in the same file.';
		}
		store.update({
			review: state,
			rippleLayer: { model: review.model, files: review.diff.files.map((f) => ({ file: f.uri.fsPath, hunks: f.hunks })), base: review.diff.label },
		});
	};

	// The folder of a review: the workspace folder of the file of the editor, the project of DataFlow if the file is in
	// it, or the first workspace folder. A project with no file in an editor also works.
	const reviewFolder = (): vscode.Uri | undefined => {
		const file = currentEditor()?.document.uri ?? side.document?.uri;
		const project = cdb.project;
		const workspaceFolder = file && vscode.workspace.getWorkspaceFolder(file)?.uri;
		if (workspaceFolder) {
			return workspaceFolder;
		}
		if (project && (!file || isInside(file.fsPath, project.root))) {
			return vscode.Uri.file(project.root);
		}
		return vscode.workspace.workspaceFolders?.[0]?.uri ?? (project && vscode.Uri.file(project.root));
	};

	// Compares the files with the base, slices each change, and follows the return values to the callers. An update
	// after a save keeps the shown review until the new review is complete: it does not open the side view, it does not
	// ask for a target branch, and an error keeps the old review
	const runReview = async (isUpdate = false): Promise<RippleModel | undefined> => {
		const shown = review;
		if (isUpdate && (!shown || store.state.review?.isRunning)) {
			return undefined;
		}
		const run = ++reviewRun;
		const client = engine;
		if (!isUpdate) {
			if (!store.state.lenses.review) {
				store.toggleLens('review');
			}
			// the side view shows the story of the review, or the message of an error
			side.open();
			store.update({ sideMode: 'story' });
		}
		const fail = (message: string, target?: string): undefined => {
			if (isUpdate) {
				log.info(`The update of the review failed: ${message}`);
			} else if (run === reviewRun) {
				review = undefined;
				store.update({ review: { isRunning: false, message, target, other: [] }, rippleLayer: undefined });
			}
			return undefined;
		};
		if (!client || client.currentState !== 'ready') {
			return fail('The engine is not ready. Wait for the engine, then review again.');
		}
		const folder = isUpdate && shown ? vscode.Uri.file(shown.root) : reviewFolder();
		if (!folder) {
			return fail('Open a folder of a git repository, or select a project with "DataFlow: Open Project".');
		}

		if (!isUpdate) {
			store.update({ review: { isRunning: true, other: [] }, rippleLayer: undefined });
		}
		const asyncFunctions = settingOf('dataflow.ripple', 'asyncFunctions', folder, DEFAULT_ASYNC_FUNCTIONS);
		vscode.workspace.textDocuments.forEach(flushChange); // the engine gets the text of the editors first
		let target: string | undefined;
		try {
			const repo = await openReviewRepository(folder);
			target = (await selectedTarget(repo)) ?? await automaticTarget(repo, folder);
			if (target === undefined && isUpdate) {
				return fail('The repository has no target branch.');
			}
			if (target === undefined) {
				// the repository has no default branch, no main and no master. The user selects the target branch
				target = await pickTarget(repo) || undefined;
				if (run !== reviewRun) {
					return undefined;
				}
				if (!target) {
					return fail('Change Ripple needs a target branch: the branch that the active branch merges into. '
						+ 'Click Target in the Change Ripple bar, and select the branch.');
				}
				await saveTarget(repo, target);
			}
			const diff = await repo.diff(target);
			// the files go in parallel. Each one keeps a parse of the engine until its ripple is complete, and one parse
			// stays free for the callers in other files
			const cacheSize = Math.min(64, Math.max(1, vscode.workspace.getConfiguration('dataflow').get<number>('engine.cacheSize', 4)));
			const model = await runRipple(diff.files.map((f) => ({ file: f.uri.fsPath, ...f.changes })), {
				slice: (file, seed, confidence) => client.slice(file, seed, asyncFunctions, confidence),
				callers: editorCallers,
				maxDepth: settingOf('dataflow.ripple', 'maxDepth', folder, 2),
				concurrency: Math.max(1, cacheSize - 1),
			});
			if (run !== reviewRun) {
				return undefined;
			}
			review = { model, diff, root: repo.root };
			showReview();
			return model;
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error), target);
		}
	};

	// The target branch that the user selected for the active branch of a repository, by the folder of the repository and
	// the name of the branch. A detached HEAD has the key of the folder
	const targetKey = async (repo: ReviewRepository): Promise<string> => {
		const root = process.platform === 'win32' ? repo.root.toLowerCase() : repo.root;
		const branch = await repo.activeBranch();
		return branch ? `${root}#${branch}` : root;
	};
	const selectedTarget = async (repo: ReviewRepository): Promise<string | undefined> =>
		context.globalState.get<Record<string, string>>(TARGETS_KEY, {})[await targetKey(repo)];
	const saveTarget = async (repo: ReviewRepository, target: string): Promise<void> => {
		const key = await targetKey(repo);
		const targets = { ...context.globalState.get<Record<string, string>>(TARGETS_KEY, {}) };
		if (target) {
			targets[key] = target;
		} else {
			delete targets[key];
		}
		await context.globalState.update(TARGETS_KEY, targets);
	};

	// With no target branch of the user: the first candidate that has a merge base with HEAD
	const automaticTarget = async (repo: ReviewRepository, folder: vscode.Uri): Promise<string | undefined> => {
		const setting = settingOf('dataflow.ripple', 'baseRef', folder, '');
		for (const target of targetCandidates(setting, await repo.defaultBranch(), await repo.branchBase())) {
			if (await repo.mergeBase(target)) {
				return target;
			}
		}
		return undefined;
	};

	// The list of target branches. Undefined if the user closes the list, '' for Automatic.
	const pickTarget = async (repo: ReviewRepository): Promise<string | undefined> => {
		const [branches, defaultBranch, active, selected] = await Promise.all([repo.branches(), repo.defaultBranch(), repo.activeBranch(), selectedTarget(repo)]);
		const pick = await vscode.window.showQuickPick(targetItems(branches, active, defaultBranch, selected), {
			title: 'Target branch of Change Ripple',
			placeHolder: 'Select the branch that the active branch merges into',
			matchOnDescription: true,
		});
		return pick?.ref;
	};

	// The C and C++ files under the paths that the user wants to review, for the guided review of the MCP server, with the
	// changes of each file against the target branch. No ripple runs, and the side view does not change. A path is
	// absolute, or relative to the git repository, to the folder of the review or to a folder of the project. The changed
	// files come first
	const reviewFiles = async (paths: string[]): Promise<ReviewFilesInput | { message: string }> => {
		const folder = reviewFolder();
		if (!folder) {
			return { message: 'Open a folder of the project, or select a project with "DataFlow: Open Project".' };
		}
		let repo: ReviewRepository | undefined;
		try {
			repo = await openReviewRepository(folder);
		} catch {
			// a folder with no git repository: the files have no changes
		}
		const root = repo?.root ?? folder.fsPath;
		const bases = [...new Map([root, folder.fsPath, ...projectRoots()].map((b) => [fileKey(b), b])).values()];
		const found: string[] = [];
		const missing: string[] = [];
		const skipped: string[] = [];
		for (const p of paths) {
			const full = path.isAbsolute(p) ? (existsSync(p) ? p : undefined) : bases.map((b) => path.join(b, p)).find((f) => existsSync(f));
			if (!full) {
				missing.push(p);
			} else if ((await stat(full)).isDirectory()) {
				found.push(...await findProjectFiles(full, MAX_REVIEW_FILES + 1, skipFolders()));
			} else if (isCppFile(full)) {
				found.push(full);
			} else {
				skipped.push(p);
			}
		}
		let target: string | undefined;
		let diff: ReviewDiff | undefined;
		let notice: string | undefined;
		if (!repo) {
			notice = 'The folder has no git repository, so the files have no changes.';
		} else {
			try {
				target = (await selectedTarget(repo)) ?? await automaticTarget(repo, folder);
				if (target) {
					diff = await repo.diff(target);
				} else {
					notice = 'The repository has no target branch, so the files have no changes. "DataFlow: Select Target Branch" selects one.';
				}
			} catch (error) {
				notice = `The changes are not available: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const hunks = new Map((diff?.files ?? []).map((f) => [fileKey(f.uri.fsPath), f.hunks]));
		const files = [...new Map(found.map((f) => [fileKey(f), f])).values()]
			.sort((a, b) => Number(hunks.has(fileKey(b))) - Number(hunks.has(fileKey(a))));
		// the text of an editor, else the file on disk. Only the files of the result need their lines
		const lineCount = async (file: string): Promise<number> => {
			const doc = vscode.workspace.textDocuments.find((d) => fileKey(d.uri.fsPath) === fileKey(file));
			return doc ? doc.lineCount : (await readFile(file, 'utf8')).split(/\r?\n/).length;
		};
		return {
			root, target, base: diff?.label, missing, skipped, notice,
			files: await Promise.all(files.map(async (file, i) => ({
				file, lineCount: i < MAX_REVIEW_FILES ? await lineCount(file) : 0, hunks: hunks.get(fileKey(file)) ?? [],
			}))),
		};
	};

	// Selects the target branch of the repository of the review, then reviews again. The tests give the target. The
	// target '' is Automatic.
	const selectTarget = async (target?: string): Promise<void> => {
		const folder = reviewFolder();
		if (!folder) {
			void vscode.window.showWarningMessage('Open a folder of a git repository, or select a project with "DataFlow: Open Project".');
			return;
		}
		try {
			const repo = await openReviewRepository(folder);
			const picked = target ?? await pickTarget(repo);
			if (picked === undefined) {
				return;
			}
			await saveTarget(repo, picked);
		} catch (error) {
			void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		await runReview();
	};

	const clearReview = (): void => {
		reviewRun++;
		review = undefined;
		clearTimeout(reviewUpdate);
		if (store.state.review || store.state.rippleLayer || store.state.sideMode !== 'file') {
			store.update({ review: undefined, rippleLayer: undefined, sideMode: 'file' });
		}
	};

	// Clear of the user: the side view has no switch for Change Ripple, so Clear also removes the Change Ripple bar
	const closeReview = (): void => {
		clearReview();
		if (store.state.lenses.review) {
			store.toggleLens('review');
		}
	};

	// Opens the diff editor for a file: the file at the base on the left, the working tree on the right. The side view
	// gives the column of its text editor, so the diff editor does not open over the side view.
	const openDiff = async (file: string, viewColumn?: vscode.ViewColumn): Promise<void> => {
		if (review) {
			const uri = vscode.Uri.file(file);
			await vscode.commands.executeCommand('vscode.diff', review.diff.baseUri(uri), uri, `${path.basename(file)}: base to working tree`,
				viewColumn ? { viewColumn } : undefined);
		}
	};

	const toggleLens = (lens: Lens): void => {
		store.toggleLens(lens);
		if (store.state.lenses[lens]) {
			side.open();
		}
		if (lens === 'flow' && !store.state.lenses.flow) {
			clearTrace();
		}
		if (lens === 'logic') {
			if (store.state.lenses.logic) {
				scheduleCursorUpdate(0);
			} else {
				clearLogic();
			}
		}
		if (lens === 'cost') {
			if (store.state.lenses.cost) {
				scheduleCursorUpdate(0);
			} else {
				clearCost();
			}
		}
		if (lens === 'calls') {
			if (store.state.lenses.calls) {
				scheduleCursorUpdate(0);
			} else {
				clearCalls();
			}
		}
		if (lens === 'includes') {
			if (store.state.lenses.includes) {
				scheduleCursorUpdate(0);
			} else {
				clearIncludes();
			}
		}
		if (lens === 'threads') {
			if (store.state.lenses.threads) {
				scheduleCursorUpdate(0);
			} else {
				clearThreads();
			}
		}
		if (lens === 'review') {
			if (store.state.lenses.review) {
				void runReview();
			} else {
				clearReview();
			}
		}
	};

	// Shows Logic Map and the reasons that the line at the cursor runs
	const whyThisLine = async (): Promise<void> => {
		const place = currentPlace();
		if (!place) {
			vscode.window.setStatusBarMessage('DataFlow: Open a C++ file.', 4000);
			return;
		}
		if (!store.state.lenses.logic) {
			store.toggleLens('logic');
		}
		const { doc, pos } = place;
		const fn = store.state.fn;
		if (!logic || !fn || logic.key !== `${doc.uri.fsPath}#${fn.qualifiedName}`) {
			await loadLogic(doc, { line: pos.line + 1, col: toUtf8Column(doc.lineAt(pos.line).text, pos.character) });
		} else {
			updateWhy();
		}
		side.open();
		side.showDetails('logic');
	};

	// A project that is not open in VS Code. cdb/project.ts tells why DataFlow does not open its folder. The quick pick has
	// the files of the project, the selection of a different project, the last projects, and "Close".
	const openProject = async (): Promise<void> => {
		const current = cdb.project;
		type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> };
		const items: Item[] = [];
		if (current) {
			items.push({ label: `$(go-to-file) Open a file of ${current.name}`, run: openProjectFile });
		}
		items.push({ label: '$(folder-opened) Select the folder of a project…', run: selectProjectFolder });
		const recent = cdb.recentProjects.filter((p) => p.root !== current?.root);
		if (recent.length > 0) {
			items.push({ label: 'Last projects', kind: vscode.QuickPickItemKind.Separator });
			items.push(...recent.map((p): Item => ({
				label: `$(history) ${p.name}`, description: p.root, run: async () => { await cdb.setProject(p); await openProjectFile(); },
			})));
		}
		if (current) {
			items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
			items.push({ label: `$(close) Close the project ${current.name}`, run: () => cdb.closeProject() });
		}
		if (items.length === 1) {
			await items[0].run!();
			return;
		}
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'DataFlow uses the project without opening its folder in VS Code' });
		await pick?.run?.();
	};

	const selectProjectFolder = async (): Promise<void> => {
		const uris = await vscode.window.showOpenDialog({
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use for DataFlow',
			title: 'DataFlow: select the folder of the project, or its build folder',
		});
		const folder = uris?.[0]?.fsPath;
		if (!folder) {
			return;
		}
		const pickDb = async (candidates: CompileDbInfo[]) => (await vscode.window.showQuickPick(
			candidates.map((c) => ({ label: path.relative(folder, c.makefile ?? c.path) || c.path, description: c.source, info: c })),
			{ placeHolder: 'Select the compile database for DataFlow' }))?.info;
		if (await cdb.useProject(folder, pickDb)) {
			await openProjectFile();
		}
	};

	// One of the last projects, from the DataFlow view. With no folder, the quick pick of all projects opens.
	const openRecentProject = async (root: string | undefined): Promise<void> => {
		const project = cdb.recentProjects.find((p) => p.root === root);
		if (!project) {
			await openProject();
			return;
		}
		await cdb.setProject(project);
		await openProjectFile();
	};

	// The quick pick of the C and C++ files of the project. The file opens beside the side view.
	const openProjectFile = async (): Promise<void> => {
		const project = cdb.project;
		if (!project) {
			await openProject();
			return;
		}
		const files = await findProjectFiles(project.root, MAX_PROJECT_FILES, skipFolders());
		const pick = await vscode.window.showQuickPick(
			files.map((file) => ({ label: path.basename(file), description: path.relative(project.root, path.dirname(file)), file })),
			{ placeHolder: `Open a file of ${project.name}`, matchOnDescription: true });
		if (pick) {
			await side.openFile(pick.file);
		}
	};

	// The actions of the lenses in the side view. The side view gives the editor of its file.
	const onSideAction = (action: SideAction, editor: vscode.TextEditor | undefined): void => {
		switch (action.type) {
			case 'trace':
				void traceAt(editor?.document ?? side.document, new vscode.Position(action.line - 1, action.col), false);
				break;
			case 'traceVariable': {
				if (memberTrace) {
					void traceField(action.index);
					break;
				}
				const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === trace?.uri);
				if (trace && doc && action.index < trace.model.variables.length) {
					showTrace(doc, trace.model, action.index, true);
				}
				break;
			}
			case 'clearTrace':
				clearTrace();
				break;
			case 'callFocus':
				void loadExternalCallers(action.fn, 0, true);
				break;
			case 'callsShown':
				isCallsShown = action.isShown;
				if (isCallsShown && calls) {
					void loadExternalCallers(calls.focus);
				}
				break;
			case 'includersShown':
				void loadIncluders(action.file);
				break;
			case 'parseMemberFile':
				void parseMemberFile(action.file);
				break;
			case 'parseMemberFiles':
				void parseMemberFiles();
				break;
			case 'toggleLens':
				toggleLens(action.lens);
				break;
			case 'setChoice':
				setChoice(action.key, action.value);
				break;
			case 'resetChoices':
				resetChoices();
				break;
			case 'why': {
				const why = whyOf(action.line);
				side.answerWhy({ line: action.line, items: why?.items.map((w) => ({ key: w.key, text: w.text, option: w.option })) });
				break;
			}
			case 'applyWhy':
				applyWhy(action.line);
				break;
			case 'setCostCategory':
				void setCostCategory(action.id, action.enabled);
				break;
			case 'notUseful':
				void notUseful(action.pattern);
				break;
			case 'showHidden':
				void showHidden();
				break;
			case 'reviewChanges':
				void runReview();
				break;
			case 'clearReview':
				closeReview();
				break;
			case 'openDiff':
				void openDiff(action.file, side.editorColumn());
				break;
			case 'clearModel':
				if (side.file) {
					mcpHost.removeLayer(side.file);
				}
				break;
		}
	};

	// The MCP server: a language model in an MCP client reads the facts of the engine and changes the side view. It
	// starts with the setting dataflow.mcp.enabled, with the command "Start MCP Server", or when the agent mode of VS Code
	// needs it.
	const mcpHost: DataFlowMcpHost = new DataFlowMcpHost({
		engine: () => engine,
		store,
		side,
		currentEditor,
		currentPlace,
		asyncFunctions: (uri) => asyncFunctionsOf(uri),
		readFunctions: (uri) => flowOptionsOf(uri).readFunctions ?? [],
		eventFunctions: (uri) => settingOf<string[]>('dataflow.logic', 'eventFunctions', uri, []),
		minCopyBytes: (uri) => settingOf('dataflow.cost', 'minCopyBytes', uri, 16),
		headerUnit: (doc) => unitOfHeader(doc),
		roots: () => projectRoots(),
		flushChange: (doc) => flushChange(doc),
		trace: async (doc, pos) => {
			// a text editor of the place: the lenses follow its cursor
			const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
			if (editor) {
				cursorEditor = editor;
			}
			await traceAt(doc, pos, false);
		},
		client: (): string | undefined => mcp.clientName,
		incomingCalls: (file, line, col) => editorIncomingCalls(file, line, col),
		reviewFiles: (paths) => reviewFiles(paths),
	});
	const mcp: McpManager = new McpManager(context, store, log, createTools(mcpHost), createPrompts(), () => projectRoots());
	context.subscriptions.push(mcp);

	const startMcp = async (isUserAction: boolean): Promise<void> => {
		try {
			await mcp.start();
			if (isUserAction) {
				void vscode.window.showInformationMessage(`The DataFlow MCP server runs on ${mcp.url}. "DataFlow: Copy MCP Setup" gives the command for Claude Code.`);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`The DataFlow MCP server did not start: ${error}`);
		}
	};
	// The connection to Claude Code with no MCP setup: a local plugin in the settings of Claude Code (mcp/claude.ts)
	const connectClaude = async (): Promise<void> => {
		try {
			await mcp.connectClaude();
			void vscode.window.showInformationMessage('DataFlow is connected to Claude Code. A new Claude Code session gets the tools of DataFlow, '
				+ 'in the VS Code panel, in the terminal and in the desktop app.');
		} catch (error) {
			void vscode.window.showErrorMessage(`DataFlow cannot connect to Claude Code: ${error instanceof Error ? error.message : error}`);
		}
	};
	const disconnectClaude = async (): Promise<void> => {
		try {
			const hadConnection = mcp.disconnectClaude();
			// the user decided, so DataFlow does not offer the connection again
			await context.globalState.update(CLAUDE_OFFER_KEY, 'never');
			void vscode.window.showInformationMessage(hadConnection ? 'DataFlow is no longer connected to Claude Code.'
				: 'DataFlow was not connected to Claude Code.');
		} catch (error) {
			void vscode.window.showErrorMessage(`DataFlow cannot change the settings of Claude Code: ${error instanceof Error ? error.message : error}`);
		}
	};
	// Offers the connection one time if the Claude Code extension is installed and DataFlow is not connected. "Not now"
	// offers it again after CLAUDE_OFFER_MS
	const offerClaudeConnection = async (): Promise<void> => {
		const offer = context.globalState.get<number | 'never'>(CLAUDE_OFFER_KEY);
		if (!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION) || mcp.claudeConnection() !== 'none' || offer === 'never'
			|| (typeof offer === 'number' && Date.now() - offer < CLAUDE_OFFER_MS)) {
			return;
		}
		await context.globalState.update(CLAUDE_OFFER_KEY, Date.now());
		const pick = await vscode.window.showInformationMessage('Connect DataFlow to Claude Code? Claude Code then gets the tools of '
			+ 'DataFlow in all projects, with no MCP setup. DataFlow adds a local plugin to the settings of Claude Code (~/.claude/settings.json).',
			'Connect', 'Not now', 'Do not ask again');
		if (pick === 'Connect') {
			await connectClaude();
		} else if (pick === 'Do not ask again') {
			await context.globalState.update(CLAUDE_OFFER_KEY, 'never');
		}
	};
	const copyMcpSetup = async (): Promise<void> => {
		try {
			await mcp.copySetup(connectClaude);
		} catch (error) {
			void vscode.window.showErrorMessage(`The DataFlow MCP server did not start: ${error}`);
		}
	};
	// a change of the port starts the server again on the new port. The connection to Claude Code keeps the server on
	const applyMcpSettings = async (isPortChange: boolean): Promise<void> => {
		const isEnabled = vscode.workspace.getConfiguration('dataflow').get<boolean>('mcp.enabled', false)
			|| mcp.claudeConnection() === 'connected';
		if (isPortChange && mcp.isRunning) {
			await mcp.stop();
			await startMcp(false);
		} else if (isEnabled && !mcp.isRunning) {
			await startMcp(false);
		} else if (!isEnabled && mcp.isRunning) {
			await mcp.stop();
		}
	};
	const clearModel = (): void => {
		const file = currentEditor()?.document.uri.fsPath ?? side.file;
		if (file) {
			mcpHost.removeLayer(file);
		}
	};

	// A change of the settings: of VS Code, or of the settings file of the project. affects tells if a section changed
	const applySettings = (affects: (section: string) => boolean): void => {
		if (affects('dataflow.compileCommands') || affects('dataflow.engine')) {
			void restartEngine();
		}
		const doc = logic && vscode.workspace.textDocuments.find((d) => d.uri.toString() === logic?.uri);
		if (affects('dataflow.logic') && logic && doc) {
			void loadLogic(doc, logicSelector(logic.model));
		}
		// a new list of read functions changes the roles of the traced variable or member
		const traced = trace ?? memberTrace;
		const tracedDoc = traced && vscode.workspace.textDocuments.find((d) => d.uri.toString() === traced.uri);
		if (affects('dataflow.flow.readFunctions') && tracedDoc) {
			flowCache = undefined;
			void (trace ? refreshTrace(tracedDoc) : refreshMemberTrace(tracedDoc));
		}
		if (affects('dataflow.cost.categories')) {
			showCost();
		}
		const costDoc = cost && vscode.workspace.textDocuments.find((d) => d.uri.toString() === cost?.uri);
		if (affects('dataflow.cost.minCopyBytes') && costDoc) {
			void loadCost(costDoc);
		}
		if (affects('dataflow.ripple') && review) {
			void runReview();
		}
		if (affects('dataflow.mcp')) {
			void applyMcpSettings(affects('dataflow.mcp.port'));
		}
	};

	// The settings file of the project. A change of a setting works as a change of the settings of VS Code
	let projectSettingsWatcher: vscode.FileSystemWatcher | undefined;
	let projectSettingsRoot: string | undefined;
	const watchProjectSettings = (): void => {
		const root = cdb.project?.root;
		if (root === projectSettingsRoot) {
			return;
		}
		projectSettingsWatcher?.dispose();
		projectSettingsWatcher = undefined;
		projectSettingsRoot = root;
		if (!root) {
			return;
		}
		let last = new Map(projectSettings.values(root));
		const onChange = () => {
			const next = projectSettings.values(root);
			const changed = [...new Set([...last.keys(), ...next.keys()])].filter((k) => JSON.stringify(last.get(k)) !== JSON.stringify(next.get(k)));
			last = new Map(next);
			const sections = changed.filter((k) => PROJECT_SECTIONS.some((s) => k.startsWith(`${s}.`)));
			if (sections.length > 0) {
				applySettings((section) => sections.some((k) => k === section || k.startsWith(`${section}.`)));
			}
		};
		const file = ProjectSettings.fileOf(root);
		projectSettingsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
		projectSettingsWatcher.onDidChange(onChange);
		projectSettingsWatcher.onDidCreate(onChange);
		projectSettingsWatcher.onDidDelete(onChange);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('dataflow.openSideView', () => side.open()),
		vscode.commands.registerCommand('dataflow.openProject', () => openProject()),
		vscode.commands.registerCommand('dataflow.openProjectFile', () => openProjectFile()),
		vscode.commands.registerCommand('dataflow.openProjectFolder', () => selectProjectFolder()),
		vscode.commands.registerCommand('dataflow.openRecentProject', (root?: unknown) => openRecentProject(typeof root === 'string' ? root : undefined)),
		vscode.commands.registerCommand('dataflow.closeProject', () => cdb.closeProject()),
		vscode.commands.registerCommand('dataflow.selectCompileCommands', () => cdb.select()),
		vscode.commands.registerCommand('dataflow.unreal.makeCompileDatabase', () => makeUnrealDatabase()),
		vscode.commands.registerCommand('dataflow.restartEngine', () => restartEngine()),
		vscode.commands.registerCommand('dataflow.showLog', () => log.show()),
		vscode.commands.registerCommand('dataflow.traceVariable', () => traceAtCursor(false)),
		vscode.commands.registerCommand('dataflow.clearTrace', () => clearTrace()),
		vscode.commands.registerCommand('dataflow.toggleLogicMap', () => toggleLens('logic')),
		vscode.commands.registerCommand('dataflow.whyThisLine', () => whyThisLine()),
		vscode.commands.registerCommand('dataflow.showCard', () => {
			const place = currentPlace();
			if (place) {
				side.toggleCard(place.doc, place.pos);
			} else {
				vscode.window.setStatusBarMessage('DataFlow: Open a C++ file.', 4000);
			}
		}),
		vscode.commands.registerCommand('dataflow.resetChoices', () => resetChoices()),
		vscode.commands.registerCommand('dataflow.toggleHiddenCpp', () => toggleLens('cost')),
		vscode.commands.registerCommand('dataflow.toggleIncludes', () => toggleLens('includes')),
		vscode.commands.registerCommand('dataflow.toggleThreads', () => toggleLens('threads')),
		vscode.commands.registerCommand('dataflow.toggleCalls', () => toggleLens('calls')),
		// the menu of the side view gives the place of the click as the argument
		vscode.commands.registerCommand('dataflow.showCalls', (arg?: unknown) => showCallList(arg)),
		vscode.commands.registerCommand('dataflow.side.goToDefinition', () => side.goToDefinitionAtCursor()),
		vscode.commands.registerCommand('dataflow.side.back', () => side.goBack()),
		vscode.commands.registerCommand('dataflow.side.forward', () => side.goForward()),
		vscode.commands.registerCommand('dataflow.reviewChanges', () => runReview()),
		vscode.commands.registerCommand('dataflow.clearReview', () => closeReview()),
		// a menu can give an argument of a different type
		vscode.commands.registerCommand('dataflow.ripple.selectTarget', (target?: unknown) => selectTarget(typeof target === 'string' ? target : undefined)),
		vscode.commands.registerCommand('dataflow.mcp.start', () => startMcp(true)),
		vscode.commands.registerCommand('dataflow.mcp.stop', () => mcp.stop()),
		vscode.commands.registerCommand('dataflow.mcp.copySetup', () => copyMcpSetup()),
		vscode.commands.registerCommand('dataflow.claude.connect', () => connectClaude()),
		vscode.commands.registerCommand('dataflow.claude.disconnect', () => disconnectClaude()),
		vscode.commands.registerCommand('dataflow.clearModel', () => clearModel()),
		vscode.commands.registerCommand('dataflow.toggleModelLayers', () => store.update({ isModelShown: !store.state.isModelShown })),
		// the guided review: the same as the buttons of the side view
		vscode.commands.registerCommand('dataflow.guide.next', () => store.state.guide && side.goToGuideStep(store.state.guide.current + 1)),
		vscode.commands.registerCommand('dataflow.guide.previous', () => store.state.guide && side.goToGuideStep(store.state.guide.current - 1)),
		vscode.commands.registerCommand('dataflow.guide.copySummary', () => side.copyGuideSummary()),
		vscode.commands.registerCommand('dataflow.guide.close', () => store.update({ guide: undefined })),
		// The tests use these commands, as the side view does. They are not in the Command Palette.
		vscode.commands.registerCommand('dataflow.logic.setChoice', (key: string, value: string) => setChoice(key, value)),
		vscode.commands.registerCommand('dataflow.cost.notUseful', (pattern: string) => notUseful(pattern)),
		vscode.commands.registerCommand('dataflow.cost.showHidden', () => showHidden()),
		// the first compile database of the folder becomes the database of the project
		vscode.commands.registerCommand('dataflow.project.use', (folder: string) => cdb.useProject(folder, async (candidates) => candidates[0])),
		cdb.onDidChange(() => void restartEngine()),
		vscode.workspace.onDidChangeConfiguration((e) => applySettings((section) => e.affectsConfiguration(section))),
		{ dispose: () => projectSettingsWatcher?.dispose() },
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (!isCpp(doc)) {
				adoptIncludeFile(doc);
				return;
			}
			engine?.didOpen(doc.uri.fsPath, doc.getText(), doc.version);
			// a change of the language opens the document again, but its editor does not become active again
			const editor = vscode.window.activeTextEditor;
			if (editor?.document === doc) {
				cursorEditor = editor;
				scheduleCursorUpdate(0);
			}
			side.onDidSendOpen(doc);
		}),
		// a save of a C or C++ file of the repository of a review updates the review, after REVIEW_UPDATE_MS for more saves
		{ dispose: () => clearTimeout(reviewUpdate) },
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (review && doc.uri.scheme === 'file' && isCppFile(doc.uri.fsPath) && isInside(doc.uri.fsPath, review.root)) {
				clearTimeout(reviewUpdate);
				reviewUpdate = setTimeout(() => void runReview(true), REVIEW_UPDATE_MS);
			}
		}),
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (!isCpp(e.document)) {
				return;
			}
			// Send the text after a short pause in the typing, not after each key.
			const file = e.document.uri.fsPath;
			const current = includes;
			if (current?.file === file && e.contentChanges.some((c) => c.range.start.line <= current.lastLine || c.text.includes('#'))) {
				isIncludesDirty = true;
			}
			// the blocks and the notes of the model, and the steps of the guided review, move with their code
			if (!mcpHost.moveLayer(file, e.contentChanges)) {
				log.info(`The blocks and the notes of the model in ${path.basename(file)} went away, because an edit replaced all their lines.`);
			}
			const guide = store.state.guide;
			const movedGuide = guide && moveGuide(guide, file, e.contentChanges);
			if (movedGuide && movedGuide !== guide) {
				store.update({ guide: movedGuide });
			}
			clearTimeout(changeTimers.get(file));
			changeTimers.set(file, setTimeout(() => sendChange(e.document), 250));
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			if (isCpp(doc)) {
				engine?.didClose(doc.uri.fsPath);
			}
			if (trace?.uri === doc.uri.toString()) {
				clearTrace();
			}
			if (logic?.uri === doc.uri.toString()) {
				clearLogic();
			}
			if (includes?.uri === doc.uri.toString()) {
				clearIncludes();
			}
			if (calls?.uri === doc.uri.toString()) {
				clearCalls();
			}
			if (threads?.uri === doc.uri.toString()) {
				clearThreads();
			}
			if (cost?.uri === doc.uri.toString()) {
				clearCost();
			}
		}),
		vscode.window.onDidChangeTextEditorSelection((e) => {
			if (isCpp(e.textEditor.document)) {
				cursorEditor = e.textEditor;
			}
			scheduleCursorUpdate();
			scheduleFollow(() => ({ doc: e.textEditor.document, pos: e.textEditor.selection.active }));
		}),
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && isCpp(editor.document)) {
				cursorEditor = editor;
			}
			scheduleCursorUpdate(0);
		}),
		{ dispose: () => { clearTimeout(cursorTimer); clearTimeout(followTimer); changeTimers.forEach((t) => clearTimeout(t)); } },
	);

	// a restart waits for the first start
	restarting = startEngine();
	if (vscode.workspace.getConfiguration('dataflow').get<boolean>('mcp.enabled', false)) {
		void startMcp(false);
	}
	// a connection to Claude Code starts the server, and a window with no connection can offer it
	void mcp.refreshClaude().then(() => offerClaudeConnection(), (error) => log.warn(`The connection to Claude Code is not available: ${error}`));

	// the commands of the guided review show in the Command Palette only while a guide shows
	let isGuideShown = false;
	context.subscriptions.push(store.onDidChange((state) => {
		if (!!state.guide !== isGuideShown) {
			isGuideShown = !!state.guide;
			void vscode.commands.executeCommand('setContext', 'dataflow.guideActive', isGuideShown);
		}
	}));

	// the blocks and the notes of a model, and the guided review, of the last session of the workspace
	const layers = new LayerKeeper(context.workspaceState, store, log);
	context.subscriptions.push(layers);
	layers.restore();
	return { store, side, home, mcp, mcpHost, layers };
}

// VS Code calls this function when it deactivates the extension.
// The items in context.subscriptions stop the engine, so this function is empty.
export function deactivate() {}

// The engine: the setting, then the engine in the package, then the development build.
function resolveEnginePath(context: vscode.ExtensionContext): string | undefined {
	const exe = process.platform === 'win32' ? 'dataflow-engine.exe' : 'dataflow-engine';
	const setting = vscode.workspace.getConfiguration('dataflow').get<string>('engine.path');
	const candidates = [
		...(setting ? [setting] : []),
		path.join(context.extensionPath, 'engine', 'bin', exe),
		path.join(context.extensionPath, 'build', 'engine', exe),
	];
	return candidates.find((c) => existsSync(c));
}

// The value of a thenable, or undefined after the time limit
function withTimeout<T>(value: Thenable<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
	return Promise.race([Promise.resolve(value), limit]).finally(() => clearTimeout(timer));
}

// Animations are on if the setting is on and VS Code does not reduce motion
function animationsOn(): boolean {
	const config = vscode.workspace.getConfiguration();
	return config.get<string>('dataflow.animations') === 'on' && config.get<string>('workbench.reduceMotion') !== 'on';
}
