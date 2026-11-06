# dataflow-engine

The analysis engine of DataFlow. It reads JSON-RPC requests on stdin and writes the replies on stdout. The messages use the headers of LSP.

## Necessary software

- Visual Studio 2022 with the C++ workload, MSVC 19.44 or later
- CMake 3.24 or later, and Ninja
- LLVM 23.1.4 for development: `clang+llvm-23.1.4-x86_64-pc-windows-msvc`
- zlib 1.3.2 and zstd 1.5.7 as static libraries, built with the static MSVC runtime (`/MT`)

Put LLVM, zlib and zstd in one folder:

```text
C:\Users\<user>\.cache\dataflow\
  llvm-23.1.4\
  zlib\
  zstd\
```

## Build the engine

Run this command in the root folder of the repository:

```bat
npm run build:engine
```

The script `scripts/build-engine.mjs` does these steps:

1. If `build/engine` has no CMake cache, the script configures the build with Ninja and the configuration Release. The environment variable `DATAFLOW_DEPS_DIR` gives the folder with LLVM, zlib and zstd. The default is `~/.cache/dataflow`.
2. The script builds the engine with a maximum of 80% of the processor cores. To set a different number, add `-- --jobs <n>` to the command.

On Windows, the script also does these steps:

- If `cl` is not in the `PATH`, the script uses the environment of `vcvars64.bat` of Visual Studio 2022.
- If a process runs `dataflow-engine.exe`, for example the engine of a VS Code window, the script renames the file before the build. Windows does not let the linker write a program that runs. The process continues with the renamed file. After the build, run **DataFlow: Restart Engine** in VS Code. The next run of the script removes the renamed files that no process runs.
- After the build, the script stops the processes `vctip.exe` and `mspdbsrv.exe` that the build started. Without this step, they stay alive for some minutes.

To build the engine without the script, open the "x64 Native Tools Command Prompt for VS 2022" in the root folder of the repository. Then run these commands:

```bat
cmake -S engine -B build/engine -G Ninja -DCMAKE_BUILD_TYPE=Release -DDATAFLOW_DEPS_DIR=C:/Users/<user>/.cache/dataflow
cmake --build build/engine -j <jobs>
```

The result is `build/engine/dataflow-engine.exe`. The build also copies the builtin headers of Clang to `build/engine/lib/clang/23/include`. The engine finds them there.

## Compile commands

The engine parses each file with the command of its compile database, with these changes. The engine never runs a command.

- The parse makes no output file and no dependency file, and it shows no warnings.
- The engine removes the options that load plugins into the compiler.
- The engine removes a response file that does not exist, and the options of the C++ modules of MSVC, for example `-reference` and `-ifcOutput`. CMake gives MSVC a module map for each source file, for example `@game\CMakeFiles\Game.dir\src\main.cpp.obj.modmap`, and Ninja writes it only in a build. Before the build, the driver takes the missing file as a second source file.
- In a command of MSVC or clang-cl, the engine removes `/sourceDependencies` and `/experimental:log` with their files, and each option that clang-cl does not know. An example is `/dximplicitlyinstantiatevirtualfunction-` of UnrealBuildTool. The driver of clang-cl takes an unknown option as a source file.
- In a command of MSVC (`cl.exe`), a `##` that gives no valid token is not an error, as in MSVC. Clang defines `_MSVC_TRADITIONAL` as 1 and ignores `/Zc:preprocessor`, thus Unreal Engine uses such a `##` for the traditional preprocessor of MSVC.
- An include folder of the builtin headers of a different Clang, `<...>/lib/clang/<version>/include`, becomes the folder of the builtin headers of the engine. The engine also removes `-resource-dir`. For example, Qt Creator writes `-nostdinc` and `/clang:-isystem /clang:<Qt Creator>/bin/clang/lib/clang/22/include` into its compile database for clangd. The builtin headers of Clang 22 do not agree with the builtins of Clang 23.
- A file with a context of `dataflow/context` gets the command of its source file. A forced include of a virtual file comes first: the lines of the source file before the `#include`. The virtual file is in the folder of the source file, so an `#include "x.h"` of these lines finds its file. `#line` gives an error in these lines its place in the source file.

## Requests

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | `compileCommands` (a path or an array), `resourceDir`, `maxThreads`, `cacheSize` | The versions, the compile databases with their number of files, the threads and the cache size |
| `textDocument/didOpen`, `didChange` | `file`, `text`, `version` | No reply. The engine parses this text, not the file on disk. |
| `textDocument/didClose` | `file` | No reply. The engine reads the file on disk again. |
| `dataflow/context` | `file`, `unit`, `line` | No reply. The engine parses the file after the lines of the source file `unit` before line `line`, the line of the `#include`. With no `unit`, the engine parses the file alone again. |
| `dataflow/functions` | `file` | The function definitions of the file. A template is in the list one time, with no instantiations. If `##` in a macro makes the name of a function or of its class, the function also has `macroCall`: the text of the macro call on one line, for example `TEST_CASE("split")` of Catch2 or `TEST(Pool, Post)` of GoogleTest. |
| `dataflow/functionAt` | `file`, `line`, `col` | The innermost function at the position, or null. If the position is in the body of a lambda in the function, `lambda` gives the index of the innermost lambda in the function and its range |
| `dataflow/cfg` | `file`, and `function` or `line` and `col` | The control flow graph of the function, as JSON |
| `dataflow/optionalAccess` | `file`, and `function` or `line` and `col` | The unchecked accesses to `std::optional` values in the function |
| `dataflow/flow` | `file`, and `function` or `line` and `col`; `readFunctions` | The variables of the function, the references with their roles, and the edges from the definitions to the uses |
| `dataflow/calls` | `file`, `eventFunctions`, `asyncFunctions`, `roots` | The call graph of the functions of the file: the functions, and each call with its data |
| `dataflow/includes` | `file`, `roots` | The include hierarchy of the translation unit: the includes with their files and lines, the groups of the files, the uses of the includes of the main file, and the forward declarations that can replace them |
| `dataflow/inactive` | `file` | `ranges`: the first and the last line of each block of the main file that a condition of the preprocessor skips, for example `#if 0`. The lines of the directives are not in the ranges. The request uses the pass of the preprocessor of `dataflow/includes`. A file with no `#if`, `#ifdef` or `#ifndef` needs no pass. |
| `dataflow/includers` | `file`, `roots` | The source files of the compile databases that include the file. The request needs no parse. |
| `dataflow/threads` | `file`, `asyncFunctions`, `roots` | The thread starts of the file, the data that two threads share, and the protection of each access: locks, joins, checks of the handles and conditions. |
| `dataflow/member` | `file`, and `line` and `col` or `className` and `member`; `asyncFunctions`, `readFunctions`, `roots`, `entries` | A data member of a class, a static data member or a global variable, and its accesses in the translation unit, with their roles, threads and locks. `member` is null if no member is at the position. |
| `dataflow/logic` | `file`, `function` or `line` and `col`, `lambda`, `eventFunctions`, `nullableFunctions`, `checkFunctions` | The CFG blocks, the decisions, the else-if chains, the events, the nullable pointers and the effects of the function, or of a lambda in it |
| `dataflow/structure` | `file`, `function` or `line` and `col`, `eventFunctions`, `asyncFunctions` | The statements of the function with their lines, branches and items, and the accesses with their paths, roles and scopes |
| `dataflow/cost` | `file`, `minCopyBytes`, `unit` | The hidden C++ of all functions of the file: copies, conversions, temporaries, destructors, lookups and more. With `unit`, a source file that includes the header `file`, the engine parses the unit. Then the templates of the header get the items of their instantiations in the unit. The reply then has the parse of the unit. |
| `dataflow/slice` | `file`, and `lines` and `deleted`, or `call`; `asyncFunctions`, `confidence` | The forward slice of changed lines or of a call: the steps and the exits in each function and lambda, and the callers in the same file |
| `dataflow/tokens` | `file`, `first`, `last`, `bracketLevelPerType` | The text and the tokens of the lines `first` to `last`. The default is all lines. With `bracketLevelPerType`, the level of a bracket counts only the brackets of its type. |
| `dataflow/definition` | `file`, `line`, `col` | The definition of the name at the position: `name`, `kind` (the kind of its token) and `targets` with `file`, `line`, `col` and `role`. The role is `definition` if the translation unit has the definition, else `declaration`, the first declaration. A macro gives its `#define`. The file of an `#include` gives the file with the role `file`. A position right after a name also gives the name. The walk of the names of `dataflow/tokens` finds the declaration of each name. |
| `dataflow/outline` | `file`, and `line` and `col` or `name` | The outline of the class, the struct, the union or the enum of the name at the position, or of the qualified name: `outline` with the kind, the bases, the members in the sequence of the source, the layout with the holes of padding, and the members of the bases. A member that a macro makes has `macro`. The text of an annotation macro before a member, for example `UPROPERTY(...)`, is in `annotation`. A type with no definition in the translation unit gives `outline: null` and `declaration`. |
| `$/cancelRequest` | `id` | No reply. The request stops with the error code -32800. |
| `shutdown`, `exit` | none | The engine stops. |

Lines and columns start at 1. The replies for a file also contain `parsed`, `parseMs`, `parseCount`, `errorCount`, `errors` and `analysisMs`. `parseCount` is the number of the parse. Each parse of each file gets a new number. `preambleBuilds` is the number of preambles that the parses of the file built. During a parse, the engine sends the notification `dataflow/status`.

A request with `function` finds the function by its name. A name can be qualified. If overloads have the name, `line` selects the overload that contains the line, or the overload that starts nearest to it.

The engine parses a file again if its text changed, or if the text of a different open file changed, because the file can include it. Clang keeps the preamble if no header of the preamble changed. The preamble also has the instantiations of the templates that the code of its headers needs, through `-fpch-instantiate-templates`. Without them, each parse of the main file instantiates these templates again at its end. For example, a parse of the `main.cpp` of the engine after an edit takes 0.25 s, and 6.5 s without them. The first parse takes about 10% more time.

The analyses that use the matchers of Clang, for example the `ExprMutationAnalyzer`, limit the traversal scope of the AST to the functions that they analyze. The first matcher that asks for the parent of a node builds the parent map of the traversal scope. The parent map of the full translation unit with all headers can take seconds.

## The result of `dataflow/flow`

- `variables`: the parameters, the local variables, the static locals and the structured bindings of the function. Each variable has `name`, `type`, `storage` and `declRef`. `declRef` is the index of the declaration in `refs`.
- `refs`: each declaration and each use of a variable. Each reference has `var`, `role`, `line`, `col` and `len`. `alsoRead` is true for a write that also reads the old value, for example `x += 1`. `finding` gives a problem at the reference, for example `unchecked optional access`.
- `edges`: pairs of indexes in `refs`. Each pair goes from a definition to a use that the definition can reach.
- `hasCfg`: false if Clang made no control flow graph for the function. Then the result has the variables and the references, but no edges.
- `cached`: true if the result comes from the same parse and the same options. The engine keeps the results of a parse until the next parse.

A variable is in the result only if the main file contains the text of one of its references. Thus the result does not contain a variable that a macro of a different file declares and uses in its body, for example `catchAssertionHandler` of Catch2. A variable from a macro stays in the result if the code of the main file uses it.

The operands of `sizeof`, `alignof`, `decltype`, `noexcept`, a `requires` expression, an unevaluated `typeid` and a `static_assert` do not run, so they give no references.

The control flow graph of a function does not contain the bodies of its lambdas. A reference in a lambda body takes effect at the lambda expression: a use gets the definitions that reach the lambda, and a write is a definition that does not stop the old definitions.

Clang makes no control flow graph for a template with a range-based `for` loop on a dependent range: the loop has no begin, no end, no condition and no increment. While Clang builds the graph, the engine gives such a loop placeholders that contain no variable of the user. All analyses that use a graph get the graph of such a function: Flow Lens, Logic Map, the members, Hidden C++ and Change Ripple.

The roles are:

| Role | Description |
| --- | --- |
| `def` | The declaration of the variable |
| `write` | An assignment, an increment or a decrement. The old value does not reach the uses after it. |
| `mayWrite` | A call of a non-const member function, a non-const reference, or a write to a member. The old value can also reach the uses after it. |
| `check` | A read in the condition of an `if`, a loop, a `switch` or a `?:` |
| `read` | All other uses |

The engine uses the `ExprMutationAnalyzer` of Clang. A reference in an lvalue-to-rvalue conversion and a variable of a const type need no query, because they are reads. The analyzer reports each call of a non-const member function as a change. The engine changes these calls to reads:

- `->`, `*` and `[]`, and the accessors `value`, `get`, `front`, `back`, `at` and `data`, if the code only reads through the result
- the format functions of the standard library, of fmt and of spdlog, for example `std::format`, `fmt::print` and `spdlog::info`, and the functions of `readFunctions`
- a `return` statement that returns a copy of the variable

In a template, the analyzer reports each operand of a dependent operator and each argument of an unresolved call as a change. The engine changes these to reads:

- the index of a subscript
- an operand of a dependent operator that is not an assignment. The left operand of `<<` and `>>` stays a possible write, because it can be a stream.
- an argument of a dependent construction, for example `T(x)`
- an argument of an unresolved call if no candidate takes it by a reference to non-const, by a forwarding reference or by a pointer to non-const. The candidates are the functions that the name lookup of the template finds, also in the namespaces of the arguments, with a fitting number of parameters.
- the object of an unresolved call if all candidates are const member functions

## Templates

In a template, Clang does not resolve the code that depends on a template parameter. A header-only library often has no instantiation in its own translation unit, so the engine analyzes the template itself. The function list has no instantiations, so all requests analyze the template:

- A member access through an object of a dependent type, for example `_b.isFlat_` with `_b` of type `Bucket<T, N>&`, gives the data member of the class template, also through an alias template, a nested class or a base class. `dataflow/member`, `dataflow/structure` and `dataflow/threads` use it as a data member.
- An access of a member of a specialization, for example `Bucket<float, 10>::isFlat_`, is an access of the member of the class template.
- A call with no callee gets the candidates of the name lookup of the template with a fitting number of parameters. A name with no namespace also gets the functions of the namespaces of the arguments, as the argument dependent lookup of the instantiation does. The arguments that do not depend on a template parameter sort the candidates: a candidate that cannot take one of these arguments goes away, and the candidate with the best fit comes first. The fit compares the types, the references and the standard conversions. A conversion of a class that the engine cannot check keeps the candidate. If no candidate fits, the engine keeps all of them. `dataflow/calls`, `dataflow/structure`, `dataflow/threads` and the threads of `dataflow/member` use the first candidate.

The template does not contain the implicit operations of the code that depends on a template parameter, for example the copies of a type `T`. Only an instantiation contains them. Thus `dataflow/cost` also analyzes a maximum of 16 instantiations of each template of the translation unit, and it shows their items at the lines of the template. A header that the engine parses alone has no instantiations of its own templates.

The column `col` and the length `len` count UTF-8 bytes.

## The result of `dataflow/calls`

The engine collects the calls in the functions of the main file. A call in a lambda belongs to the function around the lambda. The engine keeps the result until the next parse.

- `functions`: the functions of the main file first, then the functions that they call. Each function has `name`, `qualifiedName`, `kind`, `file`, `line`, `col`, `len`, `where` and `isDefined`, and `macroCall` as in `dataflow/functions`. `kind` is `function`, `method`, `constructor`, `destructor` or `lambda`. The position is the name of the definition, else of the declaration. `where` is `main` (the main file has the definition), `library` (a system header, the namespace `std`, or a file outside of `roots`) or `project`. A function of the main file also has `range` with the first and the last line.
- `calls`: each call. Each call has `from`, `to`, `line`, `col` and `result`. `from` and `to` are indexes in `functions`. The position is the called name. `result` is `none` (the function returns nothing), `discarded`, `returned`, `stored`, `checked` (in a condition) or `used`.
- A call can also have `inLambda`, `async` (the thread start that runs the lambda of the call, for example `std::thread` or a function of `asyncFunctions`), `event` (a function of `eventFunctions`), `writes` (the arguments that the call gets by non-const reference or by address), `into` (the variable that stores the result) and `optional`. `optional` is `unchecked` if the caller reads the `std::optional` result with no check, with `uncheckedLine`, or `checked` if it checks the result before the reads. The unchecked access model of Clang finds the reads with no check.
- A virtual call also goes to each override of the function in the classes of the object, also to the overrides of the overrides. Each override is one more call with the same position and the same data, and `virtualOf` gives the index of the function that the call names. A call with a qualifier, for example `Base::run()`, a final function and an object of a final class have no overrides. The engine finds the overrides in the main file and in the folders of `roots`, not in a library.

## The result of `dataflow/includes`

The engine runs the preprocessor one more time, with the command and the unsaved text of the parse. The parse keeps the includes in a preamble, so its own preprocessor does not read them again. The engine keeps the result until the next parse. A later parse uses the pass of the preprocessor again while these items stay the same: the command, the preamble, the text of the other open files, and the directives of the main file with their lines. Thus an edit of a function body needs no new pass. `roots` gives the folders of the project.

- `files`: the files that the preprocessor entered. Each file has `path`, `lines`, `group` and `isSystem`. The group is `this file`, `project headers` (a file in `roots`, or a user header if `roots` is empty), `C++ standard library`, `Windows SDK`, `Clang built-ins`, `system headers`, or the name of a library. The name of a library is the first folder after the include folder, for example `Eigen` or `nlohmann`, or the name of the include folder. All Qt folders are `Qt`.
- `nodes`: the main file first, then each include directive in the sequence of the preprocessor. Each node has `file`, `parent`, `line`, `spelled` and `state`. `line` is the line of the directive in the file of the parent. An include of the command line, for example `-include`, has the main file as its parent and the line 0. `state` is `main`, `entered`, `skipped` or `missing`. A skipped node has `first`: the node that entered the file before. A missing node has the file -1.
- An entered header that the main file includes has `isUsed`, and `use` with the name, the line and the node of the first use. The node is the include of the file of the name. `isOwn` is true for the header of the main file, for example `a.h` for `a.cpp`. The main file uses a header if it uses one of these names or macros:
  - A name that the header declares, or a macro that the header defines. A name or a macro of the C++ standard library also belongs to its public headers, from the table of Clang (`clangToolingInclusionsStdlib`), for example `std::string` to `<string>`.
  - A name of a file that the header exports. A header that gives no tokens after the preprocessor, only directives and macros, exports all its includes. The pass of the preprocessor counts the tokens of each include. An include with `IWYU pragma: export`, or in a block of `IWYU pragma: begin_exports` and `IWYU pragma: end_exports`, is also an export. An exported include that the preprocessor skipped gives the file of the first include of the file. The exports of an open file come from its unsaved text.
  - A name of a file that no used include brings in. The first include that brings in the file gets the use. The files that only one include brings in come first.
- These includes have no `isUsed`: an included source file, for example `moc_x.cpp`, a header that gives tokens and has no include guard, and an include with `IWYU pragma: keep` or `IWYU pragma: export`.
- The macros that the main file uses come from the names in its text and the macros of the headers in the pass. A name in a range that a condition skips, or in a directive other than a condition, for example `#define`, is no use.
- A used include of the main file has `forward`, the forward declaration check. The own header, the C++ standard library, the Windows SDK, the Clang built-ins and the system headers get no check. A parse with errors gives no check, because the ast is not complete.
  - `state: "possible"`: forward declarations can replace the include. `text` gives the declarations, one line for each namespace, for example `namespace power { struct Battery; }`. Before C++17, each namespace gets its own braces. `types` gives each type with the lines of the main file that use it.
  - `state: "needed"`: `blocker` gives the first use that needs the include, with `name`, `kind` and `line`. The kind is the use that needs the full type, for example `a data member of the type` or `a member access`, or the name that has no forward declaration, for example `a macro`, `a function` or `a type alias`.
  - The names of the include are the names of the check of `isUsed`. A forward declaration is possible for a class, a struct, a union, a class template, or an enum with a fixed underlying type, at the scope of a named namespace that is not inline and not reserved, for example `std`. A class template must have no default template arguments and no constraints, and each non-type parameter must have a builtin type or `auto`. The declaration uses the keyword of the definition.
  - A visitor walks the declarations of the main file. It collects the references to declarations and the places that need the full type of a class: a variable, a data member, a base class, a member access, a construction, a definition of a function with a parameter or a return value by value, a call that returns a class by value, a temporary, `sizeof`, `new`, `delete`, `typeid`, a cast between classes, pointer arithmetic, `throw`, `catch`, a definition of a member out of its class, and a call of a function template with a class as a type argument. A template argument needs the full type, except for `std::shared_ptr`, `std::weak_ptr`, `TObjectPtr`, `TWeakObjectPtr`, `TSoftObjectPtr`, `TSubclassOf` and `QPointer`. The visitor does not walk the instantiations of templates.
- `preprocessMs`: the time of the pass of the preprocessor, or 0 if the result uses the pass of an earlier parse. Then `passReused` is true. `cached` is true if the result comes from the same parse.

## The result of `dataflow/includers`

The first request scans all source files of the compile databases with the dependency scanner of Clang (`clangDependencyScanning`, the library of `clang-scan-deps`). The scanner runs the preprocessor of each source file with only the directives of each file. Thus `#if`, the include folders and the macros of each command count. The scan uses the threads of the engine, and the scanner reads each header one time for all source files. On a Qt project with 89 source files, a scan takes about 3 s with 8 threads. The scanner reads the unsaved text of the open files over the files on disk.

The engine keeps the result of the scan. A later request scans again if a directive of an open file changed, or if a file of the scan in `roots` changed on disk after the scan. The check of the files takes about 70 ms on the Qt project. The files out of `roots`, for example the headers of the standard library, do not count. The scan also gives the headers that a source file includes but the scanner did not find. If such a header comes later, it is newer than the scan.

- `units`: the source files that include the file, directly or through other headers, sorted. A source file does not include itself.
- `unitCount`: the number of all source files of the compile databases.
- `failed`: the source files that the scanner could not scan, for example a source file that does not exist.
- `isUnit`: the file is a source file of a compile database.
- `scanned`: the request made a new scan. `scanMs` is the time of the last scan, and `ms` the time of the request.

## The result of `dataflow/threads`

The engine finds the thread starts in the functions of the main file and of the project headers that they call. `roots` are the project folders. Then it walks the code of each thread and of the caller thread. The walk starts at the functions of the main file that no function of the file calls, and it follows the calls, the constructors and the destructors. A parameter of a called function gets the object of its argument, and `this` gets the object of the call. Thus an access has the same object path on each thread. A destructor runs at the end of the block of a local object, at the end of a destructor for the data members and the base classes, and at `delete` and at `reset()` of `std::unique_ptr` or `std::optional`. A destructor of the compiler destroys the data members and the base classes of its object.

- `threads`: each start with `via`, `name`, `at`, `fn` and `runs`. `handle` is the variable or the member that keeps the thread or its future. `joins` are the calls of `join()`, `get()` and `wait()` on the handle, and the calls of functions that join the handle of an argument or of their object in each run, for example `stop(w)` or `w.stop()`. A join in a branch that checks the same handle, for example `if (t.joinable()) t.join();`, joins in each run. A destructor that joins a thread of its object in each run is a join at the end of the block of the object. Its `kind` is the name of the destructor, for example `~Worker`, and its place is the closing brace of the block. The destructor of `std::jthread` is a join `~jthread`, and the destructor of the future of `std::async` is a join `~future`. The destructor of an object that `std::move`, `std::forward`, `std::swap` or `std::exchange` gives away is not a join. If a construction moves a thread into the object, for example `Guard g(std::thread(...))`, the handle is the object, and its destructor joins it. A start and a join in two different functions match in the terms of a caller of both: a parameter and `this` get the objects of the calls. A join in a called function also puts the later accesses of that function in sequence with the thread if the start and the join match only in the terms of a caller, for example a join of `thread_` in `~Task()` for a thread that `start(Task& t)` starts. A call of a function with a start is also a start. `isRepeated` is true if more than one thread of the start can run at the same time: a loop starts it, or it has no handle. `isJoined` is true if a join comes after the start in the same function, or if a destructor at the end of a block around the start joins it.
- `functions`: the functions and the lambdas that the other fields use, with `first` and `last`, the lines of the body. `threads` gives the threads that run the body. -1 is the caller thread.
- `items`: the shared data. An item is an object path from a root to a data member: a data member of `this` or of a parameter, a static or global variable, or a local object that a thread uses. A thread lambda captures such an object by reference, or a call gives it to a function that gives it to a thread. A function gives a parameter by reference or by pointer, or `this`, to a thread if a thread lambda captures it, if a thread of a function gets it, or if a call gives it to such a function. The path continues through the members of a class of the project, for example `srv.pool_.jobs_`. A local pointer goes to an object that the engine cannot name, so its item is the member of the class, for example `TimeSummary::parent`. The engine keeps an item if two threads use it, if a thread of a repeated start uses it, or if it is a static or global variable.
- `refs`: the accesses of an item. Each access has the place, `role`, `thread`, `fn`, `path`, `sub` (the steps after the item), `locks`, `order`, `guards` and `via`. `whole` is true for an access of the whole object, for example a call that gets it by reference. `order` lists the threads that the access is in sequence with: `after` (a join comes before), `before` (the start comes after, and the thread ends in the function or the function is a constructor), `empty` (the handle is empty) and `ready` (the future is ready). `guards` are the conditions around an access of the caller thread. `via` gives the thread start and the calls on the way to the access. `swap` gives a condition that reads the item before it checks the handle, and the swapped condition.
- `captures`: the local variables that a thread lambda captures by reference, if the thread can run after its function returns.
- `isTruncated` is true if the analysis stopped at a limit. `stats` gives the size and the time of each step.

The roles come from the nodes around each access, not from the mutation analyzer of Clang. The first use of the mutation analyzer needs the parents of all nodes of the translation unit.

## The result of `dataflow/member`

The engine finds the member at the position: an access, the declaration, or an initializer of a constructor. The member is a data member, a static data member or a global variable that is not a constant and not a part of the standard library or of a system header. With `className` and `member`, it finds the member by the qualified name of its scope, for example `demo::WorkerPool`, and its name. The scope of a global variable is its namespace, and an empty scope is the global namespace. Then the engine collects the accesses in the functions of the main file, and in the class with its member functions and friends in the headers. It does not collect the accesses in system headers and in the instantiations of templates. The extension uses `className` and `member` for the other source files of the class: each file is the main file of its own request.

- `member`: `name`, `type`, `kind`, `className`, `qualifiedClass`, `access`, `init`, `isAtomic`, `isSync` and `decl`. `kind` is `field`, `static` or `global`. A global variable has an empty `className`, and `qualifiedClass` is its namespace. `init` is the default member initializer, or the initializer of the definition of a static data member or a global variable. `isSync` is true for a mutex, a condition variable and a different object that threads use to synchronize. `decl` has `file`, `line`, `col` and `len`.
- `fields`: the data members and the static data members of the class, with `name`, `type` and `line`. Empty for a global variable.
- `functions`: the bodies with an access, and the functions around these lambdas. Each body has `name`, `qualifiedName`, `kind`, `file`, `line`, `outer` and `thread`. `kind` is `function`, `method`, `constructor`, `destructor` or `lambda`. `outer` is the body around a lambda, or -1. `thread` is an index in `threads`, or -1. `threadCall` gives the file and the line of the call that gives a function its thread.
- `threads`: the starts of the threads. Each start has `via`, `file`, `line` and `isRepeated`. `via` is for example `std::thread`, `std::async`, `QThread::run` or the post function of a job queue. `isRepeated` is true if more than one thread of the start can run the body at the same time: a loop starts the thread, or a job queue has more than one worker thread. `calls` gives the functions of other source files that the thread calls: functions with no body in the translation unit.
- `refs`: the declaration and each access. A static data member or a global variable can also have a definition with an initializer, which is a `def` too. Each reference has `fn`, `file`, `line`, `col`, `len` and `role`. `fn` is an index in `functions`, or -1 for a declaration. The roles are the roles of `dataflow/flow`, and an initializer of a constructor is a `def`. `alsoRead` is as in `dataflow/flow`. `object` gives the text of the object if the access is not through `this`, for example `_o`. `whole` is true for a change of the whole object of a group of accesses, or of an object that contains it: an assignment of the object is a `write`, and a call that gets the object by a reference to non-const or a call of a non-const member function is a `mayWrite`. The position of such a reference is the object, for example `charge` in `reset(charge)`. `locks` gives the mutexes that the access holds. `runs` gives the threads that run the access, from the threads analysis of the translation unit.
- `edges`: pairs of indexes in `refs`. Each pair goes from a definition to an access that it reaches in the same body, through the same object: `this`, or the same text of a different object, for example `charge` in `charge.is_dirty`. A change of the whole object is a definition of this group too.
- `function`: the function at the position, or null.

The engine finds the threads in these ways:

- A lambda that is an argument of a construction of `std::thread`, `std::jthread`, `llvm::thread` or `boost::thread`, of `emplace_back` on a container of these types, of `QThread::create`, or of a function in `asyncFunctions`
- A function as such an argument, for example `std::thread(&Worker::run, this)`. The function gets `this` and its parameters by reference or by pointer from the arguments: a pointer, a smart pointer, `std::ref` or `std::cref`. A thread start copies the other arguments, so they are new objects.
- `run()` of a class derived from `QThread`
- A job queue: a member function that puts its callable argument into a container member of its class with `push`, `emplace` or `insert`, if a thread start in a member function of the class runs a lambda that uses this container, for example `WorkerPool::post`. The callable argument runs on a worker thread.
- A function in `entries`: a thread of a different source file calls it. Each entry has `function` (the qualified name), `via`, `file`, `line` and `isRepeated`. The thread keeps the place of its start in the other file.
- A lambda in a body on a thread, and a function of the trace that a body on a thread calls

A lock is a lock guard, a `lock()` call or `std::lock` in a block around the access, before the access. A lock guard is a variable of type `lock_guard`, `unique_lock`, `scoped_lock`, `shared_lock`, `QMutexLocker`, `QReadLocker`, `QWriteLocker`, `MutexLock`, `ReaderMutexLock` or `WriterMutexLock`. A guard with `std::defer_lock` holds no mutex until its `lock()`. A guard can also come from a cast, as in `auto lock = std::unique_lock(m);`, or from a function that returns a guard. `mutex.lock()`, `guard.lock()` and `std::lock(a, b)` take a lock, and `unlock()` releases it. A call of a function on `this` or with no object takes and releases the mutexes of the `lock()` and `unlock()` calls in its body, also in the functions that it calls, to a depth of 2. A parameter of the function becomes the argument of the call. The guards of the function release their mutexes at its end. A function on a different object does not count, because its mutexes are not the mutexes of the caller. The body of a lambda gets the locks around the lambda only if the call runs the lambda before it returns: a wait of a condition variable, or an algorithm of the standard library, for example `std::count_if`. `dataflow/threads` uses the same rules.

The threads analysis of `dataflow/threads` walks the code of each thread with the objects of the calls. `roots` gives the folders of the project for this walk. Each access that the walk reaches gets one run for each thread: `thread` (an index in `threads`, or -1 for the caller thread), `locks` (the locks on the way to the access, also in the callers) and `ordered` (the threads that the access is in sequence with: a join, a start, or a check of a handle). A thread of the analysis that the trace does not have becomes a new thread of the trace. The engine keeps the threads analysis until the next parse, for `dataflow/threads` and `dataflow/member`.

The files are absolute paths with the separators of the system.

## The result of `dataflow/logic`

The extension evaluates the paths with this data, so a new choice needs no request to the engine. Block ids are indexes in `blocks`.

A lambda has its own CFG. With a position in the body of a lambda, the request analyzes the innermost lambda at the position. With `function` and `lambda`, the request analyzes the lambda with this index in the function, from 0 in the sequence of the source. Then `function` has the name `lambda`, the qualified name `<function>::(lambda <n>)` with n from 1, and the range of the lambda. `lambda` is the index, and `enclosing` is the function that contains the lambda.

- `entry`, `exit`: the entry block and the exit block of the CFG.
- `blocks`: each block has `succs` and `lines`. A successor of -1 is an edge that the CFG marks as unreachable, for example the branch of a constant condition. `lines` are the line ranges of the statements in the block.
- `decisions`: each `if`, loop, `switch` and conditional operator, in the sequence of the source. Each decision has `kind`, `block`, `text`, `line`, `col` and `branches`. Each branch has a `label`, the index `succ` in the successors of the block, and the lines `first` and `last` of its statement. `condBlocks` are the blocks of `&&` and `||` in the condition. `parent` and `parentBranch` give the decision that contains this decision.
- `chains`: else-if chains that compare one value with constants, for example `state == HOMEPOWER_CHARGE_PLANNING`. Each chain has `subject`, `items` with a `decision` and a `value`, and `hasElse`.
- `events`: the calls of a function in `eventFunctions` with a string argument that is not empty, in the sequence of the source. The string is a string literal, also through the constructor of `std::string` or `std::string_view`, or a constant that a string literal initializes. With no string argument, an enum constant gives the label. Each event has `block`, `line`, `col`, `len`, `function` and `label`. The mark is the literal, or the argument if the label comes from a constant.
- `nullable`: each assignment of a pointer, a `std::unique_ptr`, a `std::shared_ptr` or a `std::optional` from a function in `nullableFunctions`. Each entry has `var`, `source`, the position `at`, the dereferences `derefs`, and the null checks `checks`. A dereference is `*p`, `p->x` or `p[i]`, also with the operators of a class. A null check is `p`, `!p`, `p == nullptr`, `p != nullptr`, the same forms with `std::nullopt`, `o.has_value()`, and a call of a function in `checkFunctions` with the variable. A null check gives the block and the successor where the variable is not null.
- `returns`: each `return` and `co_return` statement of the function. Each return has `block`, `line`, `col` and `len` of the keyword, and `value`, the text of the returned value on one line. A `return;` has an empty `value`.
- `effects`: the writes of data that lives after the call of the function, in the sequence of the source. Each effect has `block`, `line`, `col` and `len` of the changed expression, `target`, the text of the changed expression, `action` (`=`, `+=`, `++` or the name of the called member function), and `kind`: `member` for a data member, `global` for a global or static variable, `parameter` for the object of a reference or pointer parameter, and `capture` for a variable that a lambda captures by reference. A write is an assignment, `++`, `--`, or a call of a member function that is not `const`. A call of `operator[]`, `at()`, `find()` or a similar function is a write only if the code writes through its result. A write through a local reference, through a local pointer, or through an iterator from an accessor is a write of the object of its initializer. A non-const reference argument of a call is no write.

The decision kinds and their branch labels are:

| Kind | Branches |
| --- | --- |
| `if` | `yes`, `no` |
| `loop` | `enter`, `skip` |
| `do` | `repeat`, `once` |
| `switch` | one branch for each case label, `default`, and `no case` if the switch has no default |
| `ternary` | `yes`, `no` |

A conditional operator in the condition of a decision is a part of that decision. A name in `eventFunctions`, `nullableFunctions` or `checkFunctions` with `::` is a qualified name.

`resourceDir` is optional. The default is the folder `lib/clang/23` next to the engine.

## The result of `dataflow/structure`

The MCP tool `get_structure` gives this data to a language model. The model puts the statements into logical blocks. The extension moves the lines of each block to whole statements, and it calculates the data that goes into each block and out of it from the accesses.

- `statements`: the statements of the body, in sequence. Each statement has `first` and `last` (its lines), `kind`, `text`, `exits`, `events`, `threads` and `calls`. `text` is the condition of an `if`, a loop or a `switch`, else the line of the statement from its start. A text has a maximum of 100 bytes.
- `branches`: an `if` has one branch for each `if`, `else if` and `else` of its chain. A `switch` has one branch for each group of case labels. A `try` has one branch for the try block and one for each `catch`. Each branch has `first`, `last`, `label` and `statements`. The first branch starts on the first line of the statement. A different branch starts on the line of its `else`, `case`, `default` or `catch`. Each branch ends on the line before the next branch, and the last branch ends on the last line of the statement. Thus `} else if (...) {` is the first line of its branch.
- `body`: a block and a loop have the statements of their body.
- `exits`: `return`, `co_return`, `break`, `continue`, `throw` and `goto` in the statement and in the statements in it, with `line` and `kind`. A `break` or a `continue` is an exit only if it leaves the statement. A `return` in a lambda is not an exit.
- `events`: the calls of the functions in `eventFunctions`, with `line` and `name`. `name` is the first string literal argument, or empty.
- `threads`: the thread starts, with `line`, `via` and `runs`. The starts are the starts of `dataflow/member`, and `std::async`. `runs` is the first function of the user that the lambda calls, or `lambda`, or the name of a function argument, for example `run` for `std::thread(&Worker::run, this)`.
- `calls`: the calls of functions that the main file defines, one for each name, with `line` and `name`. A call of an event function is an event, not a call.
- The items of a lambda count only if the call that gets the lambda runs it before it returns, for example `std::sort`. Thus a lambda of a thread start gives no items, but its start gives `runs`.
- `accesses`: each access in the body, also in the lambdas, in the sequence of the source. Each access has `line`, `col`, `path`, `role` and `scope`. The position is the last name of the path.

| Field | Values |
| --- | --- |
| `kind` | `decl`, `expr`, `if`, `for`, `while`, `do`, `switch`, `block`, `return`, `break`, `continue`, `throw`, `try`, `other` |
| `role` | `read`, `write`, `readwrite` (a compound assignment, `++`, a call of a non-const member function, an argument for a non-const reference or a pointer), `decl` (a variable, a structured binding, a parameter of a lambda) |
| `scope` | `local`, `param` (a parameter of the function), `member` (a data member through `this`), `global` (a global or static variable) |

The path of an access is the path of the source text. The data members go into the path with `.`, also after `->`. An element goes into the path as `[]` after its container, but an element at the end belongs to its container. For example, `charge.optimizers[main_optimizer_id]` gives `charge.optimizers`, and `this->x_` gives `x_`. After `auto &opt = charge.optimizers[main_optimizer_id];`, the object of `opt.schedule.kw` is `charge.optimizers[].schedule.kw`. A call of a member function gives an access of its object. `object` is the path through the local references if it is different. For example, `settings.meter_hold_time` gives the object `home_battery_ctl.operational_settings.meter_hold_time` after `auto &settings = home_battery_ctl.operational_settings;`. The reference of a range for loop is an element of its range. `scope` is the scope of the object. `inLambda` is true for an access in the parameters or in the body of a lambda. A write has `reaches`: the lines of the reads that it reaches over the control flow, from the reaching definitions of the slice of Change Ripple. A write does not reach its own read in the next turn of a loop. The function and each lambda have a control flow of their own. In a lambda, only a local variable and a parameter by value have `reaches`, because the reads of a captured variable are in the enclosing function. A path through an element or a call, and a path with more than 3 data members, get the lines of the longest part of the path that the slice has, for example of `candidates` for `candidates[].name`. These lines can be more than the reads of the path.

These rules also apply:

- The binding of a local reference is a `read`. The reads and the writes through the reference have their own roles.
- A constant, and a global variable of the standard library or of a system header, for example `std::nullopt`, give no access.
- A name in the body of a macro of a different file gives no access, because the user did not write it. A name in a macro argument gives an access.

## The result of `dataflow/cost`

- `functions`: all function definitions of the file.
- `items`: each item has `kind`, `fn` (an index in `functions`), `line`, `col`, `len`, `text`, `detail` and `pattern`. An item of an instantiation of a template has the template as its function and the place in the template. Its `detail` ends with a sentence that names the instantiations, for example `This item comes from the instantiation twice<std::string>.` The items of more than one instantiation with the same text show one time. `text` is the short text of the chip. `detail` is the long text of the hover card and of the details column. `pattern` is the kind and the type, for example `copy|GridStatus`. The extension uses it for "Not useful". `heuristic` is true for an item that the engine cannot be sure of. `related` gives the other positions of a group of lookups.

| Kind | Items |
| --- | --- |
| `copy`, `move` | Copy and move constructors and assignments of class types. A copy into a container through a const reference parameter, for example `push_back(x)`. A trivially copyable type of `minCopyBytes` or less does not show. A return with NRVO is no move. Qt types with implicit sharing show as "shared copy". |
| `conversion` | Integer to floating point, floating point to integer, narrow casts, a change of the sign of an integer, and conversions through a constructor or a conversion function. A change of the sign has the pattern `sign|<from>><to>`, for example `sign|int32_t>uint32_t`. An unsigned type to a wider signed type is no change of the sign. A conversion to `bool`, a constant, a `consteval` constructor, a string literal that becomes a view, and a value that becomes `std::optional`, `std::expected`, `std::unexpected` or `std::variant` do not show. |
| `temporary` | A temporary that a reference keeps alive, and a temporary from an implicit conversion for a const reference parameter |
| `shadow` | A variable with the name of a variable of an outer scope |
| `destructor` | A destructor at the end of a scope, or at a `return`, a `break` or a `continue` |
| `allocation` | `new`, `make_unique` and `make_shared`. A placement `new` does not show. Container calls that can grow, for example `push_back` and `reserve`, are a heuristic. |
| `lookup` | Two or more lookups of the same key in the same associative container on one path of the CFG, with no change of the container or of a local variable of the key between them. A path does not go back through a loop. The lookups of a group are connected by such paths. The count is the largest number of lookups on one path, and `related` has all other lookups of the group. |
| `state` | A static local variable, and a global variable that the function writes |

Code in the body of a macro does not give items. Code in a macro argument gives items, because the user wrote it.

## The result of `dataflow/slice`

The slice starts at a seed and follows the dependences forward. The engine keeps the models of the bodies until the next parse, so the next slices of the file are fast, for example the slices of the changes of a review. Most accesses of a model need no query of the mutation analyzer of Clang: a read, an argument of a parameter by value or by a reference to const, the object of a const member function, an assignment, `++` and `--`, and a call of a non-const member function. A slice of all lines of TBT `tests.cpp` takes 0.43 s, then 13 ms (before: 4.8 s each time). The params give the seed:

- `lines`: changed lines of the file. The statements on these lines are the seeds. A changed parameter brings its uses, and a changed case label brings the condition of its switch.
- `deleted`: deleted blocks. Each block has `line`, the line after the block in the new file, and `text`, the old text. The seeds are the later uses of the variables that the old text writes. If the old text writes no variable, for example a call, the seeds are the later uses of all the names in the text.
- `call`: the `line` and `col` of the called name of a call. The value of the call is the seed. The extension sends the callers of a changed function in this form.
- `asyncFunctions`: functions that run a callable on a different thread. A name with `::` is a qualified name.
- `confidence`: the confidence of the seeds, `exact`, `call` or `estimated`. The default is `exact`.

The result:

- `bodies`: each function or lambda that the slice reaches. `function` is the function, or for a lambda the function around it. `lambda` is the position of the lambda. `seedLines` are the changed lines in the body. `callers` are the calls of the function in the same file, for a function with a return exit. Each caller has `line`, `col` and `function`.
- `steps`: the statements of the body in the slice. Each step has `line`, `col`, `len`, `lines`, `kind`, `confidence`, `distance`, `from`, `via` and `text`. `lines` are the lines of the statement without the bodies of its lambdas. `distance` is the number of dependences from the seed. `from` is the step of the same body that the step depends on, or -1. `via` is the value, the condition or the function of the dependence.
- `exits`: the points where the effect leaves the body. Each exit has `kind`, `line`, `col`, `len`, `text`, `step` and `followed`. The slice continues at a followed exit.
- `outside`: changed lines outside of all functions. `quiet`: changed lines in a function with no statement, for example a comment. `callFound` is false if the engine found no call at the position of `call`.

| Step kind | Dependence |
| --- | --- |
| `seed` | A changed statement, or the call of `call` |
| `data` | The statement reads a value that a step writes |
| `control` | A step is a decision, and the statement runs only for some of its branches |
| `member` | The statement reads a field of a persistent object that a step writes. The read can occur in a later call. |
| `async` | The statement calls an async function with a value of a step |
| `lambda` | A step is the return of a lambda, and the statement contains the lambda |

| Exit kind | Point |
| --- | --- |
| `return` | The return value. For a lambda, the slice continues at the lambda. For a function, the extension continues at the callers. |
| `member` | A write to a field of a persistent object: this, a reference or pointer parameter, a global, a captured variable, or a local reference to one of them |
| `global` | A write to a global or static variable |
| `reference` | A write through a reference or pointer parameter, or through a local reference to a persistent object. A call with a reference argument can be such a write. |
| `argument` | A changed value goes into a call of a function of the user |
| `capture` | A lambda captures a changed value, or a lambda writes a captured variable. If the function calls the lambda, for example `auto f = [&] { ... }; f();` or `[&] { ... }()`, the slice continues in the lambda at the uses of the captured variable, and the exit is `followed`. |
| `async` | A changed value goes into an async call. The slice continues from the result of the call. |
| `call` | A decision of the slice decides whether a call of a function of the user runs. The called function can change more data than its arguments. A call in the body of a lambda does not count. `text` is the qualified name of the function. |

The confidence of a step is `exact` for a dependence in the changed function, `call` for a step in a caller, and `estimated` for a step through a field in a later call or through an async call.

The values of the slice are variables and `this` with a path of up to 3 fields, for example `home_battery_ctl.charging_future`. These rules keep the slice small:

- A step from one expression changes only the writes that get the value of the expression. A changed line or a decision changes all writes of the statement.
- A write to a field reaches a use of the whole object only if the use copies the object.
- A possible write to a whole persistent object, for example a call with a reference argument, is an exit. The slice does not follow it, because the engine does not know what the call changes.
- A chain of steps follows a maximum of one jump to the reads of a field in a later call.
- A capture by reference, and the binding of a local reference, are not writes.

## The result of `dataflow/tokens`

The side view shows the code of a file with these tokens. The text of the lines is the text that the engine parsed. So the text, the tokens and the data of the lenses agree, also during an edit. The engine keeps the tokens of the last parse, so the next requests for other lines are fast.

- `lineCount`: the number of lines of the file.
- `version`: the version of the text that the engine parsed. -1 is the file on disk.
- `cached` is true if the engine used the tokens of an earlier request for the same parse.
- `legend`: `kinds` gives the name of each kind number, and `modifiers` gives the name of each modifier bit, from bit 0.
- `lines`: each line has `line`, `text` and `tokens`. `tokens` has 4 numbers for each token: the column, the length, the kind and the modifier bits. For a bracket, the fourth number is the level of nesting. The column and the length count UTF-8 bytes. A token on more than one line, for example a block comment, has a part on each line.

The names of the kinds and of the modifiers are the names of the semantic tokens of VS Code. So the extension can find their colors in the color theme.

| Kind | Tokens |
| --- | --- |
| `comment`, `string`, `number` | Comments, string literals, character literals and numbers. The file name of an `#include` is one string. |
| `operator`, `punctuation` | Operators. Brackets, `;`, `,`, `::`, `.` and `->` are punctuation. |
| `preprocessor` | The `#` and the name of a directive, `defined`, and `__VA_OPT__` in the body of a macro |
| `pragma` | The words after `#pragma`, also keywords |
| `attribute` | A name in `[[...]]`, `__attribute__((...))` or `__declspec(...)`, for example `nodiscard`. A name before `::` in an attribute is a `namespace`, for example `gnu` in `[[gnu::always_inline]]`. A name in an argument of an attribute gets the kind of its code. |
| `keyword.control` | For example `if`, `for`, `return`, `throw` and `co_await` |
| `keyword.type` | The built-in types and `auto` |
| `keyword.modifier` | For example `const`, `constexpr`, `static`, `inline`, `virtual`, `override` and `final` |
| `keyword.constant`, `keyword.this` | `true`, `false` and `nullptr`, and `this` |
| `keyword` | All other keywords, for example `class`, `namespace` and `template` |
| `namespace`, `class`, `enum`, `enumMember`, `type`, `typeParameter` | Names of types. `class` includes structs, unions, constructors and destructors. `type` includes type aliases and concepts. |
| `function`, `method`, `parameter`, `variable`, `property`, `label` | Names of code and data. `property` is a field. |
| `macro` | The name of a macro, also after `#define` |
| `bracket` | A round, square or curly bracket. The level of nesting starts at 0 and counts all bracket types together. With `bracketLevelPerType`, the level counts only the brackets of the same type, for the setting `editor.bracketPairColorization.independentColorPoolPerBracketType` of VS Code. A closing bracket that does not close the last open bracket has the level -1. The side view gives a color to each level, as the text editor does. |

| Modifier | Names |
| --- | --- |
| `declaration` | The declaration of the name |
| `readonly` | A `const` or `constexpr` variable, a `const` field, a reference to `const`, and an enum member |
| `static` | A static local variable, a static data member and a static method |
| `defaultLibrary` | A name from a system header, for example from the standard library |

These rules apply to the names:

- A name in a macro argument, or in the body of a macro of the same file, gets the kind of the expanded code.
- A dependent name in a template has no declaration. Its use gives the kind: a call gives a function or a method, a member access gives a property, `T::x` gives a static property, and `typename T::x` gives a type.
- A parameter of a macro is a `parameter`, in the list of the parameters and in the body of the macro. `__VA_ARGS__` is also a parameter.
- The instantiations of a template do not give kinds. A name in a template gets its kind from the template.
- A name with no kind gets no token, for example a name in the body of a macro that only an included file expands.
