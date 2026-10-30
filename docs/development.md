# Develop DataFlow

This document tells how to change, run, test and release the code of DataFlow. [Install DataFlow](install.md) tells how to get the necessary software and build the engine.

- [Files](#files)
- [Install the dependencies](#install-the-dependencies)
- [Run the extension](#run-the-extension)
- [Do the tests](#do-the-tests)
- [Make the screenshots](#make-the-screenshots)
- [Make a release](#make-a-release)
- [Publisher ID](#publisher-id)

## Files

| File | Function |
| --- | --- |
| `package.json` | The extension manifest: the commands, the settings, the theme colors and the npm scripts |
| `src/` | The extension code. VS Code calls `activate()` and `deactivate()` in `src/extension.ts`. |
| `src/side/` | The side view in the extension. It has the webview panel, the scroll sync, the theme colors and the rows of the file. It also has the layers of Flow Lens, Logic Map and Hidden C++, and the story of Change Ripple. Include Hierarchy, Call Hierarchy and Threads and races have their data in `src/lenses/includes.ts`, `src/lenses/calls.ts` and `src/lenses/threads.ts`. |
| `src/webview-side/` | The code of the side view in the webview, with Preact |
| `src/mcp/` | The MCP server. `server.ts`: the protocol over HTTP. `tools.ts`: the tools and the prompts. `host.ts`: the data and the changes of the view. `manager.ts`: the start, the token and the setup. `bridge.ts`: the bridge for clients that start programs. `claude.ts`: the plugin and the settings of the connection to Claude Code. The logical blocks of a model have their data in `src/lenses/blocks.ts`. `layers.ts` keeps the layers of the model and the guided review for the next session. |
| `src/review/` | Change Ripple: the diff against the target branch (`git.ts`), the target branches (`targets.ts`) and the ripple (`ripple.ts`). The guided review has its data in `guide.ts`. |
| `scripts/` | `build-engine.mjs` builds the engine. `build-webviews.mjs` bundles the script of the side view with esbuild. `prepare-fixtures.mjs` prepares the fixture projects for the tests. `docs-screenshots.mjs` makes the screenshots of the documents. `package-vsix.mjs` makes the VSIX package. |
| `engine/` | The analysis engine in C++ |
| `media/` | The icon of DataFlow |
| `test/fixtures/` | A CMake project and a qmake project for the tests. The test of Change Ripple uses a git copy of the CMake project. |
| `test/engine/` | The protocol tests of the engine |
| `test/ui/` | The tests of the side view |
| `spikes/` | Test scripts and tools. The scripts of `spikes/ui/` start VS Code, use the side view and make screenshots. |
| `docs/` | The documents of DataFlow |
| `open-editor.bat` | Opens VS Code with the DataFlow extension of this folder |
| `.vscode-test.mjs` | The settings of the `vscode-test` command |
| `.vscodeignore` | The files that the `.vsix` package does not contain |

## Install the dependencies

1. Open a terminal in the root folder of the repository.
2. Type `npm install`.

## Run the extension

1. Build the engine. [Install DataFlow](install.md#build-the-engine) tells how to do this.
2. Open the root folder of the repository in VS Code.
3. Push F5. VS Code compiles the code and opens a second window. The title of the second window starts with "[Extension Development Host]".
4. In the second window, open a C++ project with a compile database.

The F5 key starts the default build task, `npm: watch`. This task compiles the code again each time that you save a file. To load a change, save the file. Then push Ctrl+R in the second window.

You can set breakpoints in `src/`. When the code gets to a breakpoint, the debugger stops in the first window.

To open the second window without the debugger, run `open-editor.bat` in the root folder of the repository. The script compiles the extension and opens VS Code with DataFlow. If the second window is open, VS Code loads it again with the new code. To open a folder in the window, give the folder as an argument, for example `open-editor.bat C:\Projects\App`. If VS Code runs as administrator, run the script as administrator.

## Do the tests

1. Type `npm test`. This command runs the unit tests and the tests on the fixture projects.
2. Type `npm run test:engine`. This command runs the protocol tests of the engine.
3. Type `npm run compile`, then `npm run test:ui`. This command runs the tests of the side view. Each script of `spikes/ui/` starts the copy of VS Code and does work in the side view. It reads the elements of the webview through the remote debugging protocol. The tests take about 4 minutes.

Do not use the mouse or the keyboard during the tests of the side view, because the scripts use the command palette.

The `pretest` script compiles the code and prepares the fixture projects. Then the `vscode-test` command downloads a copy of VS Code into `.vscode-test/`. It starts that copy and runs the tests in it. The window closes when the tests are complete.

The first download is about 350 MB, and it can take some minutes. The unpacked copy uses about 1 GB of disk space. Later tests use the same copy.

To run one group of tests, prepare the fixtures first. Then give the label of the group:

```bat
npm run compile
node scripts/prepare-fixtures.mjs
npx vscode-test --label unit
```

The labels are `unit`, `cmake`, `qmake`, `project`, `late-db` and `review`.

## Make the screenshots

The screenshots in `docs/images` show the fixture projects in the copy of VS Code of the tests. The script `scripts/docs-screenshots.mjs` makes them again:

1. Type `npm run compile`.
2. Type `node scripts/prepare-fixtures.mjs`.
3. Type `node scripts/docs-screenshots.mjs`. The script takes about 5 minutes.

To make only some screenshots, give the folder and the names of the screenshots, for example `node scripts/docs-screenshots.mjs docs/images flow-lens logic-map`.

The script starts the copy of VS Code with no side bar, no panel, no chat and no notifications. It calls the tools of the MCP server as a language model does. Before each screenshot, it blurs each text that looks like a path or a personal name, and it writes these texts to the terminal. Do not use the mouse or the keyboard while the script runs.

## Make a release

A release is a VSIX package for Windows x64 on the GitHub page of the releases. The package contains the extension and the engine. The engine is a Windows program, so the package is only for Windows x64.

1. Change the version in `package.json`, and write the changes of the version in `CHANGELOG.md`.
2. Type `npm run build:engine`.
3. Type `npm run package`. The script `scripts/package-vsix.mjs` does these steps:
   - It copies the engine and the builtin headers of Clang from `build/engine` into `engine/bin`. The extension looks for its engine in this folder.
   - It runs `vsce package --target win32-x64 --no-dependencies`. vsce compiles the extension, and it writes `dataflow-win32-x64-<version>.vsix` into the root folder of the repository.
   - It removes `engine/bin`. Without this step, the development host would use this copy of the engine, and not a new build in `build/engine`.
4. Install the VSIX in VS Code, and open a C++ project. Make sure that the status line of the side view shows **Engine: ready**.
5. Commit the changes, and push them.
6. Make a tag for the version, and push the tag:

   ```bat
   git tag -a v0.1.0 -m "DataFlow 0.1.0"
   git push origin v0.1.0
   ```

7. On GitHub, open the releases of the repository, and click **Draft a new release**. Select the tag, write the changes of `CHANGELOG.md` as the notes, and attach the VSIX file. Then click **Publish release**.

The package has no `node_modules` folder, because the extension has no runtime dependencies. If you add a runtime dependency, remove the option `--no-dependencies` from the script, or bundle the dependency.

vsce changes the relative links of `README.md` in the package to links to the repository on GitHub, for example the links to the screenshots. Thus the files of these links must be on the branch `master` on GitHub.

## Publisher ID

The `publisher` value in `package.json` is `KnurrliDev`, so the extension ID is `KnurrliDev.dataflow`. VS Code updates an extension only with a VSIX that has the same extension ID. Thus do not change the publisher ID after a release. The Visual Studio Marketplace needs a publisher with this ID.

The tests use the extension ID in these files:

- `src/test/unit/extension.test.ts`
- `src/test/fixtures/helpers.ts`
- `src/test/fixtures/latedb.test.ts`
- `src/test/fixtures/project.test.ts`
