#pragma once

#include <dataflow/defines.hpp>

namespace DataFlow {

  struct CompileDb {
    std::string path_;
    std::unique_ptr<clang::tooling::CompilationDatabase> db_;
    std::vector<std::string> files_;  // normalized paths of the entries
  };  // CompileDb

  struct Command {
    std::vector<std::string> args_;  // args_[0] is the program
    std::string directory_;
    std::string db_path_;
  };  // Command

  // a key for maps of files: native separators, no dots, lowercase on windows
  [[nodiscard]] inline std::string normalize_path(const std::string& _path) {
    llvm::SmallString<256> out(_path);
    llvm::sys::path::remove_dots(out, true);
    llvm::sys::path::native(out);
#ifdef _WIN32
    return llvm::StringRef(out).lower();
#else
    return std::string(out);
#endif
  }  // normalize_path

  // loads compile_commands.json with the adapters that clangd also uses: response files, driver mode, headers
  [[nodiscard]] inline std::expected<CompileDb, std::string> load_compile_db(const std::string& _path) {
    std::string err;
    auto json_db = clang::tooling::JSONCompilationDatabase::loadFromFile(
        _path, err, clang::tooling::JSONCommandLineSyntax::AutoDetect);
    if (!json_db) return std::unexpected(err);

    CompileDb out;
    out.path_ = _path;
    for (const std::string& f : json_db->getAllFiles()) out.files_.push_back(normalize_path(f));

    std::unique_ptr<clang::tooling::CompilationDatabase> db = std::move(json_db);
    db      = clang::tooling::expandResponseFiles(std::move(db), llvm::vfs::getRealFileSystem());
    db      = clang::tooling::inferTargetAndDriverMode(std::move(db));
    db      = clang::tooling::inferMissingCompileCommands(std::move(db));
    out.db_ = std::move(db);
    return out;
  }  // load_compile_db

  // the database with an entry for the file. else the database with the nearest entry
  [[nodiscard]] inline const CompileDb* find_db(const std::vector<CompileDb>& _dbs, const std::string& _file) {
    const std::string key = normalize_path(_file);
    const CompileDb* out  = nullptr;
    size_t best           = 0;

    for (const CompileDb& db : _dbs) {
      for (const std::string& f : db.files_) {
        if (f == key) return &db;
        const size_t common = size_t(std::ranges::mismatch(f, key).in1 - f.begin());
        if (!out || common > best) {
          best = common;
          out  = &db;
        }
      }
    }
    return out;
  }  // find_db

  // removes flags that load code into the compiler
  [[nodiscard]] inline std::vector<std::string> strip_unsafe_args(const std::vector<std::string>& _args) {
    std::vector<std::string> out;
    for (size_t i = 0; i < _args.size(); ++i) {
      const std::string& a = _args[i];
      if (a.starts_with("-fplugin") || a.starts_with("-fpass-plugin")) continue;

      // -Xclang -load -Xclang <file>
      if (a == "-Xclang" && i + 1 < _args.size() &&
          (_args[i + 1] == "-load" || _args[i + 1] == "-plugin" || _args[i + 1] == "-add-plugin")) {
        ++i;
        if (i + 2 < _args.size() && _args[i + 1] == "-Xclang") i += 2;
        continue;
      }
      out.push_back(a);
    }
    return out;
  }  // strip_unsafe_args

  // removes the response files that the expansion did not find, the options of the C++ modules of MSVC, and the options
  // of MSVC that write a file. CMake gives MSVC a module map for each source file, for example
  // @game\CMakeFiles\Game.dir\src\main.cpp.obj.modmap, and Ninja writes it only in a build. Before the build, the
  // driver takes the missing file as a second source file. The options in a module map, for example -reference
  // <name>=<file>.ifc, are for MSVC only. UnrealBuildTool gives MSVC "/sourceDependencies <file>.json" and
  // "/experimental:log <file>.sarif". The driver does not know these options, so it takes their files as source files
  [[nodiscard]] inline std::vector<std::string> strip_module_args(const std::vector<std::string>& _args) {
    const auto is_option = [](const std::string& _a, const std::initializer_list<std::string_view> _names) {
      return (_a.starts_with('-') || _a.starts_with('/')) &&
             std::ranges::find(_names, std::string_view(_a).substr(1)) != _names.end();
    };
    std::vector<std::string> out;
    for (size_t i = 0; i < _args.size(); ++i) {
      const std::string& a = _args[i];
      if (i > 0 && a.size() > 1 && a.front() == '@') continue;  // a response file that does not exist
      if (is_option(a, {"reference", "ifcOutput", "ifcSearchDir", "headerUnit", "sourceDependencies",
                        "sourceDependencies:directives", "experimental:log"})) {
        ++i;  // the option and its value
        continue;
      }
      if (is_option(a, {"interface", "internalPartition"})) continue;
      out.push_back(a);
    }
    return out;
  }  // strip_module_args

  // true if the driver of clang-cl takes the argument as an option. An option with its value in the next argument is
  // also an option
  [[nodiscard]] inline bool is_cl_option(const std::string& _arg) {
    const char* argv[]     = {_arg.c_str()};
    unsigned missing_index = 0, missing_count = 0;
    const llvm::opt::InputArgList list = clang::getDriverOptTable().ParseArgs(
        argv, missing_index, missing_count, llvm::opt::Visibility(clang::options::CLOption));
    if (missing_count > 0) return true;
    for (const llvm::opt::Arg* a : list) {
      const llvm::opt::Option::OptionClass kind = a->getOption().getKind();
      if (kind == llvm::opt::Option::InputClass || kind == llvm::opt::Option::UnknownClass) return false;
    }
    return true;
  }  // is_cl_option

  // removes the arguments of MSVC that clang-cl does not know, for example /dximplicitlyinstantiatevirtualfunction- of
  // UnrealBuildTool. The driver of clang-cl takes an argument that starts with / and that no option knows as a source
  // file. An argument with the path of a file stays
  [[nodiscard]] inline std::vector<std::string> strip_unknown_cl_args(const std::vector<std::string>& _args) {
    std::vector<std::string> out;
    for (size_t i = 0; i < _args.size(); ++i) {
      const std::string& a = _args[i];
      if (i > 0 && a.size() > 1 && a.front() == '/' && !llvm::sys::fs::exists(a) && !is_cl_option(a)) continue;
      out.push_back(a);
    }
    return out;
  }  // strip_unknown_cl_args

  // true if the folder is the folder of the builtin headers of a clang: <...>/lib/clang/<version>/include
  [[nodiscard]] inline bool is_builtin_include(llvm::StringRef _dir) {
    llvm::SmallString<256> dir(_dir);
    while (!dir.empty() && llvm::sys::path::is_separator(dir.back())) dir.pop_back();

    auto it         = llvm::sys::path::rbegin(dir);
    const auto end  = llvm::sys::path::rend(dir);
    const auto next = [&]() -> llvm::StringRef {
      if (it == end) return {};
      const llvm::StringRef out = *it;
      ++it;
      return out;
    };
    const llvm::StringRef include = next(), version = next(), clang = next(), lib = next();
    const bool is_version = !version.empty() && std::ranges::all_of(version, [](const char _c) {
      return (_c >= '0' && _c <= '9') || _c == '.';
    });
    return include.equals_insensitive("include") && is_version && clang.equals_insensitive("clang") &&
           lib.equals_insensitive("lib");
  }  // is_builtin_include

  // puts the folder of the builtin headers of the engine in the place of the folder of a different clang, and removes
  // the resource folder of a different clang. Qt Creator writes "-nostdinc" and the builtin headers of its own clang
  // into the commands for clangd, for example "/clang:-isystem /clang:<qt creator>/bin/clang/lib/clang/22/include". The
  // builtin headers of a different version do not agree with the builtins of the engine, for example in the intrinsics
  [[nodiscard]] inline std::vector<std::string> use_own_builtin_includes(const std::vector<std::string>& _args,
                                                                         const std::string& _resource_dir) {
    if (_resource_dir.empty()) return _args;
    llvm::SmallString<256> own(_resource_dir);
    llvm::sys::path::append(own, "include");

    // the include options, the longest first. "/clang:" passes an option of clang through clang-cl
    constexpr std::array<std::string_view, 6> options = {"-idirafter", "-isystem", "-imsvc", "/imsvc", "-I", "/I"};
    const auto split_clang = [](const std::string& _a) -> std::pair<std::string_view, std::string_view> {
      const std::string_view a = _a;
      return a.starts_with("/clang:") ? std::pair(a.substr(0, 7), a.substr(7)) : std::pair(std::string_view(), a);
    };

    std::vector<std::string> out;
    for (size_t i = 0; i < _args.size(); ++i) {
      const auto [prefix, rest] = split_clang(_args[i]);

      // -resource-dir <folder> and -resource-dir=<folder>
      if (rest == "-resource-dir") {
        ++i;
        continue;
      }
      if (rest.starts_with("-resource-dir=")) continue;

      // an option and its folder in the next arg
      if (std::ranges::find(options, rest) != options.end() && i + 1 < _args.size()) {
        const auto [next_prefix, folder] = split_clang(_args[i + 1]);
        out.push_back(_args[i]);
        out.push_back(is_builtin_include(folder) ? std::string(next_prefix) + std::string(own) : _args[i + 1]);
        ++i;
        continue;
      }

      // an option and its folder in one arg
      const auto joined = std::ranges::find_if(
          options, [&](const std::string_view _o) { return rest.size() > _o.size() && rest.starts_with(_o); });
      if (joined != options.end() && is_builtin_include(rest.substr(joined->size()))) {
        out.push_back(std::string(prefix) + std::string(*joined) + std::string(own));
        continue;
      }
      out.push_back(_args[i]);
    }
    return out;
  }  // use_own_builtin_includes

  // a file that a source file includes, for example an .inc file of a unity build that needs the code before its
  // #include. the parse of the file comes after the lines of the source file before the #include
  struct FileContext {
    std::string unit_;                              // the source file
    uint32_t line_                            = 0;  // the line of the #include in the source file

    bool operator==(const FileContext&) const = default;
  };  // FileContext

  // the path of the virtual file with the lines of the source file before the #include. it is in the folder of the
  // source file, so an #include "x.h" of these lines finds its file
  [[nodiscard]] inline std::string context_path(const FileContext& _ctx, const std::string& _file) {
    llvm::SmallString<256> out(_ctx.unit_);
    llvm::sys::path::remove_filename(out);
    llvm::sys::path::append(
        out,
        (llvm::sys::path::filename(_ctx.unit_) + "." + llvm::sys::path::filename(_file) + ".dataflow-context.h").str());
    return std::string(out);
  }  // context_path

  // the text of the virtual file: the lines of the source file before the #include. #line gives an error in these lines
  // the place in the source file
  [[nodiscard]] inline std::string context_text(const std::string& _unit_text, const FileContext& _ctx) {
    size_t end = 0;
    for (uint32_t line = 1; line < _ctx.line_ && end < _unit_text.size(); ++line) {
      const size_t nl = _unit_text.find('\n', end);
      end             = nl == std::string::npos ? _unit_text.size() : nl + 1;
    }
    std::string unit = _ctx.unit_;
    std::ranges::replace(unit, '\\', '/');
    return "#line 1 \"" + unit + "\"\n" + _unit_text.substr(0, end);
  }  // context_text

  // the command for one file of a database, changed for a parse with no output. the engine never runs it. with a
  // context, the command of the source file applies to the file, and a forced include of the virtual file comes first
  [[nodiscard]] inline std::expected<Command, std::string> db_command(const CompileDb& _db, const std::string& _file,
                                                                      const std::string& _resource_dir,
                                                                      const FileContext* _ctx = nullptr) {
    const std::string& source                              = _ctx ? _ctx->unit_ : _file;
    const std::vector<clang::tooling::CompileCommand> cmds = _db.db_->getCompileCommands(source);
    if (cmds.empty()) return std::unexpected("no compile command for " + source);
    const clang::tooling::CompileCommand cmd =
        _ctx ? clang::tooling::transferCompileCommand(cmds.front(), _file) : cmds.front();

    clang::tooling::CommandLineArguments args = cmd.CommandLine;
    for (const clang::tooling::ArgumentsAdjuster& adjust :
         {clang::tooling::getClangSyntaxOnlyAdjuster(), clang::tooling::getClangStripOutputAdjuster(),
          clang::tooling::getClangStripDependencyFileAdjuster()})
      args = adjust(args, _file);
    args                      = use_own_builtin_includes(strip_module_args(strip_unsafe_args(args)), _resource_dir);

    // errors only, no warnings. insert after the program name, because a command for a header ends with "-- <file>"
    const std::string program = args.empty() ? "" : llvm::sys::path::stem(args.front()).lower();
    const bool is_cl          = program == "cl" || program == "clang-cl" ||
                       std::ranges::any_of(args, [](const std::string& _a) { return _a == "--driver-mode=cl"; });
    if (is_cl) args = strip_unknown_cl_args(args);
    if (!args.empty()) args.insert(args.begin() + 1, is_cl ? "/w" : "-w");
    // msvc makes 2 tokens from a ## that gives no valid token, and clang-cl gives an error that /w does not remove.
    // clang defines _MSVC_TRADITIONAL as 1 and ignores /Zc:preprocessor, thus unreal engine uses such a ## for the
    // traditional preprocessor of msvc, for example in UE_APPEND_VA_ARG_COUNT
    if (program == "cl" && !args.empty()) args.insert(args.begin() + 1, "-Wno-invalid-token-paste");
    // the preamble instantiates the templates that the code of its headers needs. else each parse of the main file
    // instantiates them again at its end, for example 7 s after each edit of a file with the headers of clang
    if (!args.empty())
      args.insert(args.begin() + 1, {std::string("-Xclang"), std::string("-fpch-instantiate-templates")});
    if (_ctx && !args.empty()) {
      const std::string prefix = context_path(*_ctx, _file);
      if (is_cl)
        args.insert(args.begin() + 1, "/FI" + prefix);
      else
        args.insert(args.begin() + 1, {std::string("-include"), prefix});
    }

    return Command{std::move(args), cmd.Directory, _db.path_};
  }  // db_command

  // the command for one file, from the database with an entry for the file, else from the database with the nearest
  // entry
  [[nodiscard]] inline std::expected<Command, std::string> get_command(const std::vector<CompileDb>& _dbs,
                                                                       const std::string& _file,
                                                                       const std::string& _resource_dir,
                                                                       const FileContext* _ctx = nullptr) {
    const std::string& source = _ctx ? _ctx->unit_ : _file;
    const CompileDb* db       = find_db(_dbs, source);
    if (!db) return std::unexpected("no compile database for " + source);
    return db_command(*db, _file, _resource_dir, _ctx);
  }  // get_command

}  // namespace DataFlow
