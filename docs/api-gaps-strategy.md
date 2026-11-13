# Gaps of the API for a client extension: implementation strategy

This document tells how to remove the 29 gaps that a client extension found in version 1 of the API for extensions (DataFlow 0.5.0). The client extension is a VS Code extension in which the user and a language model write code together. It gets the API with `getApi(1, { client })`, and its model uses the MCP server of DataFlow. The numbers of the items are the numbers of the gap list of the client extension.

Section 2 gives the decisions of the user. Section 12 lists the statements of the gap list that this check corrected.

## 1. Goal and scope

All 29 items are possible. The work has 8 phases (section 10). Each phase is a commit, with its tests, its documents and its changelog items.

| Area | Items | Engine work |
| --- | --- | --- |
| Guides | 1, 2, 3, 4, 5, 6, 7, 28 | No |
| Heat | 8, 9, 10, 11, 14, 15, 16 | 11, 14, 15 and 16 |
| Places and calls | 12, 13, 24, 29 | 12, 13 and 24 |
| Blocks, notes, comments and details | 17, 18, 19, 20 | No |
| Diff walk and Change Ripple | 21, 22, 23 | No |
| API and MCP server | 25, 26, 27 | 26 |

Terms of this document:

- A client is an MCP client, for example Claude Code, or an extension that uses the API.
- The owner of an item is the client that made it. The owner of an item of a command of DataFlow is the user, for example of the diff walk of **DataFlow: Walk Through the Changes**.

These items are not in the scope:

- Facts for code that is not C or C++ code. Item 28 asks only for a place in such a file.
- A score for a line. Item 12 gives the facts of a line, not a score.
- Custom HTML in the side view. Item 20 accepts only a simple content model.

## 2. Decisions of the user

1. Unknown callers (item 15): facts only. If the call graph cannot see all callers of a function, the function does not get the half points of a siloed function. It gets a reason with 0 points, and the flag `reachUnknown` with its cause. DataFlow does not change its score in another way. The client maps the flag to its own risk level.
2. Owner of a guide (items 1 and 2): `review_step` and `close_guide` refuse a guide of a different owner. With `force: true`, they accept it. The MCP descriptions tell the model to use `force` only when the user asks for it.
3. Tab of an extension (item 20): in the scope, as the last phase, with a simple content model.
4. Order of the work: the risk first. Section 10 gives the phases. An item of a lower group of the gap list goes into the phase of its code. Thus no phase changes the same code two times.

These decisions are proposals of this document. The user can change them before the phase starts:

5. A plan has a maximum of 40 steps, as a diff walk. Sections in a guide are not necessary (item 7).
6. The guide stack keeps a maximum of 5 guides (item 1).
7. Actions (buttons) are only for extensions. An MCP client has no channel for the event of a click (item 19).
8. A mark keeps a copy of the text of the files in the storage folder of the workspace. It stays after a reload of the window (item 21).

## 3. Compatibility

All changes add methods, events, parameters and fields to version 1 of the API. Three changes also correct the effect of methods that are there:

- A new guide does not replace a guide of a different owner (item 1).
- `review_step` and `close_guide` refuse a guide of a different owner without `force` (item 2).
- `clear`, `highlight` and `comment_lines` change only the layers of their client (item 17).

Before these fixes, a client can remove the items of a different client. Thus the three changes are fixes, and they keep version 1. The changelog tells each change. The version policy of `docs/api.md` stays as it is.

The types of `api/dataflow-api.d.ts` stay the source of the data. Each new result gets its type there, and the host gives its data in this type, so the compiler finds a difference.

## 4. Shared parts

### 4.1 The owner of an item

The store gets one type for an owner: `'user'`, or the name of a client. The host of the MCP server uses the name of the MCP client (`McpManager.clientName`). The host of an API object uses its `client`. Guides, layers, marks, actions and tools of extensions all use this type.

Limit: the MCP server keeps only the name of the client that connected last. If two MCP clients use one window at the same time, both get the name of the last client. This limit is there today. A fix needs the session of each request of the MCP server.

### 4.2 Actions and the event of a click

Items 19 and 20 use one mechanism:

- An item gets `actions`: a maximum of 3 buttons, each with an `id` and a `title`.
- A click in the side view sends a message to the extension. The message has the owner, the kind of the item and the `id` of the action. It also has the file and the line, or the step, or the tab.
- `ApiEvents` sends the event `onDidInvokeAction` only to the API objects of the owner.
- If no API object of the owner is active, the side view shows "The extension is not active", and no event goes out.

### 4.3 The project index

Items 11, 15 and 24 need more data from the scan of the call graph (`engine/include/dataflow/callgraph.hpp`). Items 13 and 14 use the graph as it is. The scan walks each body one time already (`GraphCallWalker`). The same walk records:

- the functions whose address the body uses (item 15)
- the connections of Qt signals to slots (item 15)
- the data members and the global variables that the body reads or writes (items 11 and 24)
- the `switch` statements on an enum, with the enumerators that they handle and a flag for `default` (item 24)

The index stores each USR one time and refers to it with a number, so the memory stays small. The update after a save parses only the source files that include a changed file, as now.

## 5. Phase A: quick fixes

Items 8, 9, 10, 22, 27 and 29, and the frame path of item 13. No engine change.

### 5.1 Item 9: the reach is complete

- `HeatFunction` in `src/lenses/heat.ts` gets `isReachComplete`: true if the metrics of the engine give a reach for the function.
- `get_heat` gives it for each function, and `isReachComplete` for the file.
- `changedFunctions` and `hottestChanges` of `get_review` and `get_diff` give it too.

### 5.2 Item 8: the signals of the heat

- `HeatReason` gets `id` and `value`. `buildHeat` sets them where it makes each reason.
- `get_heat` gives `signals` for each function: `id`, `group`, `points`, `text` and `value`. `reasons` stays for the model.

| `id` | `value` |
| --- | --- |
| `framePath` | The reason of the frame function, the path as a list of function names, the number of calls, and `isInLoop` |
| `frameLoop` | true |
| `callers` | The number of the transitive callers, and `isCapped` |
| `callerFiles` | The number of the files of the callers |
| `includeReach` | The source files that include the declaration, and all source files |
| `virtual` | `override` or `virtual` |
| `decisions`, `depth`, `length` | The number |
| `writes` | The names of the written shared data |
| `sharedUnprotected`, `sharedLocked` | The names of the shared data |
| `loopCosts` | The kinds and their numbers |
| `commits`, `fixes` | The number, and the summaries of the fixes |
| `recent` | `uncommitted` or `recent` |
| `reachUnknown` | The cause (phase B) |
| `tests` | The number of the test functions, and their files (phase B) |

The engine gives the frame path as a list of names already (`MetricsReach.frame.path`). Thus the frame path of item 13 needs no engine change.

### 5.3 Item 10: the heat of lines

`get_heat` gets `lines`: the first and the last line. The result has the functions with a line in the range, the hottest first. The filter is the filter of `hottestIn`.

### 5.4 Item 22: only the hunks of the plan

`show_diff_walk` gets `allHunks`. The default is `true`, as now. With `false`, DataFlow adds no steps, and the result gives the hunks that the walk does not show in `notShown`.

### 5.5 Item 27: the reason of the state of the engine

`EngineStateEvent` gets `error`: the reason of the state `failed`, or of the state `stopped` with no compile database. The API gets the property `engineError` with the same text. The store has the text in `message` already.

### 5.6 Item 29: the state of the call graph

The read tool `get_call_graph` gives `CallGraphFacts`, and it starts no scan. The API gets `getCallGraph`.

## 6. Phase B: the call graph

Items 15, 16, 13 and 14. Engine and extension.

### 6.1 Item 15: callers that the call graph cannot see

The engine finds three causes. Each cause gives the function the flag `unknownCallers` with the cause and its place.

1. `address`: a body or an initializer of a global variable uses the address of the function. `GraphCallWalker` records a `DeclRefExpr` or a `MemberExpr` that names a function and that is not the callee of a call, for example `&Dialog::on_ok` or `std::function<void()> f = run;`. The scan also walks the initializers of the global and static variables of each file, for example a table of handlers.
2. `libraryOverride`: the function overrides a virtual function that a file out of the project declares, for example `QWidget::mousePressEvent`. A frame function, for example `QWidget::paintEvent`, keeps its frame path and does not get this flag.
3. `slot`: the class declares the function in a `slots` section of Qt. A string connect with `SLOT()` and a call from QML can call such a function.

Qt connections: a call of `QObject::connect` with two pointers to members, for example `connect(a, &A::changed, b, &B::update)`, adds an edge from the signal to the slot. Moc writes the body of a signal into a file of the build folder, and the scan skips this folder. Thus the merge of the graph makes a node for each connected signal with no body. The calls of `emit changed()` are edges to this node already, because the declaration of the signal is in the project. The emitters of the signal thus become transitive callers of the slot. An overloaded signal with `QOverload<int>::of(...)` gives the declaration that Clang selects. A lambda as the slot is a part of the body that calls `connect`, as now.

The heat (decision 1):

- A function with `unknownCallers` is never siloed.
- It gets a reason with 0 points, for example "Callers that the call graph cannot see: Qt calls this override of QWidget::mousePressEvent".
- `get_heat` gives `reachUnknown` with the cause and the text.
- The tab Heat shows the reason.

A function with Qt connections and with known emitters gets its reach from the emitters. It does not get `reachUnknown` for the connection.

### 6.2 Item 16: the limit of the frame path

`frame_paths` walks the graph with no limit, and it keeps the number of calls of each function. Only a path of 8 calls or less gives the 40 points. A longer path gives a reason with 0 points, for example "On a frame path after 11 calls. The points stop after 8 calls. Add a function on the path to dataflow.heat.frameFunctions". `get_heat` gives a notice for each file with such a function. The calibration of the score stays as it is.

### 6.3 Item 13: the callers of a function

The engine request `dataflow/callers` gets a function: a position or a qualified name. It gets `depth`, with a default of 3 and a maximum of 6. The result has:

- each caller up to the depth, with its file, its lines, the lines of its calls and its depth. The lines of the calls come from the edges of the caller (`GraphEdge.line_`).
- the frame paths of the function: a maximum of 5 paths, one for each frame function that reaches it, from a walk up the callers.
- `isCapped` after 200 callers

The MCP server gets the read tool `get_callers`, and the API gets `getCallers`.

### 6.4 Item 14: the tests of a function

- The new setting `dataflow.heat.testFolders` gives the folders of the tests. A text with no slash is the name of a folder at any place in the project. The default is `["test", "tests"]`.
- The request `dataflow/metrics` gets the folders. The walk of the transitive callers counts the callers in the files of the tests.
- `get_heat` gives `tests` for each function: the number of the test functions that reach it, and a maximum of 5 of their files. The signal gives 0 points.
- The walk stops after 1000 callers. Then `tests` has `isCapped`.

## 7. Phase C: the layers of the clients

Items 17, 18 and 19.

### 7.1 Item 17: one layer for each client and file

- `modelLayers` in `src/state/store.ts` keeps one layer for each pair of owner and file. `layerOf` and `setLayer` in `src/mcp/host.ts` use the client of the host.
- `highlight` and `comment_lines` with no `append` replace only the notes or the comments of the client. `clear` with no file removes only the layers of the client.
- The code view shows the layers of all clients. The bars of the blocks of each client have the color of the client. The first client has the color of the model, and the next clients get the chart colors of the theme. A card names the client of its item.
- The tab Model shows one group for each client.
- An edit moves all layers of the file (`moveLayer`).
- `LayerKeeper` in `src/mcp/layers.ts` keeps the layers with their owners. A layer of 0.5.0 with no owner gets the owner `model`.
- `get_view` gives the layers of the client in `model`, and the number of the items of each different client in `otherClients`.

### 7.2 Item 18: identifiers of notes and comments

- Each note gets an `id` (`n1`, `n2` and so on), and each comment gets an `id` (`c1`, `c2` and so on). A detail has an `id` already. The results of `highlight`, `comment_lines` and `add_detail` give the identifiers.
- The new view tool `remove` gets `file` and `ids`. It removes the notes, the comments and the details of the client with these identifiers. The result gives the removed identifiers and the unknown identifiers.

### 7.3 Item 19: buttons on notes, details and steps

`highlight`, `add_detail`, `show_review_plan` and `show_diff_walk` accept `actions` on a note, a detail or a step (section 4.2, decision 7). The host of the MCP server refuses `actions` with the text "Actions need the API for extensions". The side view shows the buttons in the cards of notes and details, and in the steps of the tab Guide. The API gets the event `onDidInvokeAction` with `kind` (`note`, `detail`, `step` or `tab`), `id`, `file`, `line`, the `step` and the `guide`.

## 8. Phase D: guides

Items 1, 2, 3, 4, 5, 6, 7 and 28. No engine change.

### 8.1 Items 1 and 2: a stack of guides with owners

- The store keeps `guides`: a stack with a maximum of 5 guides (decision 6). The tab Guide and the commands of the guide use the guide on the top.
- Each guide gets an `id` and its `owner`.
- `show_review_plan` and `show_diff_walk` get an optional `id`. With the `id` of a guide of the client, the new plan replaces that guide at its place in the stack. With no `id`, the new guide goes on the top. A new guide does not replace a guide of a different owner.
- When the top guide closes, the guide under it shows again, at its current step.
- The tab Guide names the guides under the top guide, for example "Under this plan: The new limit (user)". A click brings that guide to the top.
- `GuideFacts` get `id` and `owner`. `get_view` gives the top guide in `review`, and the stack in `guides` with `id`, `owner`, `title` and `kind`.
- `review_step` and `close_guide` get `id` (the default is the top guide) and `force`. For a guide of a different owner, they refuse with the owner in the error, except with `force: true` (decision 2). The buttons of the user always work.
- `LayerKeeper` keeps the stack. A stored guide of 0.5.0 becomes a stack of 1 guide.

### 8.2 Items 3 and 28: steps in other files and in new files

- The file of a step can be each text file of the project, for example `CMakeLists.txt`, a `.ui` file or a `.qml` file. The lines must be in the file.
- A step can have `newFile` in the place of `file`: a path for a file that is not there yet. The lines are optional.
- The side view shows only C and C++ files, because the engine gives the tokens. Thus a step in a different file opens the file in the text editor beside the side view, at its lines. The side view keeps its file, and the tab Guide marks the step with "text editor".
- A step of a new file opens no editor. The tab Guide shows the path with the mark "new file". When the file is there later, the step opens it.
- `moveGuide` moves the lines of the steps in all text files.
- `get_diff` gives the hunks of all changed text files under the paths, with `isCpp`. Only a C or C++ file gets functions and heat. Thus a diff walk can show a change of a CMake file.

### 8.3 Item 4: data of the client on a step

A step gets `label`, a short text with a maximum of 40 characters, and `data`, a JSON object with a maximum of 4 KB. The tab Guide shows the label next to the title. `GuideFacts` give both, and `LayerKeeper` keeps them.

### 8.4 Item 5: a note of the user

Each step in the tab Guide gets a text field for a note of the user. DataFlow saves the note when the field loses the focus. `GuideFacts` give the text of the note of the client in `note`, and the note of the user in `userNote`.

### 8.5 Item 6: the cause of a change of the guide

Each change of a guide in the store gives its cause. `onDidChangeGuide` gives the facts with two more fields:

- `change`: `start`, `replace`, `step`, `mark`, `note`, `userNote`, `label` or `move`
- `by`: `user`, or the name of the client

A close still gives `null`. The new fields are additions, so the event stays compatible.

### 8.6 Item 7: longer plans

`MAX_GUIDE_STEPS` in `src/review/guide.ts` becomes 40, as for a diff walk (decision 5).

## 9. Phases E to H

### 9.1 Phase E, item 25: MCP tools of extensions

- The API gets `registerTools(tools)`. Each tool has `name`, `title`, `description`, `inputSchema`, `isReadOnly`, `isDestructive` and a function `call(args)`. The result is a disposable that removes the tools.
- The MCP name of a tool is the name of the client in lowercase, then `_`, then the name of the tool, for example `client_get_brief`. Only letters, digits and `_` are permitted, with a maximum of 64 characters. A name that a tool has already gives an error.
- The description of the tool starts with the name of the extension.
- `McpManager` keeps a list of the tools that can change. Each change adds 1 to the number of the lists. The file of the window in the registry folder gets this number.
- The bridge compares the server of the window with the number of the lists (`serverOf` in `src/mcp/bridge.ts`). Thus a new number gives the notification `notifications/tools/list_changed`, and Claude Code gets the new tools.
- Limit: a client that connects to the HTTP server with no bridge gets no notification. The HTTP server cannot send a message of its own. Such a client gets the new tools at its next `tools/list`.
- A tool of an extension runs in the extension. The token of the MCP server protects it, as it protects the tools of DataFlow.

### 9.2 Phase F, items 21, 23 and 26: marks, Change Ripple and the parse

Item 21, marks:

- The view tool `mark_base` gets `name` and `paths`. It keeps the text of each text file under the paths: the text of the editor, else the text on the disk. A mark has a maximum of 500 files and 20 MB. A new mark with the same name replaces the old mark.
- A mark belongs to its client, so two clients can have a mark with the same name. A client has a maximum of 20 marks. `delete_mark` removes a mark.
- The marks are in the storage folder of the workspace (decision 8). `get_view` gives the marks of the client.
- `get_diff` accepts the base `mark:<name>`. The diff of each file compares its text in the mark with the text now. It uses `git diff --no-index`, as `diffText` in `src/review/git.ts` does. A file under the paths that is not in the mark is a new file. A file of the mark that is not there now is a deleted file.

Item 23, Change Ripple of a base:

- `start_ripple` gets `base` and `paths`, as `get_diff`. The default is `target`, as now.
- A tool never asks the user. With no target branch, `start_ripple` fails with the text "The repository has no target branch. Give base". Only the command of DataFlow shows the list of the branches.
- `runReview` takes the changed lines and the deleted blocks from the hunks of the base. Thus a mark also works for Change Ripple.

Item 26, the end of a parse:

- The engine sends `errorCount` and the first 5 errors with the status `ready` of `dataflow/status` (`engine/include/dataflow/server.hpp`).
- The API gets the event `onDidParse` with `file`, `parseMs`, `errorCount` and `errors`.
- The engine parses a file only for a request. After each edit of the active file, the update of the cursor asks for it. Thus the active file gets a parse 250 ms after the last key.

### 9.3 Phase G, items 12, 11 and 24: places and members

Item 12, the facts of a line:

- The engine request `dataflow/place` gets a file and a line. It gives the function at the line, or no function.
- It gives the statements around the line from the outside in:
  - the loops, with `isOpenLoop`
  - the decisions (`if`, `switch` and the conditional operator), with the branch of the line
  - `try` and the lambdas
- It gives the locks at the line with the function `locks_at` of the member analysis (`engine/include/dataflow/member.hpp`).
- It gives the frame path and the number of calls of the function from the call graph.
- The extension adds the threads that run the line, from the lanes of the threads analysis of the file (`buildSideThreads`).
- The MCP server gets the read tool `get_place`, and the API gets `getPlace`.

Item 11, the heat of types and data members:

- The engine request `dataflow/memberMetrics` gets a file. It gives data for each class, struct and union of the file, and for each data member:
  - the functions that read the member, and the functions that write it, with their files
  - a user of the member on a frame path
  - the include reach of the header
- The project index gives these data (section 4.3).
- The extension computes a score with the groups of the heat of a function:
  - reach: a user on a frame path, the number of the users and of their files, and the include reach
  - risk: the number of the writers, and the data that threads share
  - history: the blame of the lines of the declaration
- The lens Heat shows the flames on the line of each type and data member. `get_heat` gives `types` and `members`.
- The score of a member is a new score model. It needs a calibration on the fixture projects and on real projects before its release, as the heat of a function had.

Item 24, the sites of a member:

- The read tool `get_member_sites` gets a type. For a class or a struct, it gives the functions that use its data members. Each function has the part of the members that it uses, and the largest part comes first. A function that loads, saves or copies the type uses most members.
- For an enum, it gives each `switch` statement on the enum, with the enumerators that it does not handle and the flag `hasDefault`.
- The project index gives these data.

### 9.4 Phase H, item 20: a tab of an extension

- The API gets `registerTab({ id, title })`. The result has `update(content)` and `dispose()`. A client has a maximum of 1 tab.
- The content has sections. Each section has a title and rows. Each row has `text`, and optionally `detail` (a small part of Markdown), `badge`, `place` (a file and a line) and `actions`.
- The details column shows the tab after the tabs of DataFlow. A click on a row with a place goes to the place, as the lists of DataFlow do. A click on a button sends `onDidInvokeAction` with the kind `tab`.
- The content has no HTML and no scripts. A tab has a maximum of 200 rows.

## 10. Phases

| Phase | Items | Engine | Size |
| --- | --- | --- | --- |
| A Quick fixes | 8, 9, 10, 22, 27, 29, and the frame path of 13 | No | Small |
| B Call graph | 15, 16, 13, 14 | Yes | Large |
| C Layers of the clients | 17, 18, 19 | No | Medium |
| D Guides | 1, 2, 3, 4, 5, 6, 7, 28 | No | Large |
| E MCP tools of extensions | 25 | No | Medium |
| F Marks, Change Ripple and the parse | 21, 23, 26 | 26 only | Medium |
| G Places and members | 12, 11, 24 | Yes | Large |
| H Tab of an extension | 20 | No | Medium |

The reasons for this order:

- Phase A gives the client extension the facts of the heat that its rule needs (item 9), with little work.
- Phase B removes the most important gap (item 15): a wrong cool band gives the model a permission that the user must have.
- Phase C stops the loss of the callouts of the client extension. Phase C also makes the actions that phases D and H use.
- Phase D needs the owners of section 4.1 and the actions of phase C.
- Phase E removes the most code from the client extension: its own MCP server.
- Phase G needs the project index. Phase B starts the index with the addresses and the connections, and phase G adds the uses of the members and the `switch` statements.

After each phase, the client extension can remove its procedure for the items of the phase.

## 11. Tests

| Kind | Tests |
| --- | --- |
| Unit tests | The signals and the flags of the heat, the filter of lines, the stack of guides with its owners, the steps of other files and of new files, the merge of the layers of the clients, the identifiers and `remove`, the names of the tools of extensions, the diff against a mark, the cause of a change of a guide. |
| Engine tests | Addresses of functions in bodies and in global tables, overrides of a library, a Qt connection with a signal with no body, a slot, the frame path after 8 calls, `dataflow/callers`, the tests of a function, `dataflow/place` with its locks, the uses of the members and the `switch` statements, the errors in `dataflow/status`. A small header in the test copies the declarations of `QObject::connect`, so the tests need no Qt. |
| Fixture tests | Each new tool through the MCP server and through the API. Two API objects with different clients: their layers, their guides and the refusal without `force`. A tool of an extension in `tools/list`, and the notification of the bridge. A mark and its diff walk. Change Ripple against a mark with no question of VS Code. |
| UI tests | The note of the user in the tab Guide, the buttons of a note and of a step, the layers of two clients with their colors, the guides under the top guide, the tab of an extension. |

The calibration of the score of a member (phase G) uses the fixture projects. It also reads real projects of the user, but it does not change them.

## 12. Corrections to the gap list

The check of the code found these differences:

- Item 10: `get_heat` gives all functions of a file up to 200 functions. Only after 200 functions does `more` give the number of the others. The gap of the lines is correct.
- Item 13: the engine gives the frame path as a list of names already. Only the tool gives it as text. The callers past the direct callers need the engine.
- Item 15: an edge from the call of `connect` to the slot is not sufficient. The body of a signal is in a file of moc in the build folder, which the scan skips. The edge must go from a node of the signal to the slot (section 6.1).
- Items 3 and 28: the side view cannot show a file that is not a C or C++ file, because the engine gives the tokens. A step in such a file opens in the text editor (section 8.2).
- Item 25: the HTTP server cannot send a notification. The bridge sends one only after a change of the server of the window. Thus the registry file needs the number of the lists (section 9.1).
- Item 26: the status of the engine has no errors. The fix needs a small change of the engine.

The table of the bands in the gap list is correct. A score less than 25 is cool, less than 50 is warm, and less than 75 is hot. A score of 75 or more is very hot.

## 13. Risks

- Two clients with blocks on the same lines make many bars. The colors of the clients and the groups of the tab Model keep them apart. If this is not sufficient, the switch Model can get one switch for each client.
- The project index needs more memory in a large project, for example an Unreal Engine project with 100,000 functions. The numbers of the USRs keep it small, and a test measures the memory on the largest fixture.
- An address of a function in a template argument or in `sizeof` is not a call. The check takes only an expression whose value is the address.
- The guide stack can confuse the user. The tab Guide always names the guides under the top guide.
- A mark copies the text of files. The limits of 500 files, 20 MB and 20 marks for each client keep the storage small.
- The score of a member is new. A wrong score gives a wrong risk level in the client extension. Phase G releases it only after the calibration.
- The tools of an extension make the list of the tools longer for the model. The client extension decides how many tools it adds.
