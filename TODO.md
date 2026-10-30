# DataFlow: open issues

- Date: 30 October 2026
- Sources: [docs/p1-notes.md](docs/p1-notes.md), [docs/p2-notes.md](docs/p2-notes.md), [docs/p3-notes.md](docs/p3-notes.md), [docs/p4-notes.md](docs/p4-notes.md), [docs/p5-notes.md](docs/p5-notes.md), [docs/s1-notes.md](docs/s1-notes.md), [docs/s2-notes.md](docs/s2-notes.md), [docs/s3-notes.md](docs/s3-notes.md), [docs/s4-notes.md](docs/s4-notes.md), [docs/s5-notes.md](docs/s5-notes.md), [docs/s6-notes.md](docs/s6-notes.md), and the tests on the TBT repository

Each item gives the problem, the data that shows it, and a possible fix.

## Order of the work

Do the groups in this sequence. In a group, do the items in the sequence of the list. Each item has the same title in its section below. When you fix an item, remove it from its section and from this list. The items of **Found in TBT** are work in the TBT repository, not in DataFlow.

### Group 1: harm and wrong results

All items are done.

### Group 2: manual steps and broken setups

All items are done except this item, which is only for a project that needs it:

1. **A qmake project with `TEMPLATE = subdirs` has no compile database.** and **DataFlow sets each `.inc` file in the folder of a compile database to C++.**

### Group 3: the release (phase P6)

The body models and the extra pass of the preprocessor are done. The first parse and the review of a large branch are examined: their items give the data and the result. These items are open:

1. **Only Windows x64 was built and tested.** WSL with Ubuntu is on the computer of the development. A build needs LLVM 23.1.4 for Linux, a download of more than 1 GB.
2. The missing test: **No test covers the CMake Tools API.** It needs a copy of CMake Tools in the test build of VS Code.

### Group 4: after the feedback of the beta

The user decided to skip the beta. The first items of the side view and of the MCP server are done. Do the other items in the sequence of their sections.

## MCP server

- [ ] **The connection to Claude Code is not checked in the panel of the Claude Code extension.**
  The Claude Code CLI 2.1.312, the program of the extension, validates the plugin, and `claude mcp list` connects to the server of the plugin through the bridge. A session in the panel was not tested: a trust prompt for a plugin that the settings turn on, and the tools of a running session after the connection. Claude Code has no interface for other extensions, so DataFlow writes two documented settings of Claude Code. A later version of Claude Code can change them.
  Possible fix: test it in the panel. If Claude Code gets an interface for extensions, use it.

- [ ] **The team cannot share the blocks and the notes of a model.**
  The state of the workspace in VS Code keeps them for the next session, with the text of the first and the last line of each block and note. Only the computer of the user has them.
  Possible fix: a file in the workspace with the same data, which git can keep. The design study asks the user about this.
- [ ] **"Out" of a write through an element of a container is an estimate.**
  The engine gives the reads of the container, for example of `q.items` for `q.items[0].x`. A write of an element does not stop an earlier write of the container, so a write that each path writes again before the read can be "out". The slice has no indexes.
  Possible fix: values with constant indexes in the slice.
- [ ] **The server sends no messages of its own.**
  It has no event stream, no resources and no notifications, for example of a change of the side view by the user.
## Threads and races

- [ ] **The engine cannot see a state that keeps two threads apart.**
  A state machine can make sure that no worker thread runs in a state. The engine shows such a pair as "Check" with the conditions of the access.

- [ ] **Some locks do not count.**
  A function that takes a lock or returns a guard counts only on `this` or with no object: on a different object, the mutexes of its body are not the mutexes of the caller. A lock in a nested block before the access, and the thread safety annotations of Clang, for example `GUARDED_BY`, do not count.
  Possible fix: the object of the call in the path of the mutex. The thread safety analysis of Clang for code with annotations.

- [ ] **A job queue in a different source file needs its function in the setting.**
  The engine finds a job queue if the translation unit has the function that puts the callable into a container member and the thread start that takes from it, for example `WorkerPool::post`. If the function of the queue is in a different source file, add it to `dataflow.ripple.asyncFunctions`.

- [ ] **The callers in other files are not a part of the analysis.**
  The walk starts at the functions of the file that no function of the file calls. These functions run on the caller thread. A function that a different file calls on a worker thread is not on a worker thread here.

- [ ] **The analysis stops at limits.**
  The walk has a maximum of 8 calls from a root, 20000 visits of a function, 400000 accesses and 300 functions of the project headers. The details column tells when the analysis stopped at a limit.

## Flow Lens: data members

- [ ] **The search for the files of a class reads only the text.**
  A file must have `Class::` and each namespace of the class as a word. A macro that defines a member function with no `Class::` in the text, or a macro that opens the namespace, hides a file. A file of a different class with the same name in a namespace with the same name can still come: after the parse, it shows "no access" or "failed".
  Possible fix: the symbols of the index of the C/C++ extension for the definitions of the member functions.

- [ ] **An access that the threads analysis does not reach has the thread of its function only.**
  The walk of the threads analysis starts at the functions of the main file that no function of the file calls. An access in a member function of a header that no function of the main file calls gets no runs: the race check uses the thread of its function and its own locks.

- [ ] **An edit of a header of the trace parses the translation unit again.**
  A header of the preamble makes a new preamble. This takes about the time of the first parse after each pause of 800 ms in the typing: 18 s for the `main.cpp` of the engine, 4 s for TBT `tests.cpp`.

## Call Hierarchy

- [ ] **A call through a pointer to a function is not in the graph.**
  A call through a function pointer or a std::function is not in the graph. A virtual call goes to the overrides in the project, but not to an override in a library or in a different translation unit.

- [ ] **The data of a call comes from the call only.**
  "writes" uses the types of the parameters: a function can get a non-const reference and not change it. "async" knows only the lambdas of the thread starts, of the job queues of the translation unit and of `dataflow.ripple.asyncFunctions`. A job queue in a different source file needs the setting.

- [ ] **The callers in other files need the C/C++ extension or clangd.**
  The first answer can come after the extension makes its index. DataFlow asks again every 10 s, a maximum of 6 times.

## Logic Map

- [ ] **The default path is a heuristic.**
  Each decision with no choice of the user gets the option that runs the most lines. This path goes past the early returns, but it is not always the normal path of the function. A loop gets "enter", and a `do` loop gets "repeat".
  Possible fix: a setting for the default option of a decision, or the path of the last run of the function from a debugger.

- [ ] **The changes of the path panel miss the writes of called functions.**
  A change is a direct write of a data member, a global, the object of a reference or pointer parameter, or a capture by reference, also through a local reference, a local pointer or an iterator. A non-const reference argument of a call is not a change, also if the called function writes it. The panel shows the code, not a sentence such as "Stores the new readings in new_readings".
  Possible fix: use the possible writes of the slice of Change Ripple through calls.

## Hidden C++

- [ ] **Hidden C++ of a header takes the instantiations of one source file.**
  For a header with a template, the engine parses the first source file of the project, by its path, that includes the header. A different source file can have other instantiations, and the first file can have none.
  Possible fix: select the source file with the most calls of the templates, or merge the items of more than one source file.

## Change Ripple

- [ ] **The slice does not know what a called function changes.**
  A call with a reference argument is an exit, and the slice does not follow the object. This keeps the slice small, but it can miss effects.
  Possible fix: a summary of each function in the same file: the parameters and the fields that it writes.

- [ ] **Only references to persistent objects are aliases.**
  A write through a reference or a pointer to a local variable does not reach the uses of that variable.

- [ ] **The rule for deleted blocks is a heuristic.**
  A deleted block brings the later uses of the variables that it writes. A deleted condition, for example `if (x) {`, brings the later uses of `x`, not the statements that it controlled.
  Possible fix: parse the old text of the function, and compare the two versions.

- [ ] **A change outside of a function gets no ripple.**
  A changed type, global variable or macro shows only as "outside of a function". A changed member initializer list of a constructor has no statement.
  Possible fix: for a changed field or global, use the references of the editor as seeds.

- [ ] **The removed lines of the diff get the colors of a small lexer.**
  The engine parses only the working tree. A removed line gets the colors of its added line for the same text. The lexer gives the colors of the changed part and of a removed line with no added line. A name gets a semantic color only if the added line has the same name.

- [ ] **A review of a large branch is slow.**
  A branch of a Qt project of the user with 24 changed files took 144 s. Since 29 October 2026, the engine keeps the body models of a parse for all slices of the file, and most accesses need no query of the mutation analyzer. A slice of all lines of TBT `tests.cpp` takes 0.43 s, then 13 ms (before: 4.8 s each time).
  Measurement on 29 October 2026, with the engine and the pipeline of the extension: the same branch took 79 s, with 76 changed functions and 57 slices. The measurement had no call hierarchy, so it did not follow the callers in other files. The analysis of the slices took 2.3 s. The rest is the first parse of each changed file, about 3.3 s for each file. A second review takes the same time, because the engine keeps only 4 parses (`dataflow.engine.cacheSize`).
  Since 30 October 2026, the review works on 3 files at the same time (one less than `dataflow.engine.cacheSize`): 35 s for the same branch, with the same result. The peak memory of the engine was 5.6 GiB (before: 6.3 GiB), with 4 parses in the cache. A larger cache permits more files at the same time, but it needs more memory.
  Possible fix: none that is cheap. The time is the first parse of each changed file.

## Side view

- [ ] **With sticky scroll, the side view shows the lines under the sticky lines at its top.**
  The scroll sync uses the first visible line of the VS Code API. The text editor shows its sticky lines over this line and the next lines. So the side view shows up to 5 more lines at its top. The lines below the sticky lines are at the same height in the two views.
  Possible fix: sticky lines in the side view, with the same scopes.

- [ ] **The scroll sync uses whole lines.**
  The VS Code API gives only the lines that are fully visible. If the text editor stops between two lines, the two views differ by less than one line.

- [ ] **An edit that adds or removes lines shows after the parse.**
  An edit in one line shows at once in the side view, and the tokens after the edit move with the text. An edit that adds or removes lines moves the rows and the data of the lenses, so the side view shows it after the parse. The extension sends the text to the engine 250 ms after the last key. The fixture needs about 300 ms for a parse.
  Possible fix: move the rows and the data of all lenses with the edit.

- [ ] **With no text editor, only the mouse moves the cursor of the side view.**
  A click moves the cursor, and the mouse selects code. The arrow keys work only in the text editor.
  Possible fix: the arrow keys in the side view.

- [ ] **A name in the body of a macro can have no kind.**
  A name in the body of a macro gets the kind of the expanded code. If only an included file expands the macro, the name has no kind. In TBT `tests.cpp`, 5 of 3,798 names have no kind, for example `TaskA` in `#define TASK_TYPE TaskA`. In TBT `compiler.hpp` and `execute.hpp`, all names have a kind.

## Parse time

- [ ] **The first parse of a large file takes more than 5 s.**
  TBT `tests.cpp` with glaze: 5.7 s. TBT `execute.hpp`: 3.5 s. TBT `compiler.hpp`: 3.1 s to 3.5 s. A Qt Widgets file of 13,100 lines of a project of the user, with Qt 6.11 and MSVC 2022: 13 s. The budget for a typical Qt translation unit is 5 s.
  Examination on 29 October 2026: the first parse is a full parse of Clang and the build of the preamble. The `main.cpp` of the engine: 18 s, of which a parse with no preamble takes 14.9 s. TBT `tests.cpp`: 4.0 s, of which 3.3 s with no preamble. Thus the preamble adds about 23%, and the rest is the work of Clang on the headers. A first parse with no preamble saves only this part, and then the first edit builds the preamble. Since the preamble also has the instantiations of its headers, a parse after an edit takes 0.25 s for the `main.cpp` of the engine (before: 6.5 s) and 1.1 s for TBT `tests.cpp` (before: 1.3 s).
  Possible fix: none that is cheap. Clang cannot skip the function bodies of the system headers only.

## Compile databases

- [ ] **No test covers the CMake Tools API.**
  The test build of VS Code has no CMake Tools extension. DataFlow asks CMake Tools for its build folder only if CMake Tools already runs, because an activation of CMake Tools can make it configure the project. A manual check with copies of CMake Tools 1.24.42 and the Qt extensions 1.16.0 in the test build showed: with the old code, a folder with only a `.pro` file started CMake Tools. With the new code, it does not, and a project that is not open starts no CMake Tools and no Qt extension.
  Possible fix: an automatic test with a copy of CMake Tools in a folder of the tests.

- [ ] **A qmake project with `TEMPLATE = subdirs` has no compile database.**
  The Makefile at the top of such a project has no sources. DataFlow reads only this Makefile. This is not tested. A Qt Creator build with `.qtc_clangd/compile_commands.json` works.
  Possible fix: follow the Makefiles of the sub-projects.

- [ ] **DataFlow sets each `.inc` file in the folder of a compile database to C++.**
  An `.inc` file can also contain assembly or a different language. If the user sets a document back to plain text, DataFlow keeps it until VS Code closes the document. DataFlow starts only for C and C++ files, so an `.inc` file that opens before DataFlow starts stays plain text until DataFlow starts.
  Possible fix: a setting with the patterns of the files that DataFlow sets to C++.

## Platforms and development

- [ ] **Only Windows x64 was built and tested.**

## Found in TBT

These items are in the TBT repository, not in DataFlow.

- [ ] **`include/TBT/execute.hpp` line 32 is ill-formed.**
  `Awaitable<T>::await_suspend` calls `values_->set_done()`, but `CoStateValues` is incomplete at this point. The expression does not depend on a template parameter, so the program is ill-formed, no diagnostic required. MSVC accepts it. Clang rejects it, and GCC probably also rejects it.
  Possible fix: define `await_suspend` after the definition of `CoStateValues`.

- [ ] **CMake Tools left a stopped configure in `TBT/build`.**
  When the TBT window opened, CMake Tools started a configure with "Visual Studio 18 2026". The configure stopped in the compiler check. It left `CMakeCache.txt` and `CMakeFiles/` next to the project files of Visual Studio 2022. Delete these two items before the next build with Visual Studio 2022 in this folder.
