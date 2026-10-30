# P0 spike results

- Date: 26 October 2026
- Status: P0 is complete. All three spikes passed.
- Plan: [implementation-strategy.md](implementation-strategy.md), section 11

## Summary

| Spike | Result | Key numbers |
| --- | --- | --- |
| (a) Animated SVG in the glyph margin | Pass | 8 of 8 screenshots differ. 26 icons. The same result on VS Code 1.124.2 and 1.143.1. |
| (b) Engine skeleton with CMake and qmake databases | Pass, after 2 fixes | 0 parse errors with both databases. Parse time 0.35 s to 0.95 s for each file, with no cache. The engine binary is 34.1 MB. |
| (c) `UncheckedOptionalAccessModel` on the `bestFit` case | Pass | 1 finding in each fixture, on the correct line. 0 findings on checked accesses. About 1 ms for each function. |

## Spike A: animated SVG in the glyph margin

Method: the command "DataFlow: Spike: Gutter Animation" draws 3 lanes on 26 lines of a sample file. Lane 1 has a pulse dot, and one of the lines has a breakpoint. The harness `spikes/gutter/run.mjs` starts VS Code with the Chrome DevTools Protocol. It reads the DOM, takes 8 screenshots of the gutter at intervals of 110 ms, and then closes VS Code.

Results:

- SMIL animation inside an SVG data URI animates in the glyph margin. All 8 screenshots were different.
- At the default font size, each icon is 19 × 19 px. Three lanes at x = 4, 10 and 16 are easy to see.
- The lanes join from line to line with no gap.
- The breakpoint does not hide the rail. VS Code shows the breakpoint in a second glyph lane, 19 px to the right of the rail icon.
- The installed VS Code 1.124.2 and the test build 1.143.1 give the same result.

Change to the plan: the renderer can put rail icons on lines with breakpoints.

## Spike B: engine skeleton

Method: `engine/` builds `dataflow-engine` on LLVM 23.1.4. The engine reads JSON-RPC requests on stdio. The client `spikes/engine/client.mjs` sends `initialize`, `dataflow/cfg` and `dataflow/optionalAccess`.

Fixtures:

- `test/fixtures/battery`: a CMake project: a small battery charge controller with stub types. CMake 4.4 with Ninja and MSVC 19.44 writes the compile database.
- `test/fixtures/battery-qmake`: a qmake project for Qt 6.11.2 (`msvc2022_64`). The script `spikes/qmake/make-cdb.mjs` reads the `Makefile.Release` of qmake and writes the compile database.

| Request | Database | Parse errors | Parse time |
| --- | --- | --- | --- |
| CFG of `initial_power` | CMake | 0 | 775 ms |
| Optional access in `initial_power` | CMake | 0 | 735 ms |
| Optional access in `solve_power_plan` | CMake | 0 | 729 ms |
| CFG of `charge::isValidKw`, in a header | CMake, command inferred for the header | 0 | 358 ms |
| Optional access in `describe`, Qt types | qmake | 0 | 900 ms |
| CFG of `describe`, Qt types | qmake | 0 | 851 ms |
| Optional access in `initial_power` | qmake | 0 | 748 ms |

- The CFG of `initial_power` has 11 blocks and 4 branches with their true and false successors.
- The CFG also contains the implicit destructor calls at the end of each scope and at each return, for example `~bestFit` on line 47.
- A full build of the engine takes 15 s.

The spike found two errors in the engine, and the engine now has the fixes:

1. A command that clang infers for a header ends with `-- <file>`. Arguments after `--` are file names. The engine now inserts its arguments after the program name.
2. `AdjacentBlock::getPossiblyUnreachableBlock()` gives a block only for an unreachable edge. The engine now uses `getReachableBlock()` first.

Facts for the build:

- The Windows release of LLVM 23.1.4 needs zlib and zstd, but does not contain them. The engine uses zlib 1.3.2 and zstd 1.5.7 as static libraries.
- The LLVM libraries use the static MSVC runtime (`/MT`), a Release configuration, and no RTTI. The engine uses the same settings.
- CMake cannot unpack the `.tar.zst` archive of LLVM, because the archive uses a large zstd window. Python `zstandard` with a larger window limit can unpack it.
- The Claude desktop app sends its writes to `%LOCALAPPDATA%` into its own package folder. Other programs cannot see these files. So the dependencies are in `C:\Users\<user>\.cache\dataflow`.

Changes to the plan:

- qmake on Windows: the Makefile reader worked on a real qmake Makefile for MSVC. DataFlow can make `compile_commands.json` for qmake without Qt Creator. This item moves from "later" to P1.
- Add zlib and zstd to the engine build and to CI.

## Spike C: optional access

| Function | Database | Findings | Expected |
| --- | --- | --- | --- |
| `initial_power` | CMake | line 46, `bestFit` | line 46: `std::to_string(bestFit->id)` after the check closes |
| `solve_power_plan` | CMake | none | none: `*kw` and `*opt.last_cost` have checks |
| `describe` | qmake, Qt | line 22, `hit` | line 22: `hit->kind` after the `if` |
| `initial_power` | qmake | line 46, `bestFit` | the same as with CMake |

- The model works with the `std::optional` of the MSVC standard library.
- The analysis takes about 1 ms for each function. The parse takes almost all of the time.

## Not covered by P0

- A real project of the author. It needs the full code base and its compile database.
- Parse times for large translation units with Qt and Eigen headers.
- The Linux build of the engine.
- VS Code versions before 1.124.

## Files

| Path | Content |
| --- | --- |
| `src/spike/gutterSpike.ts` | The gutter spike command |
| `spikes/gutter/run.mjs` | The harness for spike A |
| `spikes/engine/client.mjs` | The JSON-RPC client for spikes B and C |
| `spikes/qmake/make-cdb.mjs` | The Makefile reader for qmake |
| `engine/` | The engine skeleton, see `engine/README.md` |
| `test/fixtures/` | The CMake and qmake fixtures |
