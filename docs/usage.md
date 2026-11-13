# Use DataFlow

DataFlow shows the data flow and the logic of C++ code in a side view beside the text editor. This document tells how to use the side view and each lens. [Install DataFlow](install.md) tells how to install DataFlow. [Use the MCP tools](tools.md) tells how a language model uses DataFlow.

- [The side view](#the-side-view)
- [Flow Lens](#flow-lens)
- [Logic Map](#logic-map)
- [Hidden C++](#hidden-c)
- [Include Hierarchy](#include-hierarchy)
- [Call Hierarchy](#call-hierarchy)
- [Threads and races](#threads-and-races)
- [Change Ripple](#change-ripple)
- [Commands and keys](#commands-and-keys)
- [All settings](#all-settings)

## The side view

The side view shows the file of the active C++ editor beside the editor, with the colors of your color theme. The lenses show their data in the side view. The text editor shows no marks of DataFlow.

The side view uses the colors of the text editor:

- If no extension gives semantic colors for C++, the side view shows only the colors of the grammar, as the text editor does. The C/C++ extension and clangd are examples of extensions that give semantic colors.
- The colors of the brackets obey the settings `editor.bracketPairColorization.enabled` and `editor.bracketPairColorization.independentColorPoolPerBracketType`.
- The side view also reads the color themes of TextMate (`.tmTheme` files).
- The side view dims the lines that a condition of the preprocessor skips, as the C/C++ extension does. For example, it dims the lines in `#if 0`.

A function that a macro makes shows the text of the macro call, not its internal name. For example, a test case of Catch2 shows `TEST_CASE("split")`.

During an edit in one line, the side view shows the new text immediately. The colors after the edit move with the text. The colors of the engine come after the parse. An edit that adds or removes lines shows after the parse.

To use the side view, do these steps:

1. Open a C++ project with a compile database. DataFlow finds the database. If DataFlow finds no database, run **DataFlow: Select Compile Database**.
   - DataFlow looks in the folder, in its build folders, and in the build folders next to it. An example is `../build-App-Desktop-Debug` of Qt Creator.
   - DataFlow also finds a database in a build folder that you make later, for example with the first build with a CMake preset. Then DataFlow starts the engine.
   - For an Unreal Engine 5 project, UnrealBuildTool makes the database. See [Unreal Engine projects](#unreal-engine-projects).
2. Open the side view. Do one of these steps:
   - Click **DataFlow: Open Side View** in the title bar of the editor.
   - Click the DataFlow item in the status bar.
   - Click **Open Side View** in the DataFlow view.

   The side view opens beside the editor.
3. Look at the toolbar of the side view. All lenses are on by default, but Change Ripple is off. When you turn on a lens, the side view also opens.
4. To turn a lens on or off, click its switch in the toolbar: **Flow Lens**, **Logic Map**, **Hidden C++**, **Includes**, **Calls**, **Threads** or **Change Ripple**. In a narrow side view, the switches go to a second row of the toolbar.
5. Scroll the editor or the side view. The other view shows the same first line.
6. To move the cursor of the editor to a line, click the line in the side view.
7. Look at the lens bar under the toolbar. The lens bar has a group of controls for each lens that is on: Flow Lens during a trace, Logic Map and Hidden C++.
   - A dot in the color of the lens starts each group.
   - Each group is one row, and the groups that fit share a row.
   - In a narrow side view, the texts are shorter, and the variables and the categories scroll.
8. To see a card of the side view with the keyboard, push Ctrl+Alt+K, or run **DataFlow: Show Card at Cursor**. The side view shows the card of the first item of this list that it finds at the cursor of the editor:
   - the reference of Flow Lens
   - the items of Hidden C++ on the line
   - the dot at the end of a long line

   To close the card, move the cursor or push Ctrl+Alt+K again.
9. To show or hide the details column of the lenses, click **Details**. In a side view that is narrower than 640 pixels, the details column shows over the code. To close it, push Escape.

The status line of the side view shows the state of the engine and the compile databases. It also has buttons to select a project, select the compile database, show the log and restart the engine.

### Go to a definition

To go to the definition of a name in the side view, hold Ctrl and click the name. On macOS, use Cmd. If the setting `editor.multiCursorModifier` is `ctrlCmd`, use Alt, as in the text editor.

- While you hold the key, the name under the mouse pointer gets an underline.
- The side view goes to the definition, and the focus stays in the side view. The text editor stays at its place. A text editor of the file of the definition gets its cursor at the definition, as for a click in the side view.
- A click on the file of an `#include` shows the header in the side view.
- A click on the name of the definition of a function shows **Show Calls**.
- For more than one definition, a list shows the definitions. A click on a definition in the list moves the side view.
- To go to the definition of the name at the cursor of the side view, push F12 while the side view has the focus.

To go back to the place before the jump, push Alt+Left while the side view has the focus. The Back button of the mouse also goes back. Alt+Right and the Forward button of the mouse go forward again. On macOS, use Ctrl+- and Ctrl+Shift+-. A click in the text editor also shows the file of the editor in the side view again.

The definition providers of VS Code find the definition first, for example the C/C++ extension or clangd. If no provider finds a definition, the engine finds it in the translation unit. For a function with its definition in a different source file, the engine then finds the declaration.

### Outline of a type

To see the outline of a class, a struct, a union or an enum, right-click its name in the side view, and click **Outline**. The name of a constructor or of a type alias also works. The context menu of the text editor also has **Outline**.

A panel below the click shows the type:

- The head: the kind, the name, the template parameters and the bases. A click on a base shows its definition.
- The layout: the size, the alignment and the bytes of padding. The bar shows the holes of padding in yellow. A type that depends on a template parameter has no layout.
- The members in groups, in the sequence of the source: data members, functions, types, enumerators, Qt properties, friends and using declarations.
- For each member: the access (`+` public, `#` protected, `-` private), and the type or the signature. The marks show, for example, `virtual`, `override`, `static` or `= delete`.
- For each data member: the offset and the size in bytes. A data member with padding after it has the mark `+N pad`.
- The text of `UPROPERTY(...)` and `UFUNCTION(...)` of Unreal Engine, and the signals and the slots of Qt.
- The members that a macro makes, for example `GENERATED_BODY()` of Unreal Engine, are in a closed group "Made by GENERATED_BODY".
- The members of each base are in a closed group "Inherited from ...". A type of a library hides its internal names that start with `_`.

To find a member, type in the filter field. The filter compares the names and the types. A click on a member moves the side view to the member, as for Ctrl+click. Ctrl+click on a function shows its definition. The arrow keys go from member to member. To close the panel, push Escape, or click outside of the panel.

If the translation unit has only a declaration of the type, for example `class Battery;`, DataFlow looks for the header of the definition. The definition provider of VS Code finds the header, else a search of the headers of the project finds it.

### The side view with no text editor

The side view also works when no text editor shows its file. For example, the panel of Claude Code can be in front of the C++ editor.

- The side view has its own cursor. The cursor starts at the last cursor of the text editor. To move it, click a line or a name in the side view. The lenses use this cursor as they use the cursor of the editor.
- To select code in the side view, use the mouse. The MCP server gives this selection to the model, for example for "give examples for the selected expression". If a text editor shows the file, the editor gets the same selection.
- A click on a place in a list of a lens shows the place only in the side view, also in a different file. The other editor group does not change.
- The view tools of the MCP server also move only the side view. The tool `get_view` gives the cursor of the side view.
- To open the file in the text editor, click the file name in the toolbar of the side view. The editor opens at the cursor of the side view.

### The DataFlow view

Click the DataFlow icon in the activity bar. The DataFlow view opens in the side bar. It has the commands to open a file, a project and the side view: **Open File…**, **Open Project Folder…**, the recent projects, **Close Project** and **Open Side View**. It also shows the compile database and the state of the engine, with **Show Log** and **Restart Engine**. The controls of the lenses are only in the side view.

### A project that is not open in VS Code

DataFlow can use a project with no folder open in VS Code. Then the extensions that start for a folder do not start, and they do not configure or build the project. CMake Tools and the Qt extensions are examples of such extensions.

1. Open a new window with **File > New Window**. Do not open the folder of the project.
2. Click **Open Project Folder…** in the DataFlow view, run **DataFlow: Open Project…**, or click **Project** in the status line of the side view.
3. Select the root folder of the project. You can also select a build folder. DataFlow looks for these compile databases:
   - a `compile_commands.json` file of CMake
   - a `.qtc_clangd/compile_commands.json` file of Qt Creator
   - the Makefile of a qmake build folder

   If DataFlow finds more than one database, select one. DataFlow looks in these folders:
   - The root folder, its folders with a name that starts with `build`, its `cmake-build-*` folders and `out/build`, and the subfolders of these folders. An example is `builds/App-Desktop_Qt_6_11_2_MSVC2022_64bit-Debug`.
   - The build folders of Qt Creator next to the project, `build-<name>-...`. The name is the name of the folder or of a `.pro` file.
   - The build folders in the project files of Qt Creator: `*.pro.user` and `CMakeLists.txt.user`, also in the folder `.qtcreator`. These build folders can also be outside of the project.
4. Select a file in the list of the C and C++ files of the project. The file opens beside the side view. The list skips hidden folders and build folders. The setting `dataflow.project.skipFolders` has the names of these folders, with `*` for any text.
5. To open a different file, click **Project** again. With **Project**, you can also select a different project, select one of the last projects, or close the project. The DataFlow view has the same commands. You can also run **DataFlow: Open File of the Project** and **DataFlow: Close Project**.

DataFlow only reads the project. It does not run CMake or qmake. The C/C++ extension starts for each C++ file that you open, but it does not build the project. DataFlow asks CMake Tools for its build folder only if CMake Tools already runs.

A review of the project uses its git repository. The git extension of VS Code then shows the repository in the Source Control view.

VS Code does not read the `.vscode/settings.json` file of the project, because its folder is not open. Thus DataFlow reads the settings of Logic Map, Flow Lens, Change Ripple, Hidden C++ and Heat from this file. Examples are `dataflow.logic.eventFunctions`, `dataflow.ripple.baseRef` and `dataflow.heat.frameFunctions`. A setting of this file has priority over your user setting, as a setting of an open folder has. A change of the file applies immediately. The other DataFlow settings of the file do not apply, for example the settings of the engine.

### `.inc` files

VS Code opens `.inc` files as plain text. In the folder of a compile database, an `.inc` file is usually a part of a C or C++ file. An example is a unity build. Thus DataFlow sets the language of these files to C++, and the side view shows them. The list of the files of a project and Change Ripple also include the `.inc` files.

The engine parses an `.inc` file alone, with the compile command of a file with a similar path. If this parse has errors, DataFlow finds the C++ file that includes the `.inc` file. Then the engine parses the `.inc` file after the lines of that C++ file before the `#include`, with the compile command of the C++ file. Thus the `.inc` file gets the declarations of the earlier includes. The side view, the lenses, the MCP tools, Change Ripple and the diff walk all use this parse.

The first parse takes about the time of a parse of the C++ file, because it also parses these lines. A parse after an edit of the `.inc` file is fast. For example, a unity build of a Qt project has 65 `.inc` files in one C++ file. The first parse of the last `.inc` file took 3.9 s, and a parse after an edit took 0.1 s.

To keep an `.inc` file as plain text, run **Change Language Mode** and select **Plain Text**.

### Unreal Engine projects

An Unreal Engine 5 project is a folder with a `.uproject` file. UnrealBuildTool makes its compile database.

1. Open the folder of the project in VS Code.
2. If the project has no compile database, DataFlow asks if it can make one. Click **Make**. You can also run **DataFlow: Make Unreal Compile Database**.
3. A notification shows the progress. To stop UnrealBuildTool, click **Cancel**. When the database is ready, the engine starts with it.

DataFlow runs UnrealBuildTool of the Unreal Engine of the project with the mode `GenerateClangDatabase`:

- UnrealBuildTool runs UnrealHeaderTool first, so the `.generated.h` files exist.
- For this mode, UnrealBuildTool turns off the precompiled headers and the unity builds, so each source file has its own command.
- The commands get their options from response files (`.rsp`) in `Intermediate/Build`. With an Unreal Engine of the Epic Games Launcher, a normal build writes the same files again, for example with its precompiled headers. Thus DataFlow copies the response files into `Intermediate/DataFlow/rsp`. Its database `Intermediate/DataFlow/compile_commands.json` uses the copies.
- The usual `.gitignore` file of an Unreal project contains the folder `Intermediate`, so git ignores the database.

After you add a module or a source file, or change a `.Build.cs` file, run the command again.

The Unreal Engine of the project comes from `EngineAssociation` in the `.uproject` file:

- A version, for example `5.8`: an installation of the Epic Games Launcher.
- The GUID of a source build: the folder that the registry of Windows has for the GUID.
- No value: the Unreal Engine in a folder above the project.

The target is the editor target of the project, for example `MyGameEditor`, because it has the code of the game and of the editor. For the database, UnrealBuildTool uses Clang: the Clang of Visual Studio (the component "C++ Clang tools for Windows") or of LLVM. If UnrealBuildTool finds no Clang, install one of them. To use MSVC, add the compiler of your Visual Studio to `dataflow.unreal.arguments`, for example `-Compiler=VisualStudio2022`.

DataFlow does not use the databases of the VS Code project files of Unreal, `.vscode/compileCommands_<name>.json`. Their commands are for IntelliSense: they have no source file and no C++ standard.

The first parse of a file of an Unreal project takes some seconds, because the headers of Unreal Engine are large. A parse after an edit is fast.

| Setting | Default | Function |
| --- | --- | --- |
| `dataflow.unreal.enginePath` | empty | The folder of Unreal Engine: the folder that contains the folder `Engine`. If it is empty, DataFlow uses `EngineAssociation`. |
| `dataflow.unreal.target` | empty | The target of the database, for example `MyGameEditor`. If it is empty, DataFlow uses the editor target of the project. |
| `dataflow.unreal.configuration` | `Development` | The configuration of the database. |
| `dataflow.unreal.arguments` | `[]` | More arguments for UnrealBuildTool, for example `-Verbose`. |

The list of the files of a project skips the folders `Binaries`, `DerivedDataCache`, `Intermediate` and `Saved`. The async functions of Unreal are in the default of `dataflow.ripple.asyncFunctions`: `Async`, `AsyncTask`, `AsyncThread`, `AsyncPool` and `UE::Tasks::Launch`. Thus Threads and races, Call Hierarchy, Flow Lens and Change Ripple know the code that these functions run on a different thread.

## Flow Lens

Flow Lens shows where the value of a variable or a data member comes from and where it goes.

1. Put the cursor on a variable or a parameter in a function, and push Ctrl+Alt+F. You can also right-click and select **DataFlow: Trace Variable**. The side view opens with the trace.
2. After that, Flow Lens traces the variable at the cursor when the cursor stops on a variable. You can also click a variable in the side view. A position with no variable keeps the trace, and all lines show at full brightness.
3. Look at the rails at the left of the code. A rail connects a definition with the uses that it reaches. A red dashed part of a rail goes to a use with a problem. When a trace starts, a pulse moves along each rail.
4. Look at the references of the variable:
   - Each reference has a box in the color of its role. A definition and a write also have bold text.
   - A possible write has a dashed box, for example a call of a non-const member function.
   - A reference with a problem has a red dashed box and a red background. An example is an optional that the code did not check.
   - A line goes from the dot on the rail to the first reference of the line. The line goes along the bottom edge of the boxes, below the text.
   - While the cursor is on the variable, the side view dims the lines without a reference of the variable. A variable that you click in the side view or in the lens bar also dims these lines.
5. Move the mouse on a mark. A card shows the role, the lines of the definitions that reach the use, and the problem. A curve connects the definition and the use. If a direct curve goes over the code between them, the curve goes around this code at the left. To use the keyboard, put the cursor of the editor on the reference and push Ctrl+Alt+K.
6. During a trace, use the Flow Lens group of the lens bar:
   - To trace a variable, click it. If two variables have the same name, the button also shows the line of the declaration.
   - To go to the line of a problem, click the problem. A line with more accesses that have the same problem shows the problem one time. The bar shows a maximum of two problems. To see the other problems, move the mouse on their number.
   - To remove the trace, click **Clear**. You can also run **DataFlow: Clear Trace**.
7. For the type, the counts and all references, click **Details**.

A problem also has a red hint after the code. On a long line, the hint does not cover the code: a red dot at the right edge of the side view shows the problem. To see the full text in a card, move the mouse on the dot. You can also put the cursor of the editor on the line and push Ctrl+Alt+K. The hints of Logic Map work in the same way.

These rules give the roles and the rails:

- A variable of a const type, also a reference to const, has only reads after its declaration.
- The operands of `sizeof`, `alignof`, `decltype`, `noexcept`, a `requires` expression, an unevaluated `typeid` and a `static_assert` do not run. Thus they are not references.
- A reference in the body of a lambda takes effect at the lambda: a use gets the definitions that reach the lambda. A write in a lambda does not replace the old value, because the lambda can run later or not at all.
- A call of a function that gets a variable by a non-const reference is a possible write. The format functions of std, fmt and spdlog only read their arguments. To add your own functions that only read, use the setting `dataflow.flow.readFunctions`, for example with `log_value` or `Config::get`.
- In a template, Clang does not resolve the code that depends on a template parameter. DataFlow analyzes the template, not one of its instantiations. It finds the data members and the functions of such code in the class template and in the functions with the name. If two overloads have the same number of parameters, the arguments that do not depend on a template parameter select the overload. The index of a subscript is a read. A range-based `for` loop on a dependent range has a control flow graph.

| Setting | Default | Function |
| --- | --- | --- |
| `dataflow.flow.readFunctions` | `[]` | Functions that only read their arguments and their object. Flow Lens shows their calls as reads. |

### Trace a data member of a class

Flow Lens can also trace a data member of a class, a static data member or a global variable. At the start, the trace contains the accesses in the translation unit of the editor: the source file and its headers. You can add the other source files of the class.

1. Put the cursor on an access of the member, on its declaration or on its initializer in a constructor. You can also click the member in the side view.
2. Look at the marks. Each access in the file of the side view has a box in the color of its role. A rail connects a write and the accesses that it reaches in the same function or lambda, through the same object. The object is `this`, or the same name of an object, for example `charge` in `charge.is_dirty`.

   A change of the whole object is also a write on the rail. Examples are `charge = {}`, a call that gets `charge` by a reference to non-const, and a call of a non-const member function on `charge`. Details shows such an access with **all of charge**.
3. If the class is in a different file, each access gets a tag after its code. The tag gives the file and the line of the declaration, the class and the default value. To open the declaration, click the tag. In the file of the declaration, a tag gives the number of accesses in each other file. To open the first access, click this tag.
4. Click **Details** for the accesses in each file:
   - The files of the trace, with the number of references in each file. To open the first access of a file, click the file. If the file has no access, the declaration opens.
   - The function of each access, and its role.
   - The threads of an access. A lambda or a function runs on a different thread if a thread, an async function, a job queue or `QThread::run` starts it. The functions of the translation unit that it calls run on the same thread. A function that more than one thread calls shows each thread. The setting `dataflow.ripple.asyncFunctions` gives the async functions.
   - The locks of an access. A lock is a lock guard that holds a mutex, a `lock()` call until its `unlock()`, or `std::lock`. Examples of lock guards are `std::lock_guard` and `QMutexLocker`. A guard in a cast, as in `auto lock = std::unique_lock(m);`, and a guard that a function returns also count. A function that takes a lock and returns counts until the `unlock()`. A lock that each caller holds on the way to the access also counts.
   - **Possible race**: two accesses that can run at the same time on different threads, with a write and with no common lock. An atomic member, a mutex and a condition variable do not race. A join, a `get()` of a future, the start of a thread and a check of its handle put two accesses in sequence.
5. Add the other source files of the class. DataFlow searches the project folders for these files:
   - the source files that define a member function of the class, for example with `WorkerPool::`
   - the files that include the header of the member and name the member

   A file with `WorkerPool::` must also name each namespace of the class, for example `electricity` in `namespace electricity {`. Thus a class with the same name in a different namespace does not come. Details shows each file that DataFlow finds, with a **Parse** button.
6. To add the accesses of a file to the trace, click **Parse**.
   - The engine parses the translation unit of the file and finds the member by its class and its name. For an `.inc` file of a unity build, the engine parses the source file that includes it.
   - A thread of the trace that calls a function of the other file also runs that function in the other file.
   - To parse all the files that DataFlow found, one after the other, click **Parse all**.
   - After the parse, a file with no access shows "no access". If the translation unit of the file does not contain the class, the file shows "failed".
   - The race check uses the accesses in all the parsed files. Until you parse all the files, the result is "No race found in the parsed files".
7. To trace a different data member of the class, use the lens bar. DataFlow parses the files that you added again, for the new member.

A job queue is a member function that puts its callable argument into a container member of its class. A thread of the class takes the callable from that container. An example is `WorkerPool::post`. DataFlow finds such a queue in the translation unit. A queue with its function in a different source file needs the setting `dataflow.ripple.asyncFunctions`.

After you change a header of the trace, for example the header of the class, DataFlow parses the translation unit again after a short pause. Then the lines of the accesses move.

## Logic Map

Logic Map shows one path through the function. Each decision has an option. At the start, each decision has the option that runs the most lines, so the path goes past the early returns.

1. Put the cursor in a function in the editor. Logic Map is on by default. To turn it off or on, click **Logic Map** in the toolbar of the side view, or run **DataFlow: Toggle Logic Map**. If the cursor is in the body of a lambda, Logic Map shows the path through the lambda.
2. Look at the code. The lines of the steps of the path have a light background in the color of the path. A box shows an event on the path. A red dashed box and a red hint show a pointer that can be null.
3. Move the cursor to a line in the editor, or click a line in the side view. If the path cannot reach the line, Logic Map selects the options that make the line run. Your other choices stay.
4. Look at the path panel at the right of the code. If the panel is closed, click **Details**, then the tab **Logic Map**. The panel shows:
   - the events of the path, the returned values, the changed data and the warnings
   - the trail: the decisions on the path with their options, the events, the changes, the warnings and the returns, in their sequence
   - why the line at the cursor runs
5. To change the path, select a different option of a decision in the trail. An option with an outline is the default option. A full option is your choice. After an edit of the function, your choices stay on the decisions at the same places, also if you changed a condition.
6. Click **Play path**. A dot goes down the trail, and the side view marks the line of each step with a stronger background. A step under the mouse, in the code or in the trail, also gets the stronger background.
7. To see why a line runs, move the mouse on its line number. A card shows the decisions and the values that the line needs. In a switch with fallthrough, two or more cases can make the line run. Then the card shows "one of" with these values. To select these values, click **Use these choices**. You can also right-click a line in the editor and select **DataFlow: Why Does This Line Run**.
8. To remove your choices, click **Reset**.

The Logic Map group of the lens bar also has the events, the warnings, **Play path** and **Reset**. To go to the line of an event or a warning, click it.

A change in the trail is a write of data that lives after the call of the function. This data is a data member, a global or static variable, or the object of a reference or pointer parameter. In a lambda, it is also a variable that the lambda captures by reference. A write is an assignment, `++`, `--`, or a call of a member function that is not `const`.

A call of `operator[]`, `at()`, `find()` or a similar function is a change only if the code writes through its result. A write through a local reference, a local pointer or an iterator is a change of its object, for example `auto& d = data; d.push_back(x);`. Changes with no other step between them are one step in the trail.

Logic Map shows events and pointer warnings only if you configure them for your project:

| Setting | Example | Function |
| --- | --- | --- |
| `dataflow.logic.eventFunctions` | `["fire_transition"]` | A call of one of these functions with a string is an event. The string can be a literal, or a constant that a literal initializes, for example `constexpr const char* kDetected = "detected"`. With no string argument, an enum constant gives the name of the event. |
| `dataflow.logic.nullableFunctions` | `["get_if"]` | A dereference of a pointer from one of these functions with no null check gets a warning. The result can also be a `std::unique_ptr`, a `std::shared_ptr` or a `std::optional`. |
| `dataflow.logic.nullCheckFunctions` | `["is_valid"]` | A call of one of these functions with the pointer is a null check, for example `if (is_valid(p))`. |

Two events on one path get a warning. An event that the path can send again, for example in a loop, also gets a warning.

## Hidden C++

Hidden C++ shows the operations that the compiler adds, for example copies and destructors.

1. Open a C++ file. Hidden C++ is on by default. To turn it off or on, push Ctrl+Alt+H, or click **Hidden C++** in the toolbar of the side view. You can also run **DataFlow: Toggle Hidden C++**.
2. Look at the code. Each item has a line under its code, and a chip with its text after the code of the line. Each category has its own color:
   - copies and moves of class types, and copies into a container
   - conversions that can change a value, for example a narrow integer cast, or a change of the sign, for example from `int32_t` to `uint32_t`
   - temporaries, and variables that hide a variable of an outer scope
   - destructors at the end of a scope, or at a `return`, a `break` or a `continue`
   - allocations. The container calls that can allocate are a heuristic.
   - repeated lookups of the same key in a container on one path through the code. The container and the key do not change between the lookups.
   - hidden state: static local variables, and globals that the function writes
3. On a long line, scroll to the right to see the chips. You can also move the mouse on the line under the code.
4. Move the mouse on a mark or on a chip. A card shows the items with their long texts. For a repeated lookup, curves connect the lookups of the group. To use the keyboard, put the cursor of the editor on the line and push Ctrl+Alt+K.
5. If an item is not useful for you, click **Not useful** in the card. DataFlow then hides all items with the same pattern in this workspace, for example all copies of one type.
6. Use the Hidden C++ group of the lens bar:
   - To show or hide a category, click it. The number is the number of items of the category in the file.
   - To show the items that you marked as not useful again, click "hidden patterns: show them again".
7. For the items of the function at the cursor, click **Details**, then the tab **Hidden C++**.

A copy of a small trivially copyable type does not show. The setting `dataflow.cost.minCopyBytes` sets the size limit. The default is 16 bytes.

In a template, the code that depends on a template parameter has no copies, conversions or destructors. Only an instantiation has them. Thus Hidden C++ shows the items of the instantiations in the file at the lines of the template. It shows a maximum of 16 instantiations of each template. The card tells which instantiations have the item.

For a header with a template, DataFlow finds a source file of the project that includes the header. The engine parses that source file. Then Hidden C++ shows the items of the instantiations in the source file at the lines of the header. If no source file includes the header, the header has no instantiations.

| Setting | Default | Function |
| --- | --- | --- |
| `dataflow.cost.categories` | all categories | The categories of Hidden C++ that show: `copy`, `move`, `conversion`, `lifetime`, `destructor`, `allocation`, `lookup` and `state`. The category `lifetime` contains the temporaries and the variables that hide a variable of an outer scope. |
| `dataflow.cost.minCopyBytes` | `16` | A copy of a trivially copyable type of this size in bytes or less does not show. |

## Include Hierarchy

Include Hierarchy shows the includes of a file and the lines that each include adds.

1. Open a C++ file. Include Hierarchy is on by default. To turn it off or on, click **Includes** in the toolbar of the side view, or run **DataFlow: Toggle Include Hierarchy**.
2. Look at the include lines of the file. A hint after the code gives the lines that the include adds: the lines of the header and of the headers that it brings in, each header one time. An include that adds more than 10% of all lines has a hint in a strong color. These are the other hints:
   - **included before, by** a header: the header came in before, and its include guard or `#pragma once` skips it. The include adds nothing.
   - **possibly unused**: the file uses no name and no macro of the header, and it needs no header that the include brings in.
   - **→ struct Battery;** or **→ 3 forward declarations**: forward declarations can replace the include. The file uses the types of the header only in ways that need no full type, for example through a pointer or a reference.
   - **not found**: the preprocessor did not find the header.
3. Click a hint, or click **Details** and then the tab **Includes**:
   - The numbers give the lines of the file, the lines after the preprocessor, and the includes.
   - **Where the lines come from** shows the lines of each group: the file, the project headers, the C++ standard library, and the other libraries, for example Qt or the Windows SDK.
   - The tree shows the includes. To show the includes of a header, click its arrow. The bar and the number give the lines that each header adds.
   - Click a header. **Why … is in the file** shows the path of includes from the file to the header. To open the include line of a step, click the step.
   - Click an include of the file that has the badge **fwd**. The details show the forward declarations, and the lines that use each type. To put the declarations on the clipboard, click **Copy**. DataFlow does not change the file.
   - To make sure that the declarations are sufficient, click **Check**. The engine parses a copy of the file in memory with the declarations in the place of the include, and it shows the errors. An error in a header goes to the line of the file that causes it, for example a call that needs an instantiation. The parse takes the time of a full parse of the file.
   - Click a different include of the file. The details show the first line that needs the full header, and the reason, for example "a data member of the type".
4. Click **Included by**. It shows the places in the translation unit that include the selected header, and the translation units of the compile database that include it. A change to the header compiles these translation units again. If you select no header in a header file, Included by shows the translation units that include the file itself.

The check "possibly unused" uses these rules. Most of them are also the rules of clangd:

- A name belongs to the header that declares it, and a macro belongs to the header that defines it. A name of the C++ standard library also belongs to its public header, for example `std::string` to `<string>` and `INT32_MAX` to `<cstdint>`.
- A header also gives the names of the headers that it exports. A header that adds no code to the file, only directives and macros, exports all its includes, for example `<QTimer>`. An include with the comment `// IWYU pragma: export` is also an export. The same is true for an include between `// IWYU pragma: begin_exports` and `// IWYU pragma: end_exports`.
- The file can use a name of a header that no used include brings in. Then the first include that brings in the header is used, because the file needs it. Thus of two includes that bring in the same header, the check can mark only the second.
- An include with `// IWYU pragma: keep` or `// IWYU pragma: export` gets no check. A header that adds code and has no include guard gets no check, because it can be an X macro file.

The check of the forward declarations uses these rules:

- The check is for each used include of the file. The own header, the C++ standard library, the Windows SDK, the built-in headers of Clang and the other system headers get no check.
- The names of an include are the same names as for the check "possibly unused".
- Each name must be a class, a struct, a union, a class template or an enum with a fixed underlying type. The type must be at the scope of a namespace. A nested type, a type alias, a function, a variable, an enumerator and a macro need the header.
- A class template with default template arguments needs the header, because a forward declaration cannot give the default arguments again. A class template with a constraint, or with a non-type parameter that is not a builtin type or `auto`, also needs the header, because the concept or the type can be in the header. A type in an anonymous namespace or in an inline namespace also needs the header.
- Each use of a type must need no full type. Examples are a pointer, a reference, and a parameter or a return value of a function declaration with no body.
- A template argument of `std::shared_ptr`, `std::weak_ptr`, `TObjectPtr`, `TWeakObjectPtr`, `TSoftObjectPtr`, `TSubclassOf` or `QPointer` needs no full type. A template argument of a different template, for example `std::vector` or `std::unique_ptr`, needs the full type.
- These uses also need the full type: a variable, a data member, a base class, a member access, `sizeof`, `new`, `delete`, a definition of a member function, and a call of a function template with the type as an argument.
- A forward declaration uses the keyword of the definition, `class` or `struct`, because MSVC gives them different names.
- A file with parse errors gets no result, because the engine cannot see all uses.

The check does not see the code of the instantiations of templates. For example, an instantiation can need a specialization or a function that the header declares. **Check** finds these errors, because it parses the file. If a different include also brings in the header, the parse of **Check** shows no error, because the other include gives the full type.

For the translation units of Included by, the engine scans all source files of the compile database one time, with the dependency scanner of Clang. The scanner runs only the directives of the preprocessor, so `#if` and the include folders of each command count. It uses the unsaved text of the open files. On a Qt project with 89 source files, the scan takes about 3 s. The engine keeps the result until a file of the project changes on disk, or a directive of an open file changes.

After an edit of a function body, the hierarchy comes with no new pass of the preprocessor. An edit of an include line, of a macro definition or of a condition, for example `#if`, needs a new pass.

## Call Hierarchy

Call Hierarchy shows the callers and the called functions of a function, with the data of each call.

1. Put the cursor in a function. Call Hierarchy is on by default. To turn it off or on, click **Calls** in the toolbar of the side view, or run **DataFlow: Toggle Call Hierarchy**.
2. Look at the calls of the function. A call with data has a hint after the code, in the color of its kind:
   - **async on another thread**: the call is in a lambda that a thread or an async function runs. Examples are `std::thread` and the functions of the setting `dataflow.ripple.asyncFunctions`.
   - **event**: a call of an event function of the setting `dataflow.logic.eventFunctions`.
   - **optional not checked on line …**: the function returns `std::optional`, and the caller reads the value on that line with no check. **optional checked**: the caller checks the value.
   - **writes …**: the call gets a variable by non-const reference or by address, so it can change the variable.
3. Click **Details**, then the tab **Calls**. **Called by** and **Calls** show the callers and the called functions, with the data of the calls. To go to a call, click its line number. To put a function in the center, click the function.
4. Click **Show graph**. The graph over the code shows the callers on the left and the called functions on the right. A dashed box is a function in a different file. To put a function in the center, click it. To show one or two levels of calls, click **1 level** or **2 levels**.
5. The library calls, for example the calls of the standard library, do not show at first. To show them, click **Library calls**.
6. A virtual call also goes to the overrides of the function in the classes of the object. The graph draws these links dotted, and the tab Calls shows them as **virtual call**. An override in a library does not count.
7. To see all calls of a function, right-click its name in the side view, and click **Show Calls**. The name can be at the definition or at a call. In the text editor, right-click the name, or put the cursor on it and run **DataFlow: Show Calls**. A list shows over the code: the calls by file, each with its line, the function that calls and the code.
   - The calls in this file show immediately. The calls in other files come from the C/C++ extension or clangd.
   - To go to a call, click it. The list stays, so you can go from call to call. The arrow keys also go from call to call.
   - To close the list, push Escape, click ×, or click outside of the list.

The calls come from the source file and its headers. If the C/C++ extension or clangd is installed, Called by also shows the callers in other files. A request can stop the language server of the C/C++ extension. Thus DataFlow asks for these callers only while the tab Calls or the graph shows, or after a click on a function there. The extension can need some seconds to make its index.

A function in a different file shows only its calls from this file. For a function of a header, the tab Calls has the button **Open** with the name of its file. A caller in a different file also has this button. The file opens at the function, and Call Hierarchy shows all of its calls.

For a function whose body is in a different source file, the engine knows only its declaration. Click **Find the definition**: the C/C++ extension or clangd finds the definition, and its file opens with all calls of the function.

If a request to the call hierarchy of VS Code fails, DataFlow does not send more requests in that window. The tab Calls tells you this. A failed request can stop the language server of the C/C++ extension. VS Code restarts a language server only 5 times in 3 minutes.

## Threads and races

Threads and races shows the code that runs on a different thread and the data that two threads share. It also shows the lock or the order that protects each access.

1. Open a source file that starts a thread. Threads and races is on by default. To turn it off or on, click **Threads** in the toolbar of the side view, or run **DataFlow: Toggle Threads and Races**.
2. Look at the code. The code that runs on a worker thread has a purple background. A start of a thread and a join have a tag after the code, for example **starts solve_power_plan()** and **get() waits for solve_power_plan()**.
3. Click **Details**, then the tab **Threads**. The tab lists the thread starts and the shared data. Each item has a verdict:
   - **Race**: an access of the caller thread and an access of a worker thread can run at the same time. One of them writes, and no lock, no atomic and no order puts them in sequence.
   - **Check**: the same as Race, but a condition around the access of the caller thread can keep the threads apart, for example a state. The engine cannot see if it does. The item tells the conditions.
   - **Safe**: each pair of accesses has a common lock or an order, the threads only read the data, or the data is atomic. **Safe now**: only one thread uses a static or global variable.
   - **Check** or **Dangling** for the variables that a thread lambda captures by reference, if the thread can run after its function returns.
4. Click an item. The accesses of the item get boxes in the code. A red dashed box is an access of a race, and an orange dashed box is an access to check. The two lanes show the steps of the caller thread and of the worker thread in sequence: the accesses before the start, the start, the pairs that can run at the same time, the join, and the accesses after the join. To go to the line of a step, click the step.
5. If a condition reads the data before it checks the handle of the thread, as in `x && !future`, the item shows a possible fix: swap the two conditions.

The engine finds the thread starts of `std::thread`, `std::jthread`, `llvm::thread`, `boost::thread`, `QThread::create`, `QThread::run` and the functions of the setting `dataflow.ripple.asyncFunctions`. It also finds a job queue of the translation unit. An example is a thread pool with a function `post` that puts the callable into a container member. A job queue in a different source file needs its function in the setting. The engine goes into the functions that the code calls, in the file and in the project headers.

These items protect an access:

- the lock guards in scope, the `lock()` calls before their `unlock()`, and `std::lock`
- the locks that a called function takes, or returns as a guard
- a lock of a caller on the way to the access
- an atomic type
- a join or a `get()` of the handle before the access
- a check that the handle is empty or that the future is ready
- a start of the thread after the access

These calls are also joins:

- A call of a function that joins the thread in each run, for example `stop(w)` or `w.stop()`. This is also true if the start and the join get the object through different parameters.
- `if (t.joinable()) t.join();`
- A destructor that joins the thread of its object. The join is at the end of the block of the object, for example **~Worker() waits for run()**.
- The destructor of `std::jthread`, and the destructor of the future of `std::async`.

A local object is shared data if a thread uses it. For example, a thread lambda captures the object by reference. Or a call gives the object to a function that gives it to a thread, for example `start(w)` with `std::thread([&w]() { ... })`, or `w.start()` with `std::thread([this]() { ... })`. A `thread_local` variable is not shared data, because each thread has its own object.

The engine cannot see these items:

- a state that keeps two threads apart
- a lock that a function takes on a different object
- the callers in other files

## Heat

Heat shows how much a change of each function can break. Each function gets a score from 0 to 100. Flames in the code show the score.

1. Open a C++ file. Heat is off by default. To turn it on or off, click **Heat** in the toolbar of the side view, or run **DataFlow: Toggle Heat**. The side view shows a busy mark until the heat of the file is ready.
2. Look at the code. Each function has a strip in the color of its band next to the line numbers. The line of its name has 1 to 5 flames before the line number. To see the score, move the mouse on the flames.
3. To see the reasons of the score, click the flames, or click **Details**, then the tab **Heat**. The tab shows each point of the function at the cursor with its reason. It also shows the functions of the file, the hottest first. To show a function in the code, click it.

The score adds the points of three groups:

| Group | Maximum | Points |
| --- | --- | --- |
| Reach | 60 | The frame path, the callers of the function and their files, the part of the source files of the project that include the file with the declaration of the function, and a virtual function or an override. The callers are all functions that reach the function through calls, directly or through other functions. |
| Risk | 25 | The decisions, the nesting of the decisions, the writes to shared state, the data that two threads share, the allocations and the copies in loops, and a long body |
| History | 15 | The commits of the lines of the function, the commits that fix bugs, and a change in the last 30 days or a change that is not committed |

The color of the strip and of the flames shows the band: cool under 25, warm from 25, hot from 50 and very hot from 75. Each 20 points add one flame: 1 flame under 20, and 5 flames from 80.

If the reach of a function is less than 10, its risk and its history count half. Thus a complex function that only a small part of the project uses stays cool. The tab tells when this rule applies to the function at the cursor.

The history needs a git repository. For a file with changes that are not saved, git uses the text of the editor.

The theme colors `dataflow.heatCool`, `dataflow.heatWarm`, `dataflow.heatHot` and `dataflow.heatVeryHot` give the colors of the bands. The MCP tool `get_heat` gives the scores and their reasons to a language model.

In a guided review and in a diff walk, each step in the tab **Guide** shows the flames and the score of its hottest function while Heat is on. The tools `get_review` and `get_diff` give the heat of the changed functions to the model, and the model starts its plan with the hottest changes. See [Guided review](tools.md#guided-review) and [Diff walk](tools.md#diff-walk).

### The call graph

The callers and the frame path come from the call graph of the project. When you turn on Heat, the engine starts to scan the call graph. The scan does not block DataFlow:

- The tab **Heat** shows the progress of the scan: the source files that the scan parsed, and all source files. To stop the scan, click **Stop**. To continue it, click **Continue**. The next scan parses only the source files that the stopped scan did not parse.
- Until the scan is complete, the scores have no callers and no frame path, and a note in the tab tells this. At the end of the scan, the scores come again with the callers and the frame path.
- The scan parses the source files of the compile databases in the project folders. It skips the folder of a compile database in a project folder, and the folders `_deps` with the libraries that CMake fetches.
- The scan uses half of the threads of the engine. A large project can take some minutes, for example an Unreal project.
- When you save a C or C++ file, the call graph is old. With Heat on, an update starts immediately. The update parses only the source files that include a changed file.

A function on the frame path runs in each frame. It gets 40 points, and 10 more points if a caller on the frame path calls it in a loop. A frame path starts at a frame function:

- An override of a frame function of Unreal Engine: `AActor::Tick`, `UActorComponent::TickComponent`, `UUserWidget::NativeTick`, `SWidget::OnPaint` or `FTickableGameObject::Tick`.
- An override of a frame function of Qt: `QWidget::paintEvent`, `QOpenGLWidget::paintGL`, `QObject::timerEvent` or `QQuickItem::updatePaintNode`.
- A function that a main loop calls. A main loop is a loop with no fixed number of iterations in `main`. Examples are `while (!window.should_close())` and `for (;;)`. If `main` has no main loop, DataFlow looks in the functions that `main` calls. A loop with a counter, for example `for (int i = 0; i < 100; ++i)`, is not a main loop. A loop that empties a container, for example `while (!errors.empty())`, is also not a main loop.
- A function of the setting `dataflow.heat.frameFunctions`, for example `Renderer::frame`. A name is a qualified name, or the end of a qualified name after `::`.

The frame path follows a maximum of 8 calls from a frame function. To see the frame functions of the project, open **Call graph** at the end of the tab **Heat**. To show a frame function in the code, click it.

## Change Ripple

Change Ripple shows the code that the changes of your branch affect, as a story for a review.

1. Open a folder of a git repository with a compile database.
2. Click **Change Ripple** in the toolbar of the side view, or run **DataFlow: Review Changes**. DataFlow compares the files with the merge base of the active branch and its target branch. The side view opens and shows the story of the review.
   - The comparison includes the changes that are not committed.
   - For a file with changes that are not saved, DataFlow compares the text of the editor, because the engine analyzes this text.
3. Look at the story of the change:
   - The diff shows the old lines and the new lines of the change, with the lines around them. The changed characters have a darker background.
   - The facts under the diff give the number of changed lines, functions, async boundaries, steps and exits.
   - The chain "Where the change goes" has one card for each function and each lambda that the change affects. A card shows the lines of the ripple with their code. A note after the code tells why the line is in the ripple. If the note does not fit next to the code, it shows under the line.
   - A change that a lambda captures goes into the lambda if the function calls the lambda, for example `auto f = [&] { ... }; f();`.
   - An arrow between two cards tells how the change goes to the next card: a return to a caller, a lambda, or an async call. A card of a caller is more to the right, and a line goes from the chain to its dot. The callers of a function come after its card.
   - The exits are at the end of a card. An exit is a point where the effect leaves the analysis. Examples are a reference argument of a call, and a call of a function that a changed decision controls.
   - A card with a dashed border has only estimated lines. The change possibly affects these lines, through the state of an object or through an async call.
4. Look at the wave. It lights the lines and the cards in the sequence of the ripple. To see the wave again, click **Replay ripple**.
5. Click a line or the name of a card. The side view shows the file at the line, and the editor goes to the line. In the file view, the lines of the ripple have a purple background, and a changed line has a bar next to its line number.
6. To go back to the story, click **Story** in the Change Ripple bar. To show the file of the editor, click **File view**.
7. To compare the file with the merge base, click **Open the diff editor**.
8. If the review has more than one changed function, select the change in the Change Ripple bar.
9. When you save a C or C++ file of the repository, the review runs again. The story shows the old review until the new review is complete. After a change that you did not save, click **Review again**.
10. To remove the review and the Change Ripple bar, click **Clear**, or run **DataFlow: Clear Review**.

A restart of the engine runs the review again, for example after a change of the compile database. If the engine does not start, the story tells why.

The review works on more than one changed file at the same time. The number of files is one less than the setting `dataflow.engine.cacheSize`, because each file keeps its parse until its ripple is complete.

Change Ripple goes from a return value to the callers of the function. The engine finds the callers in the same file. For the callers in other files, Change Ripple uses the call hierarchy of the C/C++ extension or of clangd. If neither is active, the story tells you.

### Select the target branch

The target branch is the branch that the active branch merges into, for example `origin/dev`. Change Ripple shows the changes since the merge base of the two branches, and the changes that are not committed. This is the diff of a pull request, with your changes that are not committed.

Git does not record the branch that a branch comes from. VS Code records it when you create a branch in VS Code. You can also select the target branch:

1. Click **Target** in the Change Ripple bar, or run **DataFlow: Select Target Branch**.
2. Select a branch. The review starts again with the new target branch.
   - **Automatic** uses the branch that the active branch comes from, as VS Code records it in `branch.<name>.vscode-merge-base`. If there is no such branch, it uses the default branch of the remote (`origin/HEAD`), then `origin/main`, `main`, `origin/master` or `master`.
   - **HEAD** shows only the changes that are not committed.

DataFlow keeps the target branch of each branch of a repository, also for a project that is not open in VS Code. Thus a hotfix branch for `master` and a feature branch for `dev` keep their target branches. If you did not select a target branch and DataFlow finds no automatic target branch, the list opens when the review starts.

| Setting | Default | Function |
| --- | --- | --- |
| `dataflow.ripple.baseRef` | empty | The target branch if you did not select one with **Target**. If the setting is empty or its ref does not exist, Change Ripple uses the automatic target branch. A different ref is also possible, for example `HEAD~1` for the last commit. |
| `dataflow.ripple.maxDepth` | `2` | The number of caller levels that Change Ripple analyzes after a return value |
| `dataflow.ripple.asyncFunctions` | `std::async`, `QtConcurrent::run`, `tf::Executor::async`, `Async`, `AsyncTask`, `AsyncThread`, `AsyncPool`, `UE::Tasks::Launch` | Functions that run a callable on a different thread. Change Ripple continues with their result. |

## Commands and keys

Run the commands from the Command Palette (Ctrl+Shift+P). The keys work when the text editor has the focus and the language of the file is C, C++ or CUDA C++.

| Command | Key | Function |
| --- | --- | --- |
| **DataFlow: Open Side View** | | Opens the side view beside the editor. |
| **DataFlow: Open Project…** | | Shows a list: a file of the open project, a different project folder, and the last projects. |
| **DataFlow: Open Project Folder…** | | Selects the folder of a project that is not open in VS Code, or its build folder. |
| **DataFlow: Open File of the Project** | | Opens a C or C++ file of the project. The command shows only when a project is open. |
| **DataFlow: Close Project** | | Closes the project. The command shows only when a project is open. |
| **DataFlow: Select Compile Database** | | Selects the compile database. |
| **DataFlow: Make Unreal Compile Database** | | Lets UnrealBuildTool make the compile database of an Unreal Engine 5 project. See [Unreal Engine projects](#unreal-engine-projects). |
| **DataFlow: Restart Engine** | | Starts the engine again. |
| **DataFlow: Show Log** | | Shows the log of DataFlow. |
| **DataFlow: Trace Variable** | Ctrl+Alt+F | Starts Flow Lens on the variable or the data member at the cursor. |
| **DataFlow: Clear Trace** | | Removes the trace of Flow Lens. |
| **DataFlow: Toggle Logic Map** | | Turns Logic Map on or off. |
| **DataFlow: Why Does This Line Run** | | Shows the decisions and the values that the line at the cursor needs. |
| **DataFlow: Reset Logic Map Choices** | | Removes your choices in Logic Map. |
| **DataFlow: Show Card at Cursor** | Ctrl+Alt+K | Shows the card of the item at the cursor, or closes it. |
| **DataFlow: Toggle Hidden C++** | Ctrl+Alt+H | Turns Hidden C++ on or off. |
| **DataFlow: Toggle Include Hierarchy** | | Turns Include Hierarchy on or off. |
| **DataFlow: Toggle Call Hierarchy** | | Turns Call Hierarchy on or off. |
| **DataFlow: Toggle Threads and Races** | | Turns Threads and races on or off. |
| **DataFlow: Toggle Heat** | | Turns Heat on or off. |
| **DataFlow: Show Calls** | | Shows all calls of the function at the cursor in a list. |
| **DataFlow: Outline** | | Shows the outline of the class, the struct, the union or the enum at the cursor. See [Outline of a type](#outline-of-a-type). |
| **DataFlow: Go to Definition in the Side View** | F12 in the side view | Goes to the definition of the name at the cursor of the side view. See [Go to a definition](#go-to-a-definition). |
| **DataFlow: Go Back in the Side View** | Alt+Left in the side view | Goes to the place before the last jump of the side view. |
| **DataFlow: Go Forward in the Side View** | Alt+Right in the side view | Goes to the place that the last **Go Back** left. |
| **DataFlow: Review Changes** | | Starts Change Ripple. |
| **DataFlow: Clear Review** | | Removes the review of Change Ripple. |
| **DataFlow: Select Target Branch** | | Selects the target branch of Change Ripple. |
| **DataFlow: Connect to Claude Code** | | Gives the tools of DataFlow to Claude Code. See [Use the MCP tools](tools.md#connect-claude-code). |
| **DataFlow: Disconnect from Claude Code** | | Removes the connection to Claude Code. |
| **DataFlow: Start MCP Server** | | Starts the MCP server of this window. |
| **DataFlow: Stop MCP Server** | | Stops the MCP server of this window. |
| **DataFlow: Copy MCP Setup** | | Puts the setup of an MCP client on the clipboard. |
| **DataFlow: Show or Hide Model Layers** | | Shows or hides the blocks, the notes, the comments and the details of the model. |
| **DataFlow: Remove Model Layers** | | Removes the blocks, the notes, the comments and the details of the model. |
| **DataFlow: Walk Through the Changes** | | Starts a diff walk: one step for each changed function, with the diff of each step. See [Diff walk](tools.md#diff-walk). |
| **DataFlow: Next Guide Step** | | Goes to the next step of the guided review or of the diff walk. The commands of the guide show only while a guide shows. See [Guided review](tools.md#guided-review). |
| **DataFlow: Previous Guide Step** | | Goes to the step before the current step of the guide. |
| **DataFlow: Copy Guide Summary** | | Puts the summary of the guide on the clipboard, in Markdown. |
| **DataFlow: Close Guide** | | Removes the guided review or the diff walk from the side view. |

## All settings

| Setting | Default | Function |
| --- | --- | --- |
| `dataflow.compileCommands` | empty | The path to `compile_commands.json`, to a folder that contains it, or to a qmake build folder. An array gives more than one database. A relative path starts at the workspace folder. |
| `dataflow.unreal.enginePath` | empty | The folder of the Unreal Engine of the project: the folder that contains the folder `Engine`. If it is empty, DataFlow uses the engine of `EngineAssociation` in the `.uproject` file. See [Unreal Engine projects](#unreal-engine-projects). |
| `dataflow.unreal.target` | empty | The target of the compile database of an Unreal project, for example `MyGameEditor`. If it is empty, DataFlow uses the editor target of the project. |
| `dataflow.unreal.configuration` | `Development` | The configuration of the compile database of an Unreal project: `Debug`, `DebugGame`, `Development`, `Test` or `Shipping`. |
| `dataflow.unreal.arguments` | `[]` | More arguments for UnrealBuildTool when it makes the compile database of an Unreal project, for example `-Verbose`. |
| `dataflow.project.skipFolders` | `.*`, `node_modules`, `_deps`, `out`, `build`, `builds`, `build-*`, `build_*`, `build.*`, `cmake-build-*`, `Binaries`, `DerivedDataCache`, `Intermediate`, `Saved` | The names of the folders that the list of the files of a project skips, for example build folders. A `*` is any text, and a `?` is one character. The case of the letters is not important. The list also skips the `debug` and `release` folders next to the Makefiles of qmake. |
| `dataflow.engine.path` | empty | The path to `dataflow-engine`. If it is empty, DataFlow uses the engine of the extension. |
| `dataflow.engine.maxThreads` | `0` | The number of parse threads. `0` uses half of the processor cores. The engine never uses more than 80% of the cores. |
| `dataflow.engine.cacheSize` | `4` | The number of parsed files that the engine keeps in memory, from 1 to 64. |
| `dataflow.animations` | `on` | The animations in the side view, for example the pulse of Flow Lens and the wave of Change Ripple: `on` or `off`. If `workbench.reduceMotion` is on, DataFlow shows no animations. |
| `dataflow.logic.eventFunctions` | `[]` | Functions that send events, for example `fire_transition`. Logic Map shows a call of one of these functions as an event, if the call has a string argument that is not empty. Call Hierarchy shows each call of one of these functions as an event. A name with `::` is a qualified name. |
| `dataflow.logic.nullableFunctions` | `[]` | Functions that can return a null pointer, for example `get_if`. Logic Map shows a warning if the code dereferences the result with no null check on the path. The result can also be a `std::unique_ptr`, a `std::shared_ptr` or a `std::optional`. |
| `dataflow.logic.nullCheckFunctions` | `[]` | Functions that check a pointer from `dataflow.logic.nullableFunctions`, for example `is_valid`. In a condition, a call with the pointer is a null check: the pointer is not null if the call gives true. |
| `dataflow.flow.readFunctions` | `[]` | Functions that only read their arguments and their object, for example `log_value` or `Config::get`. Flow Lens shows a call of such a function as a read, not as a possible write. Use a qualified name with `::` or a simple name. The format functions of std, fmt and spdlog are reads already. |
| `dataflow.cost.categories` | all categories | The categories of Hidden C++ that show: `copy`, `move`, `conversion`, `lifetime`, `destructor`, `allocation`, `lookup` and `state`. The category `lifetime` contains the temporaries and the variables that hide a variable of an outer scope. |
| `dataflow.cost.minCopyBytes` | `16` | A copy of a trivially copyable type of this size in bytes or less does not show in Hidden C++. |
| `dataflow.heat.frameFunctions` | `[]` | More frame functions for Heat, for example `Renderer::frame` or `frame`. A frame function runs in each frame, and the functions that it calls are on the frame path. A name is a qualified name, or the end of a qualified name after `::`. See [The call graph](#the-call-graph). |
| `dataflow.ripple.asyncFunctions` | `std::async`, `QtConcurrent::run`, `tf::Executor::async`, `Async`, `AsyncTask`, `AsyncThread`, `AsyncPool`, `UE::Tasks::Launch` | Functions that run a callable on a different thread and return its result. Change Ripple continues with the result of a call of one of these functions, and marks the step as async. Flow Lens shows the callable of a data member trace on a different thread. Call Hierarchy shows the calls in the callable as calls on a different thread. Threads and races shows the callable as a worker thread. A name with `::` is a qualified name. |
| `dataflow.ripple.baseRef` | empty | The target branch of Change Ripple, if you did not select one with **Target** in the Change Ripple bar. Change Ripple compares the files with the merge base of `HEAD` and this ref. If the ref starts with `origin/` and does not exist, Change Ripple uses the local branch. If the ref is empty or does not exist, Change Ripple uses the default branch of the remote, then `origin/main`, `main`, `origin/master` or `master`. |
| `dataflow.ripple.maxDepth` | `2` | The number of caller levels that Change Ripple analyzes after a return value, from 0 to 5. |
| `dataflow.mcp.enabled` | `false` | Start the MCP server of DataFlow when the extension starts. The agent mode of VS Code starts the server when it needs it. See [Use the MCP tools](tools.md). |
| `dataflow.mcp.port` | `47321` | The port of the MCP server on 127.0.0.1, from 0 to 65535. If a different program uses the port, the server takes a free port. `0` always takes a free port. |
