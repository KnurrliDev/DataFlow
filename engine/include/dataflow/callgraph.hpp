#pragma once

#include <dataflow/calls.hpp>
#include <dataflow/includers.hpp>

/*
  The call graph of the project, for the reach of the heat score:
    > a scan parses the source files of the compile databases in the project folders, with the unsaved text of the open
      files. the parse skips the bodies of the functions out of the project folders, and no syntax tree stays after the
      parse. the build folders in the project folders are not a part of the project
    > a node is a function definition in the project folders, by its usr: its qualified name, its file and its lines
    > an edge is a call of a function of the project, with its line and whether a loop runs it. a virtual call also goes
      to the overrides of the called function in the project. a call in a lambda belongs to the function around it
    > the frame functions run in each frame: the overrides of the frame functions of unreal engine and qt, and the
      functions that a main loop calls. a main loop is a loop with no fixed number of iterations in main. if main has
      no main loop, it is in the functions that main calls
    > the reach of a function: its direct callers, its transitive callers with their files, and its frame path
    > the graph keeps the functions of each file. in a scan, the first source file that parses a file of the project
      gets the functions of the file, and the other source files skip the bodies of its functions
    > an update parses only the source files that include a changed file. a scan that stops keeps the source files
      that it parsed, and the next scan continues with the other source files
*/

namespace DataFlow {

  // a call of a function, by the usr of the called function
  struct GraphCall {
    std::string to_;
    uint32_t line_   = 0;
    bool isInLoop_   = false;
    bool isVirtual_  = false;  // an override of the called function can run
    bool isMainLoop_ = false;  // a loop with no fixed number of iterations runs the call
  };  // GraphCall

  // a function definition in a file of the project
  struct GraphFunction {
    std::string usr_;
    std::string name_;  // the qualified name
    std::string file_;
    uint32_t first_ = 0;
    uint32_t last_  = 0;
    std::string frame_;  // the frame function of a framework that the function overrides, for example AActor::Tick
    bool isMain_ = false;
    std::vector<std::string> overridden_;  // the usrs of the functions that it overrides directly
    std::vector<GraphCall> calls_;
  };  // GraphFunction

  struct GraphEdge {
    int32_t to_    = -1;
    uint32_t line_ = 0;
    bool isInLoop_ = false;
  };  // GraphEdge

  // a function that runs in each frame, and the reason
  struct GraphRoot {
    int32_t node_ = -1;
    std::string reason_;  // for example "override of AActor::Tick"
  };  // GraphRoot

  // the functions of a file. the graphs share them, thus a copy of a graph is fast
  using GraphFile = std::shared_ptr<const std::vector<GraphFunction>>;

  // the folders of the project for a scan: the project folders, and the folders of the compile databases in them. such
  // a build folder has generated code and the code of fetched libraries, for example in build/_deps, thus the scan
  // skips it. all are keys of normalize_path
  struct GraphScope {
    std::vector<std::string> roots_;
    std::vector<std::string> skips_;
  };  // GraphScope

  struct ProjectGraph {
    std::vector<std::string> roots_;  // the project folders, as the client gives them
    GraphScope scope_;
    std::vector<std::string> units_;     // the source files in the project folders, as the compile databases give them
    std::vector<std::string> unitKeys_;  // the key of the path of each source file
    std::vector<int32_t> dbs_;           // the compile database of each source file
    std::vector<std::optional<llvm::sys::TimePoint<>>> times_;  // the start of the scan of each source file, if scanned
    std::unordered_map<std::string, GraphFile> files_;          // the functions of each file of the project, by key
    std::unordered_map<std::string, uint64_t> texts_;  // the hash of the text of each open file at the last scan
    std::vector<std::string> failed_;                  // the source files that the scan could not parse

    // the merge of the files. the nodes point into the files
    std::vector<const GraphFunction*> nodes_;
    std::vector<int32_t> fileOf_;  // the file of each node, as an index in the sorted keys of files_
    std::unordered_map<std::string, int32_t> byUsr_;
    std::vector<std::vector<GraphEdge>> out_;
    std::vector<std::vector<int32_t>> callers_;  // the callers of each node, each one time
    std::vector<GraphRoot> frames_;              // the frame functions of the code
  };  // ProjectGraph

  // true if the scans parsed all source files of the graph
  [[nodiscard]] inline bool is_graph_complete(const ProjectGraph& _graph) {
    return std::ranges::all_of(_graph.times_, [](const auto& _t) { return _t.has_value(); });
  }  // is_graph_complete

  namespace Detail {
    // the frame functions of the frameworks: an override runs in each frame
    inline constexpr std::array<std::string_view, 9> framework_frames = {
        "AActor::Tick",
        "UActorComponent::TickComponent",
        "UUserWidget::NativeTick",
        "SWidget::OnPaint",
        "FTickableGameObject::Tick",
        "QWidget::paintEvent",
        "QOpenGLWidget::paintGL",
        "QObject::timerEvent",
        "QQuickItem::updatePaintNode",
    };

    [[nodiscard]] inline std::string usr_of(const clang::Decl& _d) {
      llvm::SmallString<128> buf;
      return clang::index::generateUSRForDecl(&_d, buf) ? std::string() : std::string(buf);
    }  // usr_of

    // the pattern of an instantiation of a template, thus all instantiations are one node
    [[nodiscard]] inline const clang::FunctionDecl& pattern_of(const clang::FunctionDecl& _fn) {
      const clang::FunctionDecl* pattern = _fn.getTemplateInstantiationPattern();
      return pattern ? *pattern : _fn;
    }  // pattern_of

    // true if a file is in the project folders and not in a skipped folder. with no project folders, all files
    [[nodiscard]] inline bool is_in_scope(const GraphScope& _scope, const std::string& _key) {
      const auto is_in = [&](const std::string& _dir) { return is_under(_key, _dir); };
      return (_scope.roots_.empty() || std::ranges::any_of(_scope.roots_, is_in)) &&
             std::ranges::none_of(_scope.skips_, is_in);
    }  // is_in_scope

    [[nodiscard]] inline uint64_t text_hash(const llvm::StringRef _text) { return llvm::xxh3_64bits(_text); }

    // the hash of the text of a file on disk. nullopt if the engine cannot read the file
    [[nodiscard]] inline std::optional<uint64_t> disk_hash(const std::string& _path) {
      const auto buf = llvm::MemoryBuffer::getFile(_path, false, false, true);
      if (!buf) return std::nullopt;
      return text_hash((*buf)->getBuffer());
    }  // disk_hash

    // the frame function of a framework that a method overrides, directly or through other overrides. else empty
    [[nodiscard]] inline std::string framework_frame_of(const clang::CXXMethodDecl& _m) {
      std::vector<const clang::CXXMethodDecl*> todo(_m.overridden_methods().begin(), _m.overridden_methods().end());
      std::unordered_set<const clang::CXXMethodDecl*> seen;
      while (!todo.empty()) {
        const clang::CXXMethodDecl* m = todo.back();
        todo.pop_back();
        if (!seen.insert(m).second) continue;
        const std::string name = m->getQualifiedNameAsString();
        if (llvm::is_contained(framework_frames, name)) return name;
        todo.insert(todo.end(), m->overridden_methods().begin(), m->overridden_methods().end());
      }
      return {};
    }  // framework_frame_of

    // true if an expression names one of the variables
    [[nodiscard]] inline bool names_any(const clang::Stmt* _s,
                                        const llvm::SmallPtrSetImpl<const clang::VarDecl*>& _vars) {
      if (!_s) return false;
      if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_s))
        if (const auto* v = llvm::dyn_cast<clang::VarDecl>(r->getDecl()); v && _vars.contains(v)) return true;
      return llvm::any_of(_s->children(), [&](const clang::Stmt* _c) { return names_any(_c, _vars); });
    }  // names_any

    // the size functions of the containers of the standard library, of qt and of unreal engine
    inline constexpr std::array<std::string_view, 7> size_functions = {
        "empty", "isEmpty", "IsEmpty", "size", "count", "Num", "length",
    };

    // true if a condition only tests the size of a container, for example !queue.empty() or list.size() > 0. such a
    // loop takes the items of the container, and then it ends
    [[nodiscard]] inline bool is_size_test(const clang::Expr* _e) {
      if (!_e) return false;
      _e = _e->IgnoreParenImpCasts();
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(_e); u && u->getOpcode() == clang::UO_LNot)
        return is_size_test(u->getSubExpr());
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(_e); b && b->isComparisonOp())
        return is_size_test(b->getLHS()) || is_size_test(b->getRHS());
      const auto* call                   = llvm::dyn_cast<clang::CXXMemberCallExpr>(_e);
      const clang::CXXMethodDecl* method = call ? call->getMethodDecl() : nullptr;
      return method && method->getIdentifier() &&
             llvm::is_contained(size_functions, std::string_view(method->getName()));
    }  // is_size_test

    // a loop with no fixed number of iterations: while, do, and a for with no condition, or with a condition that does
    // not use a variable of its init. a range for has a fixed number, and so has a loop that empties a container
    [[nodiscard]] inline bool is_open_loop(const clang::Stmt& _s) {
      if (const auto* w = llvm::dyn_cast<clang::WhileStmt>(&_s)) return !is_size_test(w->getCond());
      if (const auto* d = llvm::dyn_cast<clang::DoStmt>(&_s)) return !is_size_test(d->getCond());
      const auto* f = llvm::dyn_cast<clang::ForStmt>(&_s);
      if (!f) return false;
      if (!f->getCond()) return true;
      llvm::SmallPtrSet<const clang::VarDecl*, 4> vars;
      if (const auto* init = llvm::dyn_cast_or_null<clang::DeclStmt>(f->getInit()))
        for (const clang::Decl* d : init->decls())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d)) vars.insert(v);
      return vars.empty() || !names_any(f->getCond(), vars);
    }  // is_open_loop

    // a virtual call can run an override of the function that it names. a call with a qualifier, for example
    // Base::run(), runs the named function. a final function and a final class have no override
    [[nodiscard]] inline bool is_virtual_call(const clang::CallExpr& _c) {
      const auto* mc     = llvm::dyn_cast<clang::CXXMemberCallExpr>(&_c);
      const auto* method = mc ? mc->getMethodDecl() : nullptr;
      const auto* member = mc ? llvm::dyn_cast<clang::MemberExpr>(mc->getCallee()->IgnoreParens()) : nullptr;
      if (!method || !method->isVirtual() || !member || member->hasQualifier() || method->hasAttr<clang::FinalAttr>())
        return false;
      clang::QualType type = mc->getImplicitObjectArgument()->IgnoreParenImpCasts()->getType();
      if (type->isPointerType()) type = type->getPointeeType();
      const clang::CXXRecordDecl* object = type->getAsCXXRecordDecl();
      return !object || !object->hasAttr<clang::FinalAttr>();
    }  // is_virtual_call

    // the calls of a body: the calls of the functions of the project, the virtual calls, and the constructors of the
    // project. a call in a lambda belongs to the body
    struct GraphCallWalker {
      const clang::SourceManager& sm_;
      ProjectFiles& files_;
      std::vector<GraphCall>& out_;

      // _loops: the number of loops around _s. _isMainLoop: a loop with no fixed number of iterations is around _s
      void walk(const clang::Stmt* _s, const uint32_t _loops, const bool _isMainLoop) {
        if (!_s) return;
        uint32_t loops  = _loops;
        bool isMainLoop = _isMainLoop;
        if (llvm::isa<clang::ForStmt, clang::WhileStmt, clang::DoStmt, clang::CXXForRangeStmt>(_s)) {
          ++loops;
          isMainLoop = isMainLoop || is_open_loop(*_s);
        }
        if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_s)) {
          if (const clang::FunctionDecl* callee = called_function(c))
            add(pattern_of(*callee), c->getBeginLoc(), loops > 0, is_virtual_call(*c), isMainLoop);
        } else if (const auto* e = llvm::dyn_cast<clang::CXXConstructExpr>(_s)) {
          if (const clang::CXXConstructorDecl* ctor = e->getConstructor(); ctor && !ctor->isImplicit())
            add(pattern_of(*ctor), e->getBeginLoc(), loops > 0, false, isMainLoop);
        }
        for (const clang::Stmt* c : _s->children()) walk(c, loops, isMainLoop);
      }  // walk

     private:
      // a call of a function out of the project counts only as a virtual call, because an override can be in the
      // project
      void add(const clang::FunctionDecl& _callee, const clang::SourceLocation _at, const bool _isInLoop,
               const bool _isVirtual, const bool _isMainLoop) {
        if (!_isVirtual && !files_.contains(_callee.getLocation())) return;
        GraphCall c;
        c.to_ = usr_of(_callee);
        if (c.to_.empty()) return;
        c.line_       = sm_.getExpansionLineNumber(sm_.getExpansionLoc(_at));
        c.isInLoop_   = _isInLoop;
        c.isVirtual_  = _isVirtual;
        c.isMainLoop_ = _isMainLoop;
        out_.push_back(std::move(c));
      }  // add
    };  // GraphCallWalker

    // the functions that one source file gets in a scan, by the key of their file
    using UnitFunctions = std::unordered_map<std::string, std::vector<GraphFunction>>;

    // the files of the project in one scan. the first source file that asks for a file gets it
    class GraphClaims {
      std::mutex mutex_;
      std::unordered_map<std::string, size_t> owners_;  // the key of a file -> the source file that got it

     public:
      [[nodiscard]] bool claim(const std::string& _key, const size_t _unit) {
        const std::lock_guard lock(mutex_);
        return owners_.try_emplace(_key, _unit).first->second == _unit;
      }  // claim
    };  // GraphClaims

    // collects the function definitions in the files of the project that the source file gets. the parser asks the
    // consumer for each function body, and skips the bodies in the other files
    class GraphConsumer : public clang::ASTConsumer {
      clang::CompilerInstance& ci_;
      const GraphScope& scope_;
      GraphClaims& claims_;
      const size_t unit_;
      UnitFunctions& out_;
      bool& isParsed_;
      std::unique_ptr<ProjectFiles> files_;
      llvm::DenseMap<clang::FileID, std::vector<GraphFunction>*> owned_;  // null for a file that the unit did not get

     public:
      GraphConsumer(clang::CompilerInstance& _ci, const GraphScope& _scope, GraphClaims& _claims, const size_t _unit,
                    UnitFunctions& _out, bool& _isParsed)
          : ci_(_ci), scope_(_scope), claims_(_claims), unit_(_unit), out_(_out), isParsed_(_isParsed) {}

      bool shouldSkipFunctionBody(clang::Decl* _d) override { return !owned(_d->getLocation()); }

      void HandleTranslationUnit(clang::ASTContext& _ctx) override {
        isParsed_ = true;
        collect(*_ctx.getTranslationUnitDecl(), _ctx.getSourceManager());
      }  // HandleTranslationUnit

     private:
      [[nodiscard]] ProjectFiles& files() {
        if (!files_) files_ = std::make_unique<ProjectFiles>(ci_.getSourceManager(), scope_.roots_, scope_.skips_);
        return *files_;
      }  // files

      // the functions of the file of a location, if the source file got the file. else null
      [[nodiscard]] std::vector<GraphFunction>* owned(const clang::SourceLocation _loc) {
        const clang::SourceManager& sm = ci_.getSourceManager();
        const clang::SourceLocation at = sm.getFileLoc(_loc);
        if (at.isInvalid()) return nullptr;
        const auto [it, isNew] = owned_.try_emplace(sm.getFileID(at), nullptr);
        if (isNew && files().contains(at))
          if (std::string key = normalize_path(file_of(sm, at)); !key.empty() && claims_.claim(key, unit_))
            it->second = &out_[std::move(key)];
        return it->second;
      }  // owned

      // each block of a namespace is a declaration of its own, thus the walk skips the namespaces and the classes of
      // the libraries
      void collect(const clang::DeclContext& _dc, const clang::SourceManager& _sm) {
        for (const clang::Decl* d : _dc.decls()) {
          if (const auto* t = llvm::dyn_cast<clang::FunctionTemplateDecl>(d)) d = t->getTemplatedDecl();
          if (const auto* t = llvm::dyn_cast<clang::ClassTemplateDecl>(d)) d = t->getTemplatedDecl();
          if (const auto* f = llvm::dyn_cast<clang::FunctionDecl>(d)) {
            if (f->doesThisDeclarationHaveABody() && f->getBody() && !f->isImplicit() && !f->isTemplateInstantiation())
              if (std::vector<GraphFunction>* list = owned(f->getLocation())) add(*f, _sm, *list);
            continue;
          }
          const bool isScope = llvm::isa<clang::NamespaceDecl, clang::CXXRecordDecl>(d);
          if (llvm::isa<clang::LinkageSpecDecl, clang::ExportDecl>(d) ||
              (isScope && files().contains(d->getLocation())))
            collect(*llvm::cast<clang::DeclContext>(d), _sm);
        }
      }  // collect

      void add(const clang::FunctionDecl& _fn, const clang::SourceManager& _sm, std::vector<GraphFunction>& _out) {
        GraphFunction g;
        g.usr_ = usr_of(_fn);
        if (g.usr_.empty()) return;
        g.name_                = _fn.getQualifiedNameAsString();
        g.file_                = file_of(_sm, _fn.getLocation());
        g.first_               = _sm.getExpansionLineNumber(_sm.getExpansionLoc(_fn.getSourceRange().getBegin()));
        g.last_                = _sm.getExpansionLineNumber(_sm.getExpansionLoc(_fn.getSourceRange().getEnd()));
        const std::string name = _fn.getNameAsString();
        const bool isGlobal    = _fn.getDeclContext()->getRedeclContext()->isTranslationUnit();
        g.isMain_ = _fn.isMain() || (isGlobal && (name == "wmain" || name == "WinMain" || name == "wWinMain"));
        if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(&_fn)) {
          for (const clang::CXXMethodDecl* o : m->getCanonicalDecl()->overridden_methods())
            if (std::string usr = usr_of(*o); !usr.empty()) g.overridden_.push_back(std::move(usr));
          g.frame_ = framework_frame_of(*m->getCanonicalDecl());
        }
        GraphCallWalker walker{_sm, files(), g.calls_};
        walker.walk(_fn.getBody(), 0, false);
        if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(&_fn))
          for (const clang::CXXCtorInitializer* init : ctor->inits())
            if (init->isWritten() && init->getInit()) walker.walk(init->getInit(), 0, false);
        _out.push_back(std::move(g));
      }  // add
    };  // GraphConsumer

    class GraphAction : public clang::ASTFrontendAction {
      const GraphScope& scope_;
      GraphClaims& claims_;
      const size_t unit_;
      UnitFunctions& out_;
      bool& isParsed_;

     public:
      GraphAction(const GraphScope& _scope, GraphClaims& _claims, const size_t _unit, UnitFunctions& _out,
                  bool& _isParsed)
          : scope_(_scope), claims_(_claims), unit_(_unit), out_(_out), isParsed_(_isParsed) {}

      std::unique_ptr<clang::ASTConsumer> CreateASTConsumer(clang::CompilerInstance& _ci, llvm::StringRef) override {
        return std::make_unique<GraphConsumer>(_ci, scope_, claims_, unit_, out_, isParsed_);
      }  // CreateASTConsumer
    };  // GraphAction

    // a parse with the unsaved text of the open files. the parser asks the consumer whether it skips a function body
    class GraphFactory : public clang::tooling::FrontendActionFactory {
      const std::vector<Buffer>& buffers_;
      const GraphScope& scope_;
      GraphClaims& claims_;
      const size_t unit_;
      UnitFunctions& out_;
      bool& isParsed_;

     public:
      GraphFactory(const std::vector<Buffer>& _buffers, const GraphScope& _scope, GraphClaims& _claims,
                   const size_t _unit, UnitFunctions& _out, bool& _isParsed)
          : buffers_(_buffers), scope_(_scope), claims_(_claims), unit_(_unit), out_(_out), isParsed_(_isParsed) {}

      std::unique_ptr<clang::FrontendAction> create() override {
        return std::make_unique<GraphAction>(scope_, claims_, unit_, out_, isParsed_);
      }  // create

      bool runInvocation(std::shared_ptr<clang::CompilerInvocation> _inv, clang::FileManager* _files,
                         std::shared_ptr<clang::PCHContainerOperations> _pch,
                         clang::DiagnosticConsumer* _diags) override {
        clang::PreprocessorOptions& opts = _inv->getPreprocessorOpts();
        for (const Buffer& b : buffers_)
          opts.addRemappedFile(b.path_, llvm::MemoryBuffer::getMemBufferCopy(b.text_, b.path_).release());
        opts.RetainRemappedFileBuffers             = false;  // the compiler instance deletes the buffers
        _inv->getFrontendOpts().SkipFunctionBodies = true;
        return clang::tooling::FrontendActionFactory::runInvocation(std::move(_inv), _files, std::move(_pch), _diags);
      }  // runInvocation
    };  // GraphFactory

    // the functions in the files of the project that one source file gets in a scan. a parse with errors also gives
    // the functions that clang understood. nullopt if the source file has no command, or if clang could not start the
    // parse
    [[nodiscard]] inline std::optional<UnitFunctions> scan_unit(const CompileDb& _db, const std::string& _unit,
                                                                const size_t _index, const std::string& _resource_dir,
                                                                const std::vector<Buffer>& _buffers,
                                                                const GraphScope& _scope, GraphClaims& _claims) {
      auto cmd = db_command(_db, _unit, _resource_dir);
      if (!cmd || cmd->args_.empty()) return std::nullopt;
      if (!_resource_dir.empty()) cmd->args_.insert(cmd->args_.begin() + 1, "-resource-dir=" + _resource_dir);
      llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem> fs(llvm::vfs::createPhysicalFileSystem().release());
      fs->setCurrentWorkingDirectory(cmd->directory_);
      clang::FileSystemOptions fso;
      fso.WorkingDir   = cmd->directory_;
      const auto files = llvm::makeIntrusiveRefCnt<clang::FileManager>(fso, fs);
      UnitFunctions out;
      bool isParsed = false;
      GraphFactory factory(_buffers, _scope, _claims, _index, out, isParsed);
      clang::tooling::ToolInvocation tool(std::move(cmd->args_), &factory, files.get(),
                                          std::make_shared<clang::PCHContainerOperations>());
      clang::IgnoringDiagConsumer ignore;
      tool.setDiagnosticConsumer(&ignore);
      tool.run();
      if (!isParsed) return std::nullopt;
      return out;
    }  // scan_unit
  }  // namespace Detail

  // the folders of the project: the project folders with no build folders. a build folder is the folder of a compile
  // database in a project folder, or a folder _deps with the libraries that cmake fetches. such a folder can also be
  // out of the folder of the compile database
  [[nodiscard]] inline GraphScope graph_scope(const std::vector<CompileDb>& _dbs,
                                              const std::vector<std::string>& _roots) {
    GraphScope out;
    for (const std::string& r : _roots) out.roots_.push_back(normalize_path(r));
    const auto skip = [&](std::string _dir) {
      const bool isIn =
          std::ranges::any_of(out.roots_, [&](const std::string& _r) { return Detail::is_under(_dir, _r); });
      if (isIn && !llvm::is_contained(out.skips_, _dir)) out.skips_.push_back(std::move(_dir));
    };
    const std::string sep  = llvm::sys::path::get_separator().str();
    const std::string deps = sep + "_deps" + sep;
    for (const CompileDb& db : _dbs) {
      skip(normalize_path(llvm::sys::path::parent_path(db.path_).str()));
      for (const std::string& f : db.files_)
        if (const size_t at = f.find(deps); at != std::string::npos) skip(f.substr(0, at + deps.size() - sep.size()));
    }
    return out;
  }  // graph_scope

  // a graph with no scan: the source files of the compile databases in the folders of the project. with no project
  // folders, all source files
  [[nodiscard]] inline ProjectGraph new_graph(const std::vector<CompileDb>& _dbs,
                                              const std::vector<std::string>& _roots) {
    ProjectGraph out;
    out.roots_ = _roots;
    out.scope_ = graph_scope(_dbs, _roots);
    std::unordered_set<std::string> seen;
    for (int32_t d = 0; d < int32_t(_dbs.size()); ++d)
      for (const std::string& f : _dbs[size_t(d)].db_->getAllFiles()) {
        std::string key = normalize_path(f);
        if (!Detail::is_in_scope(out.scope_, key) || !seen.insert(key).second) continue;
        out.units_.push_back(f);
        out.unitKeys_.push_back(std::move(key));
        out.dbs_.push_back(d);
      }
    out.times_.resize(out.units_.size());
    return out;
  }  // new_graph

  // the source files of a graph that need a scan: the source files with no scan, the source files that include a file
  // that changed on disk after their scan, and the source files that include an open file with a new text. an open file
  // with no text at the last scan has a new text if its text is not the text on disk. this is also true for a file that
  // the user closed after the scan. _index gives the files of each source file. with no index, only the source files
  // count
  [[nodiscard]] inline std::vector<size_t> old_units(const ProjectGraph& _graph, const UnitIndex* _index,
                                                     const std::vector<Buffer>& _buffers) {
    std::unordered_map<std::string, size_t> unitOf;
    for (size_t u = 0; u < _graph.unitKeys_.size(); ++u) unitOf.emplace(_graph.unitKeys_[u], u);
    const auto is_in   = [&](const std::string& _key) { return Detail::is_in_scope(_graph.scope_, _key); };
    const auto time_of = [](const std::string& _path) -> std::optional<llvm::sys::TimePoint<>> {
      llvm::sys::fs::file_status st;
      if (llvm::sys::fs::status(_path, st)) return std::nullopt;
      return st.getLastModificationTime();
    };
    std::vector<bool> isOld(_graph.units_.size(), false);

    // the source files with no scan, and the changes on disk after the scan of a source file
    for (size_t u = 0; u < _graph.units_.size(); ++u) {
      const std::optional<llvm::sys::TimePoint<>>& scan = _graph.times_[u];
      const std::optional<llvm::sys::TimePoint<>> time  = scan ? time_of(_graph.units_[u]) : std::nullopt;
      if (!scan || (time && *time > *scan)) isOld[u] = true;
    }
    if (_index)
      for (const auto& [key, i] : _index->files_) {
        if (!is_in(key)) continue;
        const std::optional<llvm::sys::TimePoint<>> time = time_of(_index->paths_[size_t(i)]);
        if (!time) continue;
        for (const int32_t iu : _index->includers_[size_t(i)])
          if (const auto u = unitOf.find(_index->unitKeys_[size_t(iu)]); u != unitOf.end())
            if (const auto& scan = _graph.times_[u->second]; scan && *time > *scan) isOld[u->second] = true;
      }

    // the source files of an open file with a new text: the file itself, and the source files that include it
    const auto mark = [&](const std::string& _key) {
      if (!is_in(_key)) return;
      if (const auto it = unitOf.find(_key); it != unitOf.end()) isOld[it->second] = true;
      if (!_index) return;
      if (const auto it = _index->files_.find(_key); it != _index->files_.end())
        for (const int32_t iu : _index->includers_[size_t(it->second)])
          if (const auto u = unitOf.find(_index->unitKeys_[size_t(iu)]); u != unitOf.end()) isOld[u->second] = true;
    };
    std::unordered_set<std::string> open;
    for (const Buffer& b : _buffers) {
      std::string key     = normalize_path(b.path_);
      const uint64_t hash = Detail::text_hash(b.text_);
      const auto it       = _graph.texts_.find(key);
      if (it != _graph.texts_.end() ? it->second != hash : Detail::disk_hash(b.path_) != hash) mark(key);
      open.insert(std::move(key));
    }
    // the key of a closed file is also its path, because normalize_path changes only the case on windows
    for (const auto& [key, hash] : _graph.texts_)
      if (!open.contains(key) && Detail::disk_hash(key) != hash) mark(key);

    std::vector<size_t> out;
    for (size_t u = 0; u < isOld.size(); ++u)
      if (isOld[u]) out.push_back(u);
    return out;
  }  // old_units

  // the nodes, the edges, the callers and the frame functions of the files. the first file in the sort order with a
  // function gives it
  inline void merge_graph(ProjectGraph& _g) {
    _g.nodes_.clear();
    _g.fileOf_.clear();
    _g.byUsr_.clear();
    _g.frames_.clear();
    std::vector<const std::string*> keys;
    for (const auto& [key, file] : _g.files_) keys.push_back(&key);
    std::ranges::sort(keys, [](const std::string* _a, const std::string* _b) { return *_a < *_b; });
    for (size_t k = 0; k < keys.size(); ++k)
      for (const GraphFunction& f : *_g.files_.at(*keys[k]))
        if (_g.byUsr_.try_emplace(f.usr_, int32_t(_g.nodes_.size())).second) {
          _g.nodes_.push_back(&f);
          _g.fileOf_.push_back(int32_t(k));
        }
    const size_t count = _g.nodes_.size();
    _g.out_.assign(count, {});
    _g.callers_.assign(count, {});

    // the overrides of each function, also of a function out of the project. all overrides of a function are also the
    // overrides of its overrides
    std::unordered_map<std::string, std::vector<int32_t>> overrides;
    for (size_t i = 0; i < count; ++i)
      for (const std::string& o : _g.nodes_[i]->overridden_) overrides[o].push_back(int32_t(i));
    std::unordered_map<std::string, std::vector<int32_t>> all;
    const auto all_overrides = [&](const std::string& _usr) -> const std::vector<int32_t>& {
      if (const auto it = all.find(_usr); it != all.end()) return it->second;
      std::vector<int32_t> out;
      std::vector<std::string> todo{_usr};
      while (!todo.empty()) {
        const std::string usr = std::move(todo.back());
        todo.pop_back();
        const auto o = overrides.find(usr);
        if (o == overrides.end()) continue;
        for (const int32_t n : o->second)
          if (!llvm::is_contained(out, n)) {
            out.push_back(n);
            todo.push_back(_g.nodes_[size_t(n)]->usr_);
          }
      }
      return all[_usr] = std::move(out);
    };

    for (size_t i = 0; i < count; ++i)
      for (const GraphCall& c : _g.nodes_[i]->calls_) {
        std::vector<int32_t> targets;
        if (const auto it = _g.byUsr_.find(c.to_); it != _g.byUsr_.end()) targets.push_back(it->second);
        if (c.isVirtual_)
          for (const int32_t o : all_overrides(c.to_))
            if (!llvm::is_contained(targets, o)) targets.push_back(o);
        for (const int32_t t : targets) {
          if (t == int32_t(i)) continue;  // a recursion
          _g.out_[i].push_back(GraphEdge{t, c.line_, c.isInLoop_});
          if (!llvm::is_contained(_g.callers_[size_t(t)], int32_t(i))) _g.callers_[size_t(t)].push_back(int32_t(i));
        }
      }

    // the frame functions: the overrides of the frame functions of the frameworks, and the functions that a main loop
    // calls. the main loop is in main. if main has no main loop, it is in the functions that main calls
    const auto add_frame = [&](const int32_t _node, std::string _reason) {
      if (std::ranges::none_of(_g.frames_, [&](const GraphRoot& _r) { return _r.node_ == _node; }))
        _g.frames_.push_back(GraphRoot{_node, std::move(_reason)});
    };
    for (size_t i = 0; i < count; ++i)
      if (!_g.nodes_[i]->frame_.empty()) add_frame(int32_t(i), "override of " + _g.nodes_[i]->frame_);
    for (size_t m = 0; m < count; ++m) {
      if (!_g.nodes_[m]->isMain_) continue;
      std::vector<int32_t> loopers{int32_t(m)};
      if (std::ranges::none_of(_g.nodes_[m]->calls_, [](const GraphCall& _c) { return _c.isMainLoop_; }))
        for (const GraphEdge& e : _g.out_[m])
          if (!llvm::is_contained(loopers, e.to_)) loopers.push_back(e.to_);
      for (const int32_t f : loopers)
        for (const GraphCall& c : _g.nodes_[size_t(f)]->calls_)
          if (const auto it = _g.byUsr_.find(c.to_); c.isMainLoop_ && it != _g.byUsr_.end() && it->second != f)
            add_frame(it->second, "called in the main loop of " + _g.nodes_[size_t(f)]->name_);
    }
  }  // merge_graph

  // scans the source files _todo of a graph with the unsaved text of the open files, and merges the functions of the
  // files. _parallel(_fn) runs _fn on one or more threads at the same time. _isStopped stops the scan between two
  // source files, and _done(n) tells that the scan did n source files. a scan that stops keeps the source files that it
  // did. true if the graph is complete
  template <class Parallel>
  [[nodiscard]] inline bool scan_graph(ProjectGraph& _graph, const std::vector<CompileDb>& _dbs,
                                       const std::string& _resource_dir, const std::vector<Buffer>& _buffers,
                                       const std::vector<size_t>& _todo, Parallel&& _parallel,
                                       const std::function<bool()>& _isStopped,
                                       const std::function<void(size_t)>& _done) {
    const llvm::sys::TimePoint<> time =
        std::chrono::time_point_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now());
    for (const size_t u : _todo) _graph.times_[u].reset();

    // the calls of _fn take the source files from a shared counter
    Detail::GraphClaims claims;
    std::mutex mutex;  // for the graph
    std::atomic<size_t> next = 0, done = 0;
    _parallel([&]() {
      for (size_t i = next++; i < _todo.size() && !_isStopped(); i = next++) {
        const size_t u                           = _todo[i];
        std::optional<Detail::UnitFunctions> fns = Detail::scan_unit(_dbs[size_t(_graph.dbs_[u])], _graph.units_[u], u,
                                                                     _resource_dir, _buffers, _graph.scope_, claims);
        {
          const std::lock_guard lock(mutex);
          std::erase(_graph.failed_, _graph.units_[u]);
          if (!fns)
            _graph.failed_.push_back(_graph.units_[u]);
          else
            for (auto& [key, list] : *fns)
              _graph.files_[key] = std::make_shared<const std::vector<GraphFunction>>(std::move(list));
          _graph.times_[u] = time;
        }
        _done(++done);
      }
    });

    // the texts of the open files apply only to a complete graph. else the next scan does their source files again
    const bool isComplete = is_graph_complete(_graph);
    if (isComplete) {
      _graph.texts_.clear();
      for (const Buffer& b : _buffers) _graph.texts_[normalize_path(b.path_)] = Detail::text_hash(b.text_);
    }
    merge_graph(_graph);
    return isComplete;
  }  // scan_graph

  //----------------------------------
  // Frame paths

  // a function on a frame path: the caller before it on the path, the frame function at the start, the number of calls
  // from the frame function, and whether a caller on the frame path calls it in a loop
  struct FrameStep {
    int32_t from_   = -1;  // -1 for a frame function
    int32_t frame_  = -1;  // the index in FramePaths::frames_
    uint32_t depth_ = 0;
    bool isInLoop_  = false;
  };  // FrameStep

  struct FramePaths {
    std::vector<GraphRoot> frames_;  // the frame functions of the code and of the names
    std::unordered_map<int32_t, FrameStep> steps_;
  };  // FramePaths

  // the calls from a frame function that a frame path follows
  inline constexpr uint32_t frame_max_depth = 8;

  // the functions on a frame path. _names: more frame functions, by a qualified name, or by the end of a qualified name
  // after ::, for example Renderer::frame or frame
  [[nodiscard]] inline FramePaths frame_paths(const ProjectGraph& _g, const std::vector<std::string>& _names) {
    FramePaths out;
    out.frames_ = _g.frames_;
    for (size_t i = 0; i < _g.nodes_.size(); ++i) {
      const std::string& name = _g.nodes_[i]->name_;
      const bool isNamed      = std::ranges::any_of(_names, [&](const std::string& _n) {
        return !_n.empty() && (name == _n || (name.size() > _n.size() + 2 && name.ends_with("::" + _n)));
      });
      if (isNamed && std::ranges::none_of(out.frames_, [&](const GraphRoot& _r) { return _r.node_ == int32_t(i); }))
        out.frames_.push_back(GraphRoot{int32_t(i), "frame function of the setting"});
    }

    std::deque<int32_t> todo;
    for (size_t r = 0; r < out.frames_.size(); ++r)
      if (out.steps_.try_emplace(out.frames_[r].node_, FrameStep{-1, int32_t(r), 0, false}).second)
        todo.push_back(out.frames_[r].node_);
    while (!todo.empty()) {
      const int32_t n = todo.front();
      todo.pop_front();
      const FrameStep step = out.steps_.at(n);
      if (step.depth_ >= frame_max_depth) continue;
      for (const GraphEdge& e : _g.out_[size_t(n)]) {
        const auto [it, isNew] = out.steps_.try_emplace(e.to_, FrameStep{n, step.frame_, step.depth_ + 1, e.isInLoop_});
        if (isNew)
          todo.push_back(e.to_);
        else if (e.isInLoop_)
          it->second.isInLoop_ = true;
      }
    }
    return out;
  }  // frame_paths

  //----------------------------------
  // Json

  // the walk up the graph for the transitive callers of a function stops at this number of callers
  inline constexpr size_t max_transitive_callers = 1000;

  // the reach of a function in the graph: the direct callers, the transitive callers, the files of the transitive
  // callers other than the file of the function, and the frame path. null if the graph has no node for the function
  [[nodiscard]] inline Json reach_to_json(const ProjectGraph& _g, const FramePaths& _paths,
                                          const clang::FunctionDecl& _fn) {
    const auto it = _g.byUsr_.find(Detail::usr_of(Detail::pattern_of(_fn)));
    if (it == _g.byUsr_.end()) {
      // no source file of the scan includes the file of the function, thus it has no callers. a function that is newer
      // than the scan has no node
      const std::string key =
          normalize_path(Detail::file_of(_fn.getASTContext().getSourceManager(), _fn.getLocation()));
      if (!key.empty() && !_g.files_.contains(key))
        return JsonObject{{"callers", int64_t(0)}, {"transitiveCallers", int64_t(0)}, {"callerFiles", int64_t(0)}};
      return Json(nullptr);
    }
    const int32_t n = it->second;

    // the functions that reach the function through calls, also through recursions, and their files
    std::unordered_set<int32_t> seen{n};
    std::unordered_set<int32_t> files;
    std::vector<int32_t> todo{n};
    size_t transitive = 0;
    while (!todo.empty() && transitive < max_transitive_callers) {
      const int32_t at = todo.back();
      todo.pop_back();
      for (const int32_t c : _g.callers_[size_t(at)]) {
        if (transitive == max_transitive_callers || !seen.insert(c).second) continue;
        ++transitive;
        if (_g.fileOf_[size_t(c)] != _g.fileOf_[size_t(n)]) files.insert(_g.fileOf_[size_t(c)]);
        todo.push_back(c);
      }
    }
    JsonObject out{{"callers", int64_t(_g.callers_[size_t(n)].size())},
                   {"transitiveCallers", int64_t(transitive)},
                   {"callerFiles", int64_t(files.size())}};
    if (transitive == max_transitive_callers) out["isCapped"] = true;
    if (const auto step = _paths.steps_.find(n); step != _paths.steps_.end()) {
      // the path from the frame function to the caller before the function
      std::vector<std::string> path;
      for (int32_t at = step->second.from_; at >= 0; at = _paths.steps_.at(at).from_)
        path.push_back(_g.nodes_[size_t(at)]->name_);
      std::ranges::reverse(path);
      out["frame"] = JsonObject{{"reason", _paths.frames_[size_t(step->second.frame_)].reason_},
                                {"path", JsonArray(path)},
                                {"isInLoop", step->second.isInLoop_}};
    }
    return out;
  }  // reach_to_json

  // the size of the graph, the frame functions and the source files that the scan could not parse. _scanned: the
  // source files of the last scan
  [[nodiscard]] inline JsonObject graph_to_json(const ProjectGraph& _g, const FramePaths& _paths,
                                                const size_t _scanned) {
    size_t calls = 0;
    for (const std::vector<GraphEdge>& list : _g.out_) calls += list.size();
    JsonArray frames;
    for (const GraphRoot& r : _paths.frames_)
      frames.push_back(JsonObject{{"name", _g.nodes_[size_t(r.node_)]->name_},
                                  {"file", _g.nodes_[size_t(r.node_)]->file_},
                                  {"line", int64_t(_g.nodes_[size_t(r.node_)]->first_)},
                                  {"reason", r.reason_}});
    return JsonObject{
        {"units", int64_t(_g.units_.size())},     {"scanned", int64_t(_scanned)}, {"isComplete", is_graph_complete(_g)},
        {"functions", int64_t(_g.nodes_.size())}, {"calls", int64_t(calls)},      {"frames", std::move(frames)},
        {"failed", JsonArray(_g.failed_)}};
  }  // graph_to_json

}  // namespace DataFlow
