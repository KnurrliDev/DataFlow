# Use the API for extensions

DataFlow has an API for other VS Code extensions. An extension can read the data of the engine and of the lenses, and it can change the side view. The API has the same tools as the [MCP server](tools.md), and events for the changes of the state of DataFlow.

Examples of extensions that can use the API:

- A test extension shows the path of Logic Map through the function of a test that failed.
- A review extension reads the code that a change reaches with Change Ripple, and walks the user through it in a guided review.
- A status bar extension shows the heat of the function at the cursor.

- [Get the API](#get-the-api)
- [The methods](#the-methods)
- [The events](#the-events)
- [Errors](#errors)
- [Versions](#versions)
- [Examples](#examples)

## Get the API

1. Copy the file [`api/dataflow-api.d.ts`](../api/dataflow-api.d.ts) into your extension. The file has the types of the API. The VSIX package of DataFlow has the same file in the folder `api` of the extension.
2. Add DataFlow to the `extensionDependencies` of the `package.json` file of your extension. VS Code then starts DataFlow before your extension. DataFlow comes as a VSIX file, so the users of your extension must install DataFlow first. [Install DataFlow](install.md) tells how.

   ```json
   "extensionDependencies": ["KnurrliDev.dataflow"]
   ```

   If DataFlow is optional for your extension, do not add it. Then make sure in the code that DataFlow is installed.
3. Get the API in the `activate` function of your extension:

   ```ts
   import * as vscode from 'vscode';
   import type { DataFlowApi, DataFlowExports } from './dataflow-api';

   export async function activate(context: vscode.ExtensionContext): Promise<void> {
   	const dataflow = vscode.extensions.getExtension<DataFlowExports>('KnurrliDev.dataflow');
   	if (!dataflow) {
   		return; // DataFlow is not installed
   	}
   	const api: DataFlowApi = (await dataflow.activate()).getApi(1, { client: 'my-extension' });
   	const view = await api.getView();
   }
   ```

`client` is the name of your extension. The side view shows it on the blocks, the notes, the comments, the details and the guides of your extension. The default is `extension`. The log of DataFlow tells when an extension gets the API.

Each call of `getApi` gives a new API object. `showReviewPlan` uses the result of the last `getReview` of the same API object, and `showDiffWalk` uses the result of the last `getDiff` of the same API object.

The API has no token. All extensions in VS Code can get it, as they can read the files of the project. Install only extensions that you trust.

## The methods

Each method runs a tool of the MCP server, with the same arguments and the same data. [The tools](tools.md#the-tools) tells the parameters and the data of each tool. A method gives an object, not a JSON text. Lines start at 1.

| Method | Tool | Kind |
| --- | --- | --- |
| `getView()` | [`get_view`](tools.md#get_view) | read |
| `listFunctions({ file })` | [`list_functions`](tools.md#list_functions) | read |
| `getStructure({ file, function, line })` | [`get_structure`](tools.md#get_structure) | read |
| `getFlow({ file, line, name })` | [`get_flow`](tools.md#get_flow) | read |
| `getCalls({ file, function, line })` | [`get_calls`](tools.md#get_calls) | read |
| `getCallers({ file, function, line, depth })` | [`get_callers`](tools.md#get_callers) | read |
| `getThreads({ file })` | [`get_threads`](tools.md#get_threads) | read |
| `getHidden({ file, function, line })` | [`get_hidden`](tools.md#get_hidden) | read |
| `getIncludes({ file })` | [`get_includes`](tools.md#get_includes) | read |
| `getOutline({ file, name, line })` | [`get_outline`](tools.md#get_outline) | read |
| `getHeat({ file, function, lines })` | [`get_heat`](tools.md#get_heat) | read |
| `getCallGraph()` | [`get_call_graph`](tools.md#get_call_graph) | read |
| `getLogic({ file, function, line, choices })` | [`get_logic`](tools.md#get_logic) | read |
| `getRipple()` | [`get_ripple`](tools.md#get_ripple) | read |
| `getReview({ paths })` | [`get_review`](tools.md#get_review) | read |
| `getDiff({ base, paths })` | [`get_diff`](tools.md#get_diff) | read |
| `showBlocks({ file, function, line, blocks })` | [`show_blocks`](tools.md#show_blocks) | view |
| `showFlow({ file, line, name })` | [`show_flow`](tools.md#show_flow) | view |
| `showLogicPath({ file, function, line, choices })` | [`show_logic_path`](tools.md#show_logic_path) | view |
| `showLine({ file, line })` | [`show_line`](tools.md#show_line) | view |
| `highlight({ file, ranges, append })` | [`highlight`](tools.md#highlight) | view |
| `commentLines({ file, comments, append })` | [`comment_lines`](tools.md#comment_lines) | view |
| `addDetail({ file, line, expression, title, text })` | [`add_detail`](tools.md#add_detail) | view |
| `clear({ file })` | [`clear`](tools.md#clear) | view |
| `setLens({ lens, on })` | [`set_lens`](tools.md#set_lens) | view |
| `clearFlow()` | [`clear_flow`](tools.md#clear_flow) | view |
| `startRipple()` | [`start_ripple`](tools.md#start_ripple) | view |
| `clearRipple()` | [`clear_ripple`](tools.md#clear_ripple) | view |
| `scanCallGraph()` | [`scan_call_graph`](tools.md#scan_call_graph) | view |
| `stopCallGraph()` | [`stop_call_graph`](tools.md#stop_call_graph) | view |
| `showReviewPlan({ title, summary, steps })` | [`show_review_plan`](tools.md#show_review_plan) | view |
| `showDiffWalk({ title, summary, steps, allHunks })` | [`show_diff_walk`](tools.md#show_diff_walk) | view |
| `reviewStep({ step, note, status })` | [`review_step`](tools.md#review_step) | view |
| `closeGuide({ kind })` | [`close_guide`](tools.md#close_guide) | view |

The read methods do not change the view. The view methods change the side view that the user looks at. Use them only when the user asks your extension for it, for example with a command or a button.

`callTool(name, args)` runs a tool by its name, for example `callTool('get_view')`. `tools` gives the name, the description and the JSON schema of the arguments of each tool.

These properties give the state:

| Property | Function |
| --- | --- |
| `version` | The version of the API: `1`. |
| `engineState` | The state of the engine: `stopped`, `starting`, `ready` or `failed`. The methods that use the engine need `ready`. |
| `engineError` | The reason of the state `failed`, or of the state `stopped` with no compile database. Else `undefined`. |
| `compileDatabases` | The compile databases of the engine. |

## The events

| Event | When | Data |
| --- | --- | --- |
| `onDidChangeEngineState` | The engine starts, is ready, stops or fails, or the compile databases change. | `state`, `compileDatabases`, and `error` as in `engineError` |
| `onDidChangeView` | The file, the function or the line at the cursor changes. The cursor is the cursor of the active C++ editor, or the cursor of the side view if no C++ editor shows. The event comes after the engine found the function at the cursor. | `file`, `function` with its `name` and its `lines`, and `line` |
| `onDidChangeGuide` | A guided review or a diff walk starts, goes to a step, gets a mark or a note, or closes. | The guide as `get_view` gives it in `review`, or `null` after the close |
| `onDidChangeCallGraph` | The scan of the call graph starts, makes progress, stops or ends. | The data of `scan_call_graph` |

At the end of a scan of the call graph, the heat of the functions can change. Then call `getHeat` again.

Each subscription to an event gives a disposable. Add it to the subscriptions of your extension:

```ts
context.subscriptions.push(api.onDidChangeView((view) => console.log(view.file, view.function?.name, view.line)));
```

## Errors

A method that fails rejects its promise with an `Error`. The message tells the reason. Examples:

- The engine is not ready. Wait for `onDidChangeEngineState` with the state `ready`. `engineError` tells why the engine does not run.
- The file is not in the project. The tools read only the files of the project that is open in VS Code.
- An argument is not correct, for example a line after the end of the file or a key of `choices` that the function does not have. A view method then does not change the view.

## Versions

`getApi(1)` gives version 1 of the API. A later version of DataFlow can add methods, events and fields to version 1. A change that removes or changes a method, an event or a field comes in a new version. `getApi` with a version that DataFlow does not know throws an error.

## Examples

Show the path of Logic Map through `process()` for the first option of its else-if chain:

```ts
const file = 'src/battery.cpp';
const logic = await api.getLogic({ file, function: 'process' });
const chain = logic.decisions.find((d) => d.kind === 'chain');
if (chain) {
	await api.showLogicPath({ file, function: 'process', choices: { [chain.key]: chain.options[0] } });
}
```

Show the heat score of the function at the cursor in the status bar. The heat of a file takes some time, so the example asks for it only when the function changes:

```ts
const item = vscode.window.createStatusBarItem();
let shown = '';
context.subscriptions.push(item, api.onDidChangeView(async (view) => {
	const key = `${view.file}#${view.function?.name}`;
	if (key === shown) {
		return; // the cursor moved in the same function
	}
	shown = key;
	if (!view.file || !view.function) {
		item.hide();
		return;
	}
	const heat = await api.getHeat({ file: view.file, function: view.function.name }).catch(() => undefined);
	const fn = heat?.functions[0];
	item.text = fn ? `Heat ${fn.score} (${fn.band})` : '';
	item.show();
}));
```

Run Change Ripple, and give the callers that a change reaches:

```ts
const ripple = await api.startRipple();
const callers = (ripple.changes ?? []).flatMap((c) => c.bodies.filter((b) => b.depth > 0).map((b) => `${b.function} (${b.file}:${b.call?.line})`));
```
