#pragma once

// IMPORTANT: the engine writes protocol messages to stdout. all other output goes to stderr

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <expected>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <vector>
//
#include <clang/AST/ASTContext.h>
#include <clang/AST/Decl.h>
#include <clang/AST/DeclCXX.h>
#include <clang/AST/ParentMap.h>
#include <clang/AST/RecursiveASTVisitor.h>
#include <clang/AST/Stmt.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/Analysis/Analyses/Dominators.h>
#include <clang/Analysis/Analyses/ExprMutationAnalyzer.h>
#include <clang/Analysis/CFG.h>
#include <clang/Analysis/FlowSensitive/DataflowAnalysis.h>
#include <clang/Analysis/FlowSensitive/Models/UncheckedOptionalAccessModel.h>
#include <clang/Basic/Diagnostic.h>
#include <clang/Basic/DiagnosticOptions.h>
#include <clang/Basic/SourceManager.h>
#include <clang/Basic/Version.h>
#include <clang/Driver/CreateASTUnitFromArgs.h>
#include <clang/Frontend/ASTUnit.h>
#include <clang/Frontend/CompilerInstance.h>
#include <clang/Frontend/FrontendActions.h>
#include <clang/Lex/HeaderSearch.h>
#include <clang/Lex/Lexer.h>
#include <clang/Lex/MacroInfo.h>
#include <clang/Lex/PPCallbacks.h>
#include <clang/Lex/Preprocessor.h>
#include <clang/Lex/PreprocessorOptions.h>
#include <clang/Options/Options.h>
#include <clang/Serialization/PCHContainerOperations.h>
#include <clang/Tooling/ArgumentsAdjusters.h>
#include <clang/Tooling/CompilationDatabase.h>
#include <clang/Tooling/DependencyScanningTool.h>
#include <clang/Tooling/Inclusions/StandardLibrary.h>
#include <clang/Tooling/JSONCompilationDatabase.h>
#include <clang/Tooling/Tooling.h>
#include <llvm/ADT/BitVector.h>
#include <llvm/Option/ArgList.h>
#include <llvm/Option/OptTable.h>
#include <llvm/Option/Option.h>
#include <llvm/Support/Error.h>
#include <llvm/Support/FileSystem.h>
#include <llvm/Support/JSON.h>
#include <llvm/Support/MemoryBuffer.h>
#include <llvm/Support/Path.h>
#include <llvm/Support/VirtualFileSystem.h>
#include <llvm/Support/raw_ostream.h>

namespace DataFlow {

  using Json       = llvm::json::Value;
  using JsonObject = llvm::json::Object;
  using JsonArray  = llvm::json::Array;

  // milliseconds since _start
  [[nodiscard]] inline double elapsed_ms(const std::chrono::steady_clock::time_point _start) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - _start).count();
  }  // elapsed_ms

}  // namespace DataFlow
