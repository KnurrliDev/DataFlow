# Use the API for extensions

DataFlow has an API for other VS Code extensions. An extension can read the data of the engine and of the lenses, and it can change the side view. The API has the same tools as the [MCP server](tools.md), and events for the changes of the state of DataFlow.

Examples of extensions that can use the API:

- A test extension shows the path of Logic Map through the function of a test that failed.
- A review extension reads the code that a change reaches with Change Ripple, and walks the user through it in a guided review.
- A status bar extension shows the heat of the function at the cursor.

- [Get the API](#get-the-api)
- [The methods](#the-methods)
- [The events](#the-events)
- [Guides](#guides)
- [Buttons](#buttons)
- [Tools for the MCP server](#tools-for-the-mcp-server)
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

Each client has its own layers in each file: its blocks, notes, comments and details. The view methods change only the layers of your client. The layers of other extensions and of MCP clients stay. Thus use a name that other extensions do not use.

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
| `getDiff({ base, paths, allFiles })` | [`get_diff`](tools.md#get_diff) | read |
| `showBlocks({ file, function, line, blocks })` | [`show_blocks`](tools.md#show_blocks) | view |
| `showFlow({ file, line, name })` | [`show_flow`](tools.md#show_flow) | view |
| `showLogicPath({ file, function, line, choices })` | [`show_logic_path`](tools.md#show_logic_path) | view |
| `showLine({ file, line })` | [`show_line`](tools.md#show_line) | view |
| `highlight({ file, ranges, append })` | [`highlight`](tools.md#highlight) | view |
| `commentLines({ file, comments, append })` | [`comment_lines`](tools.md#comment_lines) | view |
| `addDetail({ file, line, expression, title, text, actions })` | [`add_detail`](tools.md#add_detail) | view |
| `clear({ file })` | [`clear`](tools.md#clear) | view |
| `remove({ file, ids })` | [`remove`](tools.md#remove) | view |
| `setLens({ lens, on })` | [`set_lens`](tools.md#set_lens) | view |
| `clearFlow()` | [`clear_flow`](tools.md#clear_flow) | view |
| `startRipple({ base, paths })` | [`start_ripple`](tools.md#start_ripple) | view |
| `clearRipple()` | [`clear_ripple`](tools.md#clear_ripple) | view |
| `markBase({ name, paths })` | [`mark_base`](tools.md#mark_base) | view |
| `deleteMark({ name })` | [`delete_mark`](tools.md#delete_mark) | view |
| `scanCallGraph()` | [`scan_call_graph`](tools.md#scan_call_graph) | view |
| `stopCallGraph()` | [`stop_call_graph`](tools.md#stop_call_graph) | view |
| `showReviewPlan({ id, title, summary, steps })` | [`show_review_plan`](tools.md#show_review_plan) | view |
| `showDiffWalk({ id, title, summary, steps, allHunks })` | [`show_diff_walk`](tools.md#show_diff_walk) | view |
| `reviewStep({ id, step, note, status, label, data, force })` | [`review_step`](tools.md#review_step) | view |
| `closeGuide({ id, kind, force })` | [`close_guide`](tools.md#close_guide) | view |

The read methods do not change the view. The view methods change the side view that the user looks at. Use them only when the user asks your extension for it, for example with a command or a button.

The results of `highlight`, `commentLines` and `addDetail` give the ids of the new items, for example `n1`, `c1` and `d1`. `remove` removes items of your client by their ids.

`callTool(name, args)` runs a tool by its name, for example `callTool('get_view')`. `tools` gives the name, the description and the JSON schema of the arguments of each tool. `tools` and `callTool` use only the tools of DataFlow, not the tools of extensions.

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
| `onDidChangeGuide` | The guide that shows changes: the top guide of the stack. See [Guides](#guides). | The guide as `get_view` gives it in `review`, with `change` and `by`, or `null` if no guide shows |
| `onDidChangeCallGraph` | The scan of the call graph starts, makes progress, stops or ends. | The data of `scan_call_graph` |
| `onDidInvokeAction` | The user clicks a button of your extension. See [Buttons](#buttons). | `kind`, `action`, `item`, `file`, `line` and `step` |
| `onDidParse` | The engine parsed a file again. After each edit of the active file, the engine parses it about 250 ms after the last key. Ask for new facts of the file after this event. | `file`, `parseMs`, `errorCount`, the first 5 `errors`, and `isFailed` if the engine could not parse the file |

At the end of a scan of the call graph, the heat of the functions can change. Then call `getHeat` again.

Each subscription to an event gives a disposable. Add it to the subscriptions of your extension:

```ts
context.subscriptions.push(api.onDidChangeView((view) => console.log(view.file, view.function?.name, view.line)));
```

## Guides

The side view keeps a stack of up to 5 guides: the guided reviews and the diff walks of the user, of MCP clients and of extensions. The top guide shows. [More than one guide](tools.md#more-than-one-guide) tells what the user sees.

- `showReviewPlan` and `showDiffWalk` put a new guide on the top. The result gives its `id`, for example `g3`. With the `id` of a guide of your client, the new plan replaces that guide at its place in the stack. With 5 guides in the stack, a new guide fails.
- `reviewStep` and `closeGuide` use the top guide, or the guide with the `id`. A guide under the top guide changes at its place, and the view stays on the top guide.
- A note, a mark, a label, data or a close on a guide of the user or of a different client fails, except with `force: true`. Use `force` only when the user asks your extension for it.
- A step can be in each text file of the project, or in a new file with `newFile`. A step can have a `label`, which the tab Guide shows, and `data`, which DataFlow keeps for your extension.
- `getView` gives the top guide in `review` with the marks and the notes of the user, and the stack in `guides`.

`onDidChangeGuide` comes for each change of the guide that shows. `change` gives the cause, and `by` gives `user` or the name of the client:

| `change` | Cause |
| --- | --- |
| `start` | A new guide went on the top. |
| `replace` | A plan replaced the top guide. |
| `step` | A different step shows. |
| `mark` | The mark of a step changed. |
| `note` | The note of a client on a step changed. |
| `userNote` | The note of the user on a step changed. |
| `label` | The label or the data of a step changed. |
| `move` | An edit moved the lines of steps. |
| `close` | The top guide closed. The event gives the guide under it, or `null` if no guide is left. |
| `show` | The user brought a guide of the stack to the top. |

A change of a guide under the top guide gives no event.

## Buttons

Your extension can put buttons on its notes, its details and the steps of its guides:

- A range of `highlight`, a detail of `addDetail`, and a step of `showReviewPlan` or `showDiffWalk` can have the field `actions`. It is a list of a maximum of 3 buttons.
- Each button has an `id` with a maximum of 64 characters and a `title` with a maximum of 40 characters. The buttons of one item must have different ids.
- The side view shows the buttons in the bar MODEL, in the tab Model, in the card of a detail and in the tab Guide.
- A click on a button sends `onDidInvokeAction` to the API objects of your client only.

An MCP client cannot add buttons, because it gets no event for a click. The tools of the MCP server refuse `actions`.

The event has these fields:

| Field | Function |
| --- | --- |
| `kind` | `note`, `detail` or `step` |
| `action` | The `id` of the button |
| `item` | The id of the note or of the detail, for example `n2` or `d1` |
| `file` | The file of the item or of the step |
| `line` | The first line of the item or of the step |
| `step` | The number of the step, from 1 |

The layers and the guide come back after a reload of the window, with their buttons. If the user clicks a button before your extension gets the API again, the status bar tells the user that your extension is not active.

```ts
const file = 'src/battery.cpp';
await api.highlight({
	file,
	ranges: [{ lines: [102, 102], kind: 'warning', note: 'The solver can block here.', actions: [{ id: 'fix', title: 'Fix it' }] }],
	append: true,
});
context.subscriptions.push(api.onDidInvokeAction(async (e) => {
	if (e.kind === 'note' && e.action === 'fix' && e.item) {
		await api.remove({ file: e.file ?? file, ids: [e.item] });
	}
}));
```

## Tools for the MCP server

Your extension can add its own tools to the [MCP server](tools.md) of DataFlow. A client of the server, for example Claude Code, then gets your tools with the tools of DataFlow through one connection.

```ts
context.subscriptions.push(api.registerTools([{
	name: 'get_brief',
	title: 'Get the brief',
	description: 'Gives the brief of the current task.',
	inputSchema: { type: 'object', properties: { stage: { type: 'string' } } },
	isReadOnly: true,
	call: async (args) => ({ stage: args.stage ?? 'brief', text: await readBrief() }),
}]));
```

- The MCP name of a tool is the name of your client in lowercase, then `_`, then the name of the tool, for example `my_extension_get_brief`. A character of the name of the client that is not a letter or a digit becomes `_`.
- The name of a tool can have only letters, digits and `_`. The MCP name has a maximum of 64 characters. A name that the server has already gives an error.
- The server puts the name of your client before the description of each tool.
- `inputSchema` is a JSON Schema with `"type": "object"`. DataFlow does not check the arguments against it.
- `call` gets the arguments of the client. A text goes to the client as it is, and a different value goes as JSON. An error of `call` goes to the client as an error result with its message.
- All tools of one call must be correct. Else no tool goes in, and `registerTools` throws an error with each problem.
- The result of `registerTools` removes the tools. Add it to the subscriptions of your extension.
- `isReadOnly` and `isDestructive` give the hints of the tool for the client. The defaults are `false`.

After a change of the tools, the bridge of DataFlow tells Claude Code that the list of the tools changed, and Claude Code gets the new list. The agent mode of VS Code gets a new version of the server. A client that connects to the address of the server with no bridge gets the new tools only at its next request for the list.

The token of the MCP server protects your tools, as it protects the tools of DataFlow. Your tools run in your extension.

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
