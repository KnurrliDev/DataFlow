# Heat score: implementation strategy

This document proposes how to add a heat score to DataFlow. The heat score of a function tells how much a change of the function can break. Section 11 gives the decisions of the user and the open questions.

## 1. Goal and scope

The heat of a function is high if a change of the function can cause many bugs, or bugs in important places. Two things make a function hot:

- **Reach**: many parts of the program depend on the function. An example is a function on the main render path. A class that only one file uses has a small reach.
- **Risk**: the function is complex, it changes shared state, threads share its data, or it changed often.

Reach has the most weight. A complex function of a siloed class stays cool. A simple function on the render path is hot.

| Place | What the user sees |
| --- | --- |
| Lens **Heat** of the side view | A strip in the color of the heat next to each function. When DataFlow has the score of a function, its first line gets 1 to 5 flame icons. |
| Tab **Heat** of the details column | The functions of the file, the hottest first. For the function at the cursor: the score and each reason with its points. During the scan of the project, a busy widget with the progress. |
| MCP tool `get_heat` | The scores of the functions of a file with their reasons, for example to put the steps of a review in a sequence. |

The score is a heuristic. Each point has a reason that the user can see, so the user can judge the score.

## 2. Key decisions

- Each function gets one score from 0 to 100. The score is a sum of points, and each point has a reason. A rank in the project is not possible, because it needs the scores of all functions of the project.
- The callers come from a call graph that the engine makes for all source files of the project (section 4.2).
- The engine makes the call graph only on demand: when the user turns on the lens Heat, or when the model calls `get_heat`.
- The scan does not block DataFlow. The side view shows a busy widget with the progress, and the user can stop the scan.
- The engine finds most frame functions itself (section 4.3). The setting `dataflow.heat.frameFunctions` adds more names.
- A function on the render path is hot. Complexity or history make it very hot.
- The include reach comes from the include index of the engine. The risk comes from a new engine request that measures all functions of a file in one parse. The history comes from one `git blame` of the file.
- The bands are cool (0 to 24), warm (25 to 49), hot (50 to 74) and very hot (75 to 100).

## 3. The signals

### 3.1 Reach: maximum 60 points

| Signal | Source | Points |
| --- | --- | --- |
| Frame path: a frame function calls the function, directly or through other functions | The call graph and the frame functions (sections 4.2 and 4.3) | 40. 10 more if a caller on the frame path calls the function in a loop. |
| Callers: the number of functions that reach the function through calls, directly or through other functions (the transitive callers) | The call graph | 0 to 10 on a log scale. 1 caller gives 2 points, and 31 or more callers give 10. |
| Files of the callers: the number of different files of the transitive callers, other than the file of the function | The call graph | 0 to 5 |
| Include reach: the part of the source files of the project that include the header with the declaration of the function, directly or through other headers. The source files of the build folders do not count. | The include index of the engine (`dataflow/includers`) | 0 to 8. 50 % or more of the source files give 8. |
| Interface: a virtual function or an override | The engine | 2 |

The sum of the reach points stops at 60.

### 3.2 Risk: maximum 25 points

All signals come from the new engine request `dataflow/metrics` (section 4.1), except the threads.

| Signal | Points |
| --- | --- |
| Decisions: `if`, loops, `case` labels, `&&`, `||` and `?:` | 0 to 10 on a log scale |
| Depth: 4 or more nested decisions | 3 |
| Writes to shared state: data members, globals, static locals, and data through reference or pointer parameters | 0 to 5 |
| Threads: data that two threads share, from Threads and races | 3 with a lock, 6 with no protection |
| Hidden costs in loops: allocations and copies in a loop | 0 to 3 |
| Length: the lines of the body | 0 to 2 |

The sum of the risk points stops at 25.

### 3.3 History: maximum 15 points

All signals come from `git blame --porcelain` of the file. A file with no git repository gets no history points.

| Signal | Points |
| --- | --- |
| Commits: the number of different commits of the lines of the function | 0 to 7 on a log scale |
| Fixes: commits with a message that starts with "fix" or contains "bug" | 2 for each commit, maximum 6 |
| A change in the last 30 days | 2 |

### 3.4 The score

The score is the sum of the reach, the risk and the history points. If the reach is less than 10 points, the risk and the history points count half. Thus a complex function of a siloed class stays cool.

The half points need the callers, because only the callers show that a function is siloed. Until the call graph is available, the risk and the history points count fully, and the score tells that the reach is not complete.

Each function gets 1 to 5 flames from its score:

| Score | Flames |
| --- | --- |
| 0 to 19 | 1 |
| 20 to 39 | 2 |
| 40 to 59 | 3 |
| 60 to 79 | 4 |
| 80 to 100 | 5 |

| Function | Reach | Risk | History | Score |
| --- | --- | --- | --- | --- |
| A complex function of a siloed class: 1 caller in the same file, a header that 1 source file includes, 24 decisions, 10 commits | 2 | 20, half: 10 | 9, half: 4 | 16, cool |
| A utility that 30 functions in 12 files call, in a header that 60 % of the source files include | 23 | 6 | 4 | 33, warm |
| A short function on the render path that a loop calls | 60 | 4 | 3 | 67, hot |
| A complex function on the render path | 60 | 18 | 8 | 86, very hot |

These points are the start values. Phase B calibrates them on real projects (section 7).

## 4. Engine

### 4.1 dataflow/metrics

The new request `dataflow/metrics` has the parameter `file`. It parses the file one time and gives these data for each function definition of the file:

- The name, the qualified name, the USR and the range of the function. The USR is the name of the function in the call graph.
- The file and the line of the first declaration. For a function in a source file, this is usually the header. The engine uses this header for the include reach.
- The number of decisions and the deepest nesting of the decisions.
- The writes to data members, globals, static locals and data through reference or pointer parameters, with the names.
- The allocations and the copies in loops, from the analysis of Hidden C++.
- The lines of the body.
- `virtual` or `override`.
- The reach data, if the call graph is available: the callers, the files of the callers, the frame path and the calls in loops. The reply tells the state of the call graph: none, scanning, partial or ready. A partial graph comes from a first scan that the user stopped.

The request uses the analyses of `dataflow/logic`, `dataflow/structure` and `dataflow/cost`. It does not use a new type of parse. The threads come from the request `dataflow/threads` of Threads and races.

### 4.2 The call graph of the project

The new request `dataflow/callGraph` starts the scan of the call graph, with the project folders in `roots`. The reply comes when the scan is complete.

- The scan parses each source file of the compile databases in the project folders one time. It keeps only the call graph and no syntax tree.
- The scan skips the build folders: the folder of a compile database in a project folder, and each folder `_deps` with the libraries that CMake fetches. On a header-only library, the database listed 106 source files of Catch2 in `build/_deps` and 1 source file of the project.
- The graph keeps the functions of each file. The first source file that parses a file of the project gets its functions, and the other source files skip the bodies of its functions. Thus a project with its code in headers keeps each function one time.
- For each function definition in the project folders, the graph keeps the USR, the qualified name, the file and the range. For each call, it keeps the called function, the line and whether the call is in a loop.
- A virtual call also goes to the overrides of the called function, as in Call Hierarchy.
- The scan uses a maximum of half of the threads of the engine. Thus the requests of the side view stay fast during the scan.
- The engine sends the notification `dataflow/progress` one time each second, with the number of scanned source files and the number of all source files.
- `$/cancelRequest` stops the scan. The source files that a first scan parsed stay, and the next scan continues with the other source files. A stopped update keeps the complete graph of the last scan.
- After a save of a project file, the graph is old. The metrics use the old graph until the update is complete. The update parses only the source files that include a changed file. The include index gives these source files.

The time of a scan depends on the headers. Each source file gets one parse, as for the build. A project with 100 source files and the standard library takes some tens of seconds. An Unreal project with the headers of the engine can take many minutes. The busy widget shows the progress, and the graph stays for all later requests until the engine stops.

### 4.3 The frame functions

The engine finds the frame functions in two ways:

1. **Overrides of the frame functions of the frameworks.** The syntax tree tells exactly which functions override them. A name is not sufficient: a function `Tick` of a class that is not an actor is not a frame function.
   - Unreal Engine: `AActor::Tick`, `UActorComponent::TickComponent`, `UUserWidget::NativeTick`, `SWidget::OnPaint` and `FTickableGameObject::Tick`
   - Qt: `QWidget::paintEvent`, `QOpenGLWidget::paintGL`, `QObject::timerEvent` and `QQuickItem::updatePaintNode`
2. **Main loops.** A loop with no fixed number of iterations in `main` is a main loop. If `main` has no main loop, the engine looks in the functions that `main` calls. Examples are `while (!window.should_close())` and `for (;;)`. The functions that the body of the loop calls run in each frame. A loop that empties a container, for example `while (!errors.empty())`, is not a main loop.

The engine does not use a timer that `connect` sets, for example a lambda for `QTimer::timeout`, because it cannot know the interval of the timer. An override of `QObject::timerEvent` is in the list, because the user selected it.

The setting `dataflow.heat.frameFunctions` adds the qualified names of more frame functions, for example the render loop of a different thread. The tab Heat shows each frame function and the reason why it is one: an override, a main loop or the setting.

## 5. Extension

### 5.1 The heat model

A new module `src/lenses/heat.ts` adds the points. It does not use the VS Code API, so the unit tests can call it directly. Its inputs are the metrics with the reach data and the blame of a file. Its output is the score, the band and the reasons of each function.

### 5.2 Heat on demand

- The lens Heat and `get_heat` ask the engine for the metrics of the file. If the engine has no call graph, they also start the scan.
- The scores show at once with the local signals: the risk, the history and the include reach. When the scan is complete, DataFlow asks for the metrics again, and the scores get the callers and the frame path.
- With the lens off and no model request, DataFlow does not start a scan.

### 5.3 History

- One `git blame --porcelain` for each file gives the history. DataFlow keeps the result until the file or HEAD changes.

### 5.4 Cache

- The scores of a file stay until its text changes. After an edit, the local signals come again from the engine. The reach stays until the next scan.

## 6. Side view and MCP

### 6.1 Lens Heat

- The toolbar gets the lens **Heat**. It is off until the user turns it on.
- Each function gets a strip in the color of its band next to the line numbers.
- When DataFlow has the score of a function, the line of its name gets 1 to 5 flame icons (section 3.4) in the color of its band, before the line number. The line numbers get more width for the flames while the lens shows, so the flames are always visible. The mouse on the flames shows the score.
- The theme colors `dataflow.heatCool`, `dataflow.heatWarm`, `dataflow.heatHot` and `dataflow.heatVeryHot` give the colors of the bands. The defaults come from the chart colors of the color theme.

### 6.2 Tab Heat

- The tab shows the functions of the file, the hottest first, with their scores. A click on a function shows it in the code.
- For the function at the cursor, the tab shows each reason with its points. An example is "On the frame path: Renderer::paint, then Scene::draw (40)".
- During the scan, the tab shows a busy widget: a progress bar, the number of scanned source files, and the button **Stop**. After a stop, the button **Continue** starts the scan again. The flames in the code show the local scores, and a note in the tab tells that the reach is not complete.
- The tab lists the frame functions that the engine found, with the reason of each.
- The tab tells which signals are not available, for example "No git repository: no history".

### 6.3 MCP tool get_heat

`get_heat` is a read tool. Its parameters are `file` and `function`. With no function, it gives all functions of the file, the hottest first. Each function has its lines, its score, its band, the points of reach, risk and history, and the reasons.

If the scan runs, the result has the local scores, the progress of the scan and a note to call the tool again later. The tool does not wait for the scan.

The instructions of the server get one sentence: for a review, start with the hottest changed functions.

## 7. Phases

| Phase | Content |
| --- | --- |
| A | The engine request `dataflow/metrics` with no reach data, the history from `git blame`, the include reach, the heat model, the lens Heat, the tab Heat and `get_heat`. |
| B | The call graph of the engine with the progress, the button Stop and the update after changes. The frame functions of section 4.3 and the setting `dataflow.heat.frameFunctions`. The busy widget. Calibration of the points on a header-only library and a game engine (section 12). |
| C | Heat in the guided review and in the diff walk: `get_review` and `get_diff` give the heat of each changed function, and the plan of the model can start with the hottest changes. |

Each phase is one commit with its tests and its documents.

## 8. Tests

- Unit tests of the heat model: the points of each signal, the maximum of each group, the half points of a siloed function and the bands.
- Unit tests of the parse of `git blame --porcelain`.
- Engine tests of `dataflow/metrics` on the battery fixture: the decisions, the depth, the loops and the writes.
- Engine tests of `dataflow/callGraph`: the callers across source files, a virtual call, a main loop, an override of a frame function, the progress, the stop and the update after a change.
- Fixture tests of the lens Heat on `battery.cpp`, of `get_heat` during and after the scan, and of the setting `dataflow.heat.frameFunctions`.
- A UI test of the strip, the pill, the tab Heat and the busy widget.

## 9. Risks

- The scan of a large project takes long, and an Unreal project can take many minutes. The scan runs only on demand, it does not block the side view, and the user can stop it.
- The scan uses CPU. It uses a maximum of half of the threads of the engine.
- After a save, the graph is old until the update is complete. With the lens Heat on, the update starts at the save. After a save of a header that all source files include, the update parses all source files again.
- The main loop rule is a heuristic. The tab shows each frame function with its reason, so the user can see a wrong one. The setting adds the frame functions that the engine does not find.
- The points are a heuristic. The reasons let the user judge each score, and phase B calibrates the points.
- Functions that a macro makes, for example the functions of `GENERATED_BODY()` of Unreal Engine, get no score.

## 10. Effect on the existing lenses

The lens Heat uses the data of Logic Map, Hidden C++, Threads and races and Include Hierarchy. These lenses do not change. After phase B, Call Hierarchy can also use the call graph of the engine for the callers in other files. Then it needs no C/C++ extension for them.

## 11. Decisions of the user

The user decided on 2026-11-13:

1. The callers come from the call graph of the engine. The scan runs on demand, it does not block, and the side view shows a busy widget.
2. A function on the render path is hot. The points of section 3 stay.
3. The frame functions: the defaults, more names in the setting, and the engine finds most of them itself (section 4.3).
4. Each function gets 1 to 5 flames when DataFlow has its score (section 3.4).
5. The lens Heat is off until the user turns it on, because the heat runs on demand.
6. Phase A started on 2026-11-13.
7. The calibration uses a header-only library and a game engine with a main loop (section 12).
8. The caller points count the transitive callers, not only the direct callers, because the calibration showed that a core function behind one entry point stays low.
9. Vendored code in the project folders stays a part of the project, for example a copy of Dear ImGui. Its heat is correct, and it does not change the scores of the other functions.

## 12. Calibration

The calibration ran on two projects of the user on 2026-11-13:

| Project | Source files of the scan | Functions | Calls | Scan | Peak memory |
| --- | --- | --- | --- | --- | --- |
| A header-only library with a test program | 1 | 167 | 308 | 2 s | 384 MB |
| A game engine with a main loop, in headers | 12 | 3397 | 18801 | 7 s | 1057 MB |

The calibration found these problems, and phase B fixes them:

- The compile databases list the source files of fetched libraries: 106 source files of Catch2 for the library, and 243 source files in the build folder of the game engine. The scan and the include reach now skip the build folders and the folders `_deps`.
- The include reach divided by all source files of the compile database. Thus all headers of the library got 0 points. It now counts only the source files of the project.
- A loop in `main` that empties a queue of errors made the error function a frame function. Such a loop is now not a main loop. If `main` has a main loop, the loops of the functions that `main` calls do not count.
- A function in a header that no source file includes had no node. Its reach was unknown, thus it was not siloed. It now has no callers.
- With only the direct callers, the core function of the scheduler of the library had 1 caller and a score of 40. With the transitive callers, the core functions of the library are at the top of the list.

The engine found the main loop of the game engine itself: the update of the world, of the camera and of the events, the new frame of ImGui, and the barriers of the frame. The render passes of the game engine run as tasks of a task library from the main loop. The call graph cannot follow this dispatch, because the library is a fetched library. For such a project, the setting `dataflow.heat.frameFunctions` gives the task functions, for example `run`.

The points of section 3 stay. A function on the frame path is hot, and a library with no frame path has warm functions at most. No function of the two projects is very hot, because the functions on the frame path have little complexity.
