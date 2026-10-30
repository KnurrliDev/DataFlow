# P4 notes

- Date: 26 October 2026
- Status: P4 is complete. Acceptance scenario 3 passed on the CMake fixture.
- Plan: [implementation-strategy.md](implementation-strategy.md), sections 7.3 and 11
- Open issues: [TODO.md](../TODO.md)

## Result

Hidden C++ shows the operations that the compiler adds to the code. In `stable_readings()` of the fixture, the lens shows the four items of acceptance scenario 3:

| Item | Hint in the editor |
| --- | --- |
| The static map `last_read` | "static: keeps its value between calls" |
| The copy of `GridStatus` in `MeterRead{state, ...}` | "copy: GridStatus (48 B)" |
| The lookups of `tapTopic` in `last_read` | "7 lookups of tapTopic in last_read". The other 6 lookups show "same lookup again (2 of 7)" and so on. |
| The shadowed `taps` | "hides taps of line 177" |

The scenario names 6 lookups: the 6 calls of `operator[]`. The lens also counts the call of `contains`, which is a lookup of the same key. So the lens shows 7 lookups, and the panel text gives "contains 1, [] 6".

| Check | Result |
| --- | --- |
| Unit tests | 28 passed, 6 of them for Hidden C++ |
| P1 exit checks, and the acceptance tests of P2, P3 and P4 on the fixtures | 14 passed |
| Engine protocol tests | 12 passed, 2 of them for Hidden C++ |
| Screenshots in VS Code, dark theme and light theme | The hints, their colors and the panel are correct. |

## What Hidden C++ shows

| Category | Items | Color |
| --- | --- | --- |
| Copies | Copy constructors and copy assignments of class types. Copies into a container through a const reference parameter, for example `push_back(x)`. | write |
| Moves | Move constructors and move assignments | read |
| Conversions | Integer to floating point, floating point to integer, narrow casts, and conversions through a constructor or a conversion function | definition |
| Temporaries and lifetime | Temporaries that a reference keeps alive, temporaries from implicit conversions, and shadowed names | event |
| Destructors | Destructors at the end of a scope, and at a `return`, a `break` or a `continue` | read |
| Allocations | `new`, `make_unique` and `make_shared`. A placement `new` does not show, because it does not allocate memory. Container calls that can grow are a heuristic. | write |
| Repeated lookups | Two or more lookups of the same key in the same container, with no change of the container between them | problem |
| Hidden state | Static local variables, and globals that the function writes | check |

The panel shows a check box for each category, with the number of items in the function at the cursor. The number also counts the items of categories that do not show. A check box changes the setting `dataflow.cost.categories` in the user settings. Below the check boxes, the panel lists the items of the function. Each item has its line, its short text, a longer text and a "Not useful" button.

"Not useful" hides the pattern of the item in this workspace. A pattern is the kind and the type, for example `copy|GridStatus` or `temporary|std::string`. The panel tells how many patterns are hidden, and "Show them again" shows them.

## Rules against noise

The strategy gives the size limit for copies. The other rules come from the tests on the fixture and on two files of the TBT repository.

| Rule | Reason |
| --- | --- |
| Code in the body of a macro gives no items. Code in a macro argument gives items. | The Catch2 macros of TBT gave 294 destructors and many other items in `tests.cpp`. The user did not write this code. |
| A conversion to `bool` does not show. | `if (ptr)` and `if (opt)` are usual idioms. |
| A constant does not show, except a string literal that becomes a string. | The value of a constant is known. A string literal that becomes a `std::string` can allocate. |
| A `consteval` constructor does not show. | It runs in the compiler, for example the format string of `std::format`. |
| A string literal that becomes a type with a trivial destructor does not show. | A view, for example `std::string_view`, costs nothing. |
| A value that becomes `std::optional`, `std::expected`, `std::unexpected` or `std::variant` does not show. | This is the usual way to return a value. TBT uses `std::expected` for errors. |
| A return with NRVO is no move. | The compiler constructs the variable in the place of the result. |
| An implicit function, for example the move constructor of a local class, gives no items. | It is not code of the function. |
| A copy of a trivially copyable type of 16 bytes or less does not show. | The setting `dataflow.cost.minCopyBytes` sets the limit. |

The effect on TBT:

| File | Items before the rules | Items after the rules |
| --- | --- | --- |
| `include/TBT/compiler.hpp` | 49 | 9: 7 narrow casts, for example `size_t -> uint32_t`, and 2 allocations |
| `tests/src/tests.cpp` | 522 | 144 |

## Contents of P4

### Engine

| File | Function |
| --- | --- |
| `cost.hpp` | The items of all functions of a file. A visitor finds most items. A CFG with implicit destructors gives the destructors, and a walk over the scopes gives the shadowed names. |
| `analysis.hpp` | `Span` and `span_of`, which Logic Map and Hidden C++ share |
| `server.hpp` | The request `dataflow/cost`. [engine/README.md](../engine/README.md) describes the result. |

Two problems came up in the engine:

- The visitor of Clang visits only the syntactic form of an init list if it does not visit implicit code. The copies of an aggregate init, for example the copy of `GridStatus` in `MeterRead{state, ...}`, are only in the semantic form. The visitor now visits implicit code, and it skips nodes that it saw before.
- The MSVC STL puts the methods of `std::map` in the base class `_Tree`. So the type of the object of a call, as Clang gives it, is `_Tree`, not `map`. The engine now takes the type of the object without the implicit cast.

### Extension

| Module | Function |
| --- | --- |
| `lenses/cost.ts` | The categories, the hints and the panel data. Pure functions with unit tests. |
| `render/overlay.ts` | One decoration type for each category, with the hint at the end of the line |
| `webview/panel.ts` | The Hidden C++ section of the DataFlow view |
| `extension.ts` | The request for the file, the filter, "Not useful", and the update after an edit |

| Command or setting | Function |
| --- | --- |
| `DataFlow: Toggle Hidden C++`, Ctrl+Alt+H | Turns Hidden C++ on or off. |
| `dataflow.cost.categories` | The categories that show. The default is all categories. |
| `dataflow.cost.minCopyBytes` | The size limit for copies of trivially copyable types. The default is 16. |

The engine analyzes the full file, so the hints show in all functions. The panel shows the items of the function at the cursor. A change of a category or of a hidden pattern needs no request to the engine.

## Numbers

| File | Functions | Items | First analysis after a parse | Next analyses |
| --- | --- | --- | --- | --- |
| Fixture `battery.cpp` | 6 | 55 | 67 ms to 75 ms | 3 ms to 4 ms |
| TBT `compiler.hpp` | 46 | 9 | 163 ms | 8 ms |
| TBT `tests.cpp` | 56 | 144 | 250 ms | 76 ms |

The first analysis after a parse is slower, as for Flow Lens. [TODO.md](../TODO.md) has this issue.

## Changes from the strategy

1. In acceptance scenario 3, the lens shows 7 lookups, not 6. The call of `contains` is also a lookup of the same key. The strategy now tells this.
2. The engine has more rules against noise than the strategy. See [Rules against noise](#rules-against-noise).
3. A copy into a container through a const reference parameter is a new source of copies. The copy occurs in the code of the container, so the engine shows it at the call.
4. In the category "Allocations", only the container calls are a heuristic. The other items always allocate memory.

## Limits

- The text of an item is in the panel, but not in a hover in the editor.
- A conversion from a signed type to an unsigned type of the same size does not show. Only narrow casts show.
- The lookups of a group are in the sequence of the source, not of the paths. A change of the key between two lookups does not end a group.
- The type names come from Clang. A name of the standard library keeps `std::`, also in the arguments, for example `std::optional<std::vector<double>>`. A different outer name has no namespace, but the names in its arguments keep their namespaces, for example `Holder<geo::Transform>` for `geo::Holder<geo::Transform>`.
- The sizes come from the compile flags of the file. For example, `std::string` has 32 bytes in a release build of MSVC, and 40 bytes in a debug build.
- The other parts of the engine do not use the rule for macro bodies yet. Flow Lens still shows the variables of Catch2 macros.

## How to do the tests

1. Build the engine. See [engine/README.md](../engine/README.md).
2. Run `npm test`. This runs the unit tests, the exit checks of P1 and the acceptance tests of P2, P3 and P4.
3. Run `npm run test:engine`. This runs the engine protocol tests.
4. To make screenshots of Hidden C++ in the test build of VS Code, run `node spikes/ui/cost-snapshot.mjs <folder> dark`. Use `light` for the light theme.

## Next phase

P5 adds Change Ripple: the git diff, slices, exits, the call hierarchy, async steps and member steps, the ripple panel, and the wave in the editor.
