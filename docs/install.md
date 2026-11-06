# Install DataFlow

There are two methods to install DataFlow:

- Install the VSIX package of a release. The package contains the extension and the engine.
- Build the engine and the extension from the source code.

DataFlow is not in the Visual Studio Marketplace.

- [Supported systems](#supported-systems)
- [Install the VSIX](#install-the-vsix)
- [Build from the source code](#build-from-the-source-code)
- [Open your first project](#open-your-first-project)

## Supported systems

DataFlow works on Windows 64-bit. The VSIX package is only for Windows x64. The build of the engine uses Visual Studio 2022 and the Windows archive of LLVM. At this time, DataFlow has no tested build for Linux or macOS.

## Install the VSIX

You need VS Code 1.120 or later.

1. Open the [releases of DataFlow](https://github.com/KnurrliDev/DataFlow/releases) on GitHub.
2. Download the file `dataflow-win32-x64-<version>.vsix` of the latest release.
3. In VS Code, open the Extensions view. Click **…** at the top of the view, then click **Install from VSIX…**, and select the file. You can also install the file with a command in a terminal:

   ```bat
   code --install-extension dataflow-win32-x64-0.3.1.vsix
   ```

4. Open a C++ project. [Open your first project](#open-your-first-project) tells how.

To update DataFlow, install the VSIX of the new release. VS Code replaces the old version.

Your project must build on the computer. The engine parses the code with the compile commands of the project, and it uses the headers of the compiler and of the libraries of the project, for example of Visual Studio and Qt.

## Build from the source code

Use this method to change DataFlow, or to use code that is not in a release. The script `open-editor.bat` is only for Windows. To make a VSIX package from the source code, see [Make a release](development.md#make-a-release).

### What you need

For the extension:

- VS Code 1.120 or later
- Node.js 22.12 or later, with npm
- git

For the engine:

- Visual Studio 2022 with the workload "Desktop development with C++", MSVC 19.44 or later
- CMake 3.24 or later, and Ninja. The component "C++ CMake tools for Windows" of Visual Studio contains both.
- LLVM 23.1.4: the archive for development `clang+llvm-23.1.4-x86_64-pc-windows-msvc`
- zlib 1.3.2 and zstd 1.5.7 as static libraries, built with the static MSVC runtime (`/MT`)

For each C++ project:

- A compile database: a `compile_commands.json` file from CMake, the build folder of qmake, or the compile database that Qt Creator writes for clangd. For an Unreal Engine 5 project, DataFlow makes the compile database with UnrealBuildTool.

### Get the libraries for the engine

Put LLVM, zlib and zstd in one folder. The default folder is `.cache\dataflow` in your home folder:

```text
C:\Users\<user>\.cache\dataflow\
  llvm-23.1.4\
  zlib\
  zstd\
```

To use a different folder, set the environment variable `DATAFLOW_DEPS_DIR` to that folder before the first build of the engine.

1. Download the archive `clang+llvm-23.1.4-x86_64-pc-windows-msvc` from the [LLVM releases](https://github.com/llvm/llvm-project/releases).
2. Extract the archive into the folder `llvm-23.1.4`.
3. Download the source code of zlib 1.3.2 from [zlib.net](https://zlib.net), and extract it.
4. Download the source code of zstd 1.5.7 from the [zstd releases](https://github.com/facebook/zstd/releases), and extract it.
5. Open the "x64 Native Tools Command Prompt for VS 2022" in the folder that contains the two source folders.
6. Build zlib, and install it into the folder `zlib`:

   ```bat
   cmake -S zlib-1.3.2 -B build/zlib -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DZLIB_BUILD_SHARED=OFF -DZLIB_BUILD_STATIC=ON -DZLIB_BUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=C:/Users/<user>/.cache/dataflow/zlib
   cmake --build build/zlib
   cmake --install build/zlib
   ```

7. Build zstd, and install it into the folder `zstd`:

   ```bat
   cmake -S zstd-1.5.7/build/cmake -B build/zstd -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DZSTD_USE_STATIC_RUNTIME=ON -DZSTD_BUILD_SHARED=OFF -DZSTD_BUILD_STATIC=ON -DZSTD_BUILD_PROGRAMS=OFF -DZSTD_BUILD_TESTS=OFF -DCMAKE_INSTALL_PREFIX=C:/Users/<user>/.cache/dataflow/zstd
   cmake --build build/zstd
   cmake --install build/zstd
   ```

### Get the source code

1. Open a terminal in the folder for the repository.
2. Get the repository:

   ```bat
   git clone https://github.com/KnurrliDev/DataFlow.git
   ```

3. Go into the folder of the repository, and install the npm packages:

   ```bat
   cd DataFlow
   npm install
   ```

### Build the engine

Run this command in the root folder of the repository:

```bat
npm run build:engine
```

The script `scripts/build-engine.mjs` does these steps:

1. If `build/engine` has no CMake cache, the script configures the build with Ninja and the configuration Release. The environment variable `DATAFLOW_DEPS_DIR` gives the folder with LLVM, zlib and zstd. The default is `~/.cache/dataflow`.
2. The script builds the engine with a maximum of 80% of the processor cores. To set a different number, add `-- --jobs <n>` to the command, for example `npm run build:engine -- --jobs 8`.

On Windows, the script also does these steps:

- If the command does not run in the developer environment of Visual Studio, the script uses the environment of `vcvars64.bat` of Visual Studio 2022.
- If a process runs `dataflow-engine.exe`, for example the engine of a VS Code window, the script renames the file before the build. Windows does not let the linker write a program that runs. The process continues with the renamed file. If the build fails, the file gets its name back.
- After the build, the script stops the processes `vctip.exe` and `mspdbsrv.exe` that the build started. Without this step, they stay alive for some minutes.

If a VS Code window used the old engine, run **DataFlow: Restart Engine** in that window after the build. The next run of the script removes the renamed files that no process runs.

To build the engine without the script, open the "x64 Native Tools Command Prompt for VS 2022" in the root folder of the repository. Then run these commands:

```bat
cmake -S engine -B build/engine -G Ninja -DCMAKE_BUILD_TYPE=Release -DDATAFLOW_DEPS_DIR=C:/Users/<user>/.cache/dataflow
cmake --build build/engine -j <jobs>
```

The result is `build/engine/dataflow-engine.exe`. The build also copies the builtin headers of Clang to `build/engine/lib/clang/23/include`. The engine reads them from this folder.

### Build the extension

Run this command in the root folder of the repository:

```bat
npm run compile
```

The command compiles the TypeScript code into the folder `out`, and it bundles the script of the side view.

### Start VS Code with DataFlow

1. Run `open-editor.bat` in the root folder of the repository. To open a folder in the new window, give the folder as an argument:

   ```bat
   open-editor.bat C:\Projects\App
   ```

2. The script compiles the extension and opens a new VS Code window with DataFlow. The title of the window starts with "[Extension Development Host]".

More data about `open-editor.bat`:

- With no folder, VS Code opens the last folder of the window.
- If the window is open, VS Code loads it again with the new code.
- The script finds VS Code through the command `code` of the `PATH`, or else in the usual installation folders.
- If the script finds no engine, it tells you. DataFlow cannot parse C++ code until you build the engine.
- If VS Code runs as administrator, run the script as administrator.

You can also open the root folder of the repository in VS Code and push F5. [Develop DataFlow](development.md#run-the-extension) tells how to use the debugger.

DataFlow uses the engine in `build/engine` of the repository. To use an engine in a different folder, set `dataflow.engine.path` to the path of `dataflow-engine.exe`. The engine reads the builtin headers of Clang from the folder `lib/clang/23/include` next to it, so copy this folder with the engine.

## Open your first project

1. In VS Code with DataFlow, open the folder of a C++ project with a compile database. DataFlow finds these compile databases:
   - The `compile_commands.json` file of CMake. CMake writes this file for the Ninja generators and the Makefile generators if `CMAKE_EXPORT_COMPILE_COMMANDS` is `ON`.
   - The build folder of qmake, with its Makefile.
   - The `.qtc_clangd/compile_commands.json` file that Qt Creator writes for clangd.
   - For an Unreal Engine 5 project, the compile database that UnrealBuildTool makes for DataFlow. If the project has no compile database, DataFlow asks if it can make one. [Unreal Engine projects](usage.md#unreal-engine-projects) tells how.
2. If DataFlow finds no compile database, run **DataFlow: Select Compile Database**, and select the file or the build folder.
3. Open a C++ file of the project. The DataFlow item in the status bar shows the file that the engine parses. Then it shows the function at the cursor.
4. Click **DataFlow: Open Side View** in the title bar of the editor. The side view opens beside the editor.

DataFlow can also use a project that is not open in VS Code. [Use DataFlow](usage.md#a-project-that-is-not-open-in-vs-code) tells how to do this.

Next steps:

- [Use DataFlow](usage.md) tells how to use the side view and each lens.
- [Use the MCP tools](tools.md) tells how to connect Claude Code, so that it explains your code in the side view.
