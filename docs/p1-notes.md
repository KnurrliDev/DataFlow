# P1 notes

- Date: 26 October 2026
- Status: P1 is complete. The exit check passed on the CMake fixture and on the qmake fixture.
- Plan: [implementation-strategy.md](implementation-strategy.md), section 11

## Result

The DataFlow panel shows the function under the cursor in both fixtures.

| Check | Result |
| --- | --- |
| Unit tests: rails, qmake Makefile reader, extension | 9 passed |
| Exit check on the CMake fixture | Passed. The extension found `build/compile_commands.json`. |
| Exit check on the qmake fixture | Passed. The extension found `build-qmake/Makefile.Release` and made the compile database from it. |
| Engine protocol tests | 8 passed |
| Screenshots in VS Code | The panel, the status bar and the scope rail are correct. The rail animation moves down the rail one time. |

## Contents of P1

### Engine

| File | Function |
| --- | --- |
| `compile_db.hpp` | Loads more than one compile database. For each file, it uses the database with an entry for the file, else the database with the nearest entry. It changes the command for a parse with no output, and removes flags that load compiler plugins. |
| `tu_cache.hpp` | Keeps the parsed files, with the preamble in memory. It parses the text that is not saved yet. It keeps 4 files, and removes the file that it used least recently. It reads the files and does not map them, because Windows locks mapped files. |
| `server.hpp` | The worker pool, the requests, the cancel function and the status notifications. Each thread has a stack of 8 MiB. By default the pool uses half of the processor cores, and never more than 80%. |
| `analysis.hpp` | The functions of a file, the function at a position, the CFG, and the check for unchecked optional access. |

The engine finds the builtin headers of Clang next to itself, in `<exe folder>/lib/clang/23`. The engine build copies them there.

| Message | Type | Function |
| --- | --- | --- |
| `initialize` | request | Loads the compile databases. Sets the number of threads and the size of the cache. |
| `textDocument/didOpen`, `didChange`, `didClose` | notification | The text of the open files. |
| `dataflow/functions` | request | The functions of a file. |
| `dataflow/functionAt` | request | The function at a line and a column. |
| `dataflow/cfg`, `dataflow/optionalAccess` | request | The analyses of P0. A function can be selected by name or by position. |
| `$/cancelRequest` | notification | Stops a request. The reply has the error code -32800. |
| `dataflow/status` | notification from the engine | A file starts or ends a parse. |
| `shutdown`, `exit` | request, notification | Stops the engine. |

### Extension

| Module | Function |
| --- | --- |
| `engine/rpc.ts`, `engine/client.ts` | Starts the engine, sends the requests, and starts the engine again after a crash. A maximum of 3 restarts. |
| `cdb/manager.ts`, `cdb/qmake.ts` | Finds the compile databases: the setting, the selection, CMake Tools, qmake build folders, and the usual folders. Makes a database from a qmake Makefile. |
| `state/store.ts` | The state of the tool. |
| `render/rails.ts`, `render/overlay.ts` | The SVG icons of the rails, and the scope rail of the current function. |
| `panel/provider.ts`, `webview/panel.ts` | The DataFlow panel. |
| `statusbar.ts` | The status bar item. |

## Numbers

| Measurement | Value | Budget in the strategy |
| --- | --- | --- |
| First parse of a fixture file | 0.9 s to 1.5 s | less than 5 s |
| Parse after an edit | 0.22 s to 0.24 s | less than 500 ms |
| Function at the cursor, from the cache | 3 ms to 10 ms | less than 100 ms for a lens update |
| Two files at the same time | 1.2 s to 1.7 s | none |

## Changes from the strategy

1. P1 adds no npm packages. The strategy names `vscode-jsonrpc`, Preact, esbuild and `@vscode-elements/elements`. P1 uses a small JSON-RPC client and plain TypeScript for the panel. npm cannot install packages on the development computer at this time, and P1 does not need these packages.
2. The protocol uses file paths, not URIs.
3. The panel shows a short text for each lens. The lenses come in P2 to P5.
4. DataFlow does not run in an untrusted workspace. The capability `untrustedWorkspaces` in `package.json` sets this.

## Limits

- The engine counts columns in UTF-8 bytes. VS Code counts columns in UTF-16 code units. On a line with characters outside ASCII, the two values can differ. P2 must convert them.
- The tests do not cover the CMake Tools API, because the test build of VS Code has no CMake Tools extension.
- No automatic test covers the restart after a change of the compile database.
- Only Windows x64 was built and tested.
- The fixture script runs qmake in the Visual Studio 2022 environment. MSVC then starts `vctip.exe`, which can stay alive for some minutes.
- `npm install` does not work on the development computer at this time. Repair the Node.js installation before a phase that needs new packages.

## How to build and run

1. Build the engine. See [engine/README.md](../engine/README.md). The output is in `build/engine`.
2. Run `npm run compile`.
3. Run `npm test`. This runs the unit tests and the two exit checks. The `pretest` script prepares the fixtures.
4. Run `npm run test:engine`. This runs the engine protocol tests.
5. Push F5 to start the Extension Development Host. Open a folder with `compile_commands.json`, or a qmake project with a build folder.

## Next phase

P2 adds the Flow Lens: roles of references, reaching definitions and optional findings in the engine, and rails, pulses and follow mode in the editor.
