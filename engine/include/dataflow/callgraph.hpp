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
    > the index of the uses: the data members, the static data members and the global variables of the project that
      each body reads or writes, and the switch statements on the enums of the project with the enumerators of their
      case labels. the index keeps each usr and each name of an enumerator one time, as a number
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

  // a use of the address of a function of the project, by its usr. a call through a pointer or a std::function can then
  // run the function, and the call graph cannot see that call
  struct GraphRef {
    std::string to_;
    uint32_t line_ = 0;
  };  // GraphRef

  // a connection of a signal of qt to a slot with pointers to members, by the usrs of both
  struct GraphConnect {
    std::string signal_;
    std::string slot_;
    std::string signalName_;  // the qualified name of the signal
    std::string signalFile_;  // the file of the declaration of a signal of the project. empty for a signal of a library
    uint32_t signalLine_ = 0;
    uint32_t line_       = 0;  // the line of the call of connect
  };  // GraphConnect

  // a data member, a static data member or a global variable of the project that a body uses, by the number of its usr
  // in GraphNames. a body has one use for each variable
  struct GraphUse {
    uint32_t name_ = 0;
    uint32_t line_ = 0;  // the first use
    bool isRead_   = false;
    bool isWrite_  = false;  // an assignment, ++, --, &, a call of a non-const member function or a non-const reference
  };  // GraphUse

  // a switch statement on an enum of the project
  struct GraphSwitch {
    uint32_t enum_ = 0;  // the number of the usr of the enum in GraphNames
    uint32_t line_ = 0;
    std::vector<uint32_t> handled_;  // the numbers of the names of the enumerators with a case label
    bool hasDefault_ = false;
  };  // GraphSwitch

  // the usrs and the names of the index, each one time. a use refers to a name by its number, so the memory stays
  // small. the scans of a server share the table, so the numbers stay the same after an update. the table only grows
  class GraphNames {
    mutable std::mutex mutex_;
    std::deque<std::string> names_;  // a deque keeps the views of numbers_ valid
    std::unordered_map<std::string_view, uint32_t> numbers_;
    size_t bytes_ = 0;

   public:
    [[nodiscard]] uint32_t add(const std::string_view _name) {
      const std::lock_guard lock(mutex_);
      if (const auto it = numbers_.find(_name); it != numbers_.end()) return it->second;
      const std::string& name = names_.emplace_back(_name);
      bytes_ += name.capacity() + sizeof(std::string) + 48;  // the string and the entry of the map
      return numbers_.emplace(name, uint32_t(names_.size() - 1)).first->second;
    }  // add

    // the number of a name, or nullopt if no scan saw the name
    [[nodiscard]] std::optional<uint32_t> find(const std::string_view _name) const {
      const std::lock_guard lock(mutex_);
      const auto it = numbers_.find(_name);
      return it != numbers_.end() ? std::optional(it->second) : std::nullopt;
    }  // find

    [[nodiscard]] size_t get_count() const {
      const std::lock_guard lock(mutex_);
      return names_.size();
    }  // get_count

    [[nodiscard]] size_t get_bytes() const {
      const std::lock_guard lock(mutex_);
      return bytes_;
    }  // get_bytes
  };  // GraphNames

  // a function definition in a file of the project. a signal of qt with no body and the initializers of the global
  // variables of a file also have an entry
  struct GraphFunction {
    std::string usr_;
    std::string name_;  // the qualified name
    std::string file_;
    uint32_t first_ = 0;
    uint32_t last_  = 0;
    std::string frame_;  // the frame function of a framework that the function overrides, for example AActor::Tick
    std::string libraryOverride_;  // a virtual function out of the project that the function overrides
    bool isMain_   = false;
    bool isSlot_   = false;                // the class declares the function in a slots section of qt
    bool isSignal_ = false;                // a signal of qt of the project. its body is in a file of moc
    bool isInit_   = false;                // no function: the initializers of the global variables of the file
    std::vector<std::string> overridden_;  // the usrs of the functions that it overrides directly
    std::vector<GraphCall> calls_;
    std::vector<GraphRef> refs_;
    std::vector<GraphConnect> connects_;
    std::vector<GraphUse> uses_;
    std::vector<GraphSwitch> switches_;
  };  // GraphFunction

  struct GraphEdge {
    int32_t to_        = -1;
    uint32_t line_     = 0;  // the line of the call, or of the call of connect for a connection
    bool isInLoop_     = false;
    bool isConnection_ = false;  // a signal of qt runs its slot
  };  // GraphEdge

  // the reason for callers that the call graph cannot see. cause: address (a pointer or a std::function can call the
  // function), libraryOverride (a library calls the override) or slot (qt calls the slot). an empty cause: no reason
  struct GraphUnknown {
    std::string cause_;
    std::string via_;  // the function that uses the address, the overridden function, or the signal
    std::string file_;
    uint32_t line_ = 0;
  };  // GraphUnknown

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

    // the merge of the files. the nodes point into the files, and into signals_
    std::vector<const GraphFunction*> nodes_;
    std::vector<int32_t> fileOf_;  // the file of each node, as an index in the sorted keys of files_
    std::unordered_map<std::string, int32_t> byUsr_;
    std::vector<std::vector<GraphEdge>> out_;
    std::vector<std::vector<int32_t>> callers_;  // the callers of each node, each one time
    std::vector<GraphRoot> frames_;              // the frame functions of the code
    std::shared_ptr<const std::deque<GraphFunction>> signals_;  // the connected signals of qt of the project
    std::vector<GraphUnknown> unknown_;                         // the callers that the graph cannot see, of each node

    // the index of the uses: the names of the usrs, the nodes that use each variable, and the nodes with a switch on
    // each enum, by the numbers of the names
    std::shared_ptr<GraphNames> names_ = std::make_shared<GraphNames>();
    std::unordered_map<uint32_t, std::vector<int32_t>> usersOf_;
    std::unordered_map<uint32_t, std::vector<int32_t>> switchesOf_;
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

    // the helpers of qt that select an overload of a signal or a slot, for example qOverload<int>(&A::f) and
    // QOverload<int>::of(&A::f)
    inline constexpr std::array<std::string_view, 4> overload_helpers = {"of", "qOverload", "qConstOverload",
                                                                         "qNonConstOverload"};

    // the name of a function in a pointer to a function or to a member: f, &A::f, a cast of it, or a helper of qt that
    // selects an overload. null for a different expression, for example a lambda
    [[nodiscard]] inline const clang::DeclRefExpr* function_ref_of(const clang::Expr* _e) {
      const auto is_helper = [](const clang::NamedDecl* _d) {
        return _d && _d->getIdentifier() && llvm::is_contained(overload_helpers, std::string_view(_d->getName()));
      };
      for (int i = 0; _e && i < 6; ++i) {
        _e = _e->IgnoreParenImpCasts();
        if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_e))
          return llvm::isa<clang::FunctionDecl>(r->getDecl()) ? r : nullptr;
        if (const auto* cast = llvm::dyn_cast<clang::ExplicitCastExpr>(_e)) {
          _e = cast->getSubExpr();
        } else if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(_e); u && u->getOpcode() == clang::UO_AddrOf) {
          _e = u->getSubExpr();
        } else if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_e)) {
          // QOverload<int>::of(&A::f) calls the operator () of the object "of"
          const auto* object = llvm::dyn_cast<clang::DeclRefExpr>(op->getArg(0)->IgnoreParenImpCasts());
          if (op->getOperator() != clang::OO_Call || op->getNumArgs() != 2 || !object || !is_helper(object->getDecl()))
            return nullptr;
          _e = op->getArg(1);
        } else if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_e)) {
          if (c->getNumArgs() != 1 || !is_helper(c->getDirectCallee())) return nullptr;
          _e = c->getArg(0);
        } else {
          return nullptr;
        }
      }
      return nullptr;
    }  // function_ref_of

    // QObject::connect, also with no qualifier in a class of qt
    [[nodiscard]] inline bool is_connect(const clang::FunctionDecl& _fn) {
      return _fn.getIdentifier() && _fn.getName() == "connect" && _fn.getQualifiedNameAsString() == "QObject::connect";
    }  // is_connect

    // a virtual function out of the project that a method overrides, directly or through other overrides. a library
    // can call such an override, and the call graph cannot see the call. empty if there is none
    [[nodiscard]] inline std::string library_override_of(const clang::CXXMethodDecl& _m, ProjectFiles& _files) {
      std::vector<const clang::CXXMethodDecl*> todo(_m.overridden_methods().begin(), _m.overridden_methods().end());
      std::unordered_set<const clang::CXXMethodDecl*> seen;
      while (!todo.empty()) {
        const clang::CXXMethodDecl* m = todo.back();
        todo.pop_back();
        if (!seen.insert(m).second) continue;
        if (!_files.contains(m->getLocation())) return m->getQualifiedNameAsString();
        todo.insert(todo.end(), m->overridden_methods().begin(), m->overridden_methods().end());
      }
      return {};
    }  // library_override_of

    // true if the class declares the method in a slots section of qt: "public slots:" or "Q_SLOTS:". the macros give
    // no attribute, thus the text of the access specifier tells it, as for the outline
    [[nodiscard]] inline bool is_slot(const clang::CXXMethodDecl& _m, const clang::SourceManager& _sm,
                                      const clang::LangOptions& _lo) {
      const clang::CXXMethodDecl* decl     = _m.getCanonicalDecl();
      const clang::AccessSpecDecl* section = nullptr;
      for (const clang::Decl* d : decl->getParent()->decls()) {
        if (d == decl) break;
        if (const auto* t = llvm::dyn_cast<clang::FunctionTemplateDecl>(d); t && t->getTemplatedDecl() == decl) break;
        if (const auto* as = llvm::dyn_cast<clang::AccessSpecDecl>(d)) section = as;
      }
      if (!section) return false;
      const llvm::StringRef text =
          clang::Lexer::getSourceText(clang::CharSourceRange::getTokenRange(section->getSourceRange()), _sm, _lo);
      return text.contains("slots") || text.contains("SLOTS");
    }  // is_slot

    // a name with no usr
    inline constexpr uint32_t no_name = UINT32_MAX;

    // the numbers of the usrs of the declarations of one source file in a scan. the usr of a declaration comes one time
    class GraphIndex {
      GraphNames& names_;
      llvm::DenseMap<const clang::Decl*, uint32_t> numbers_;

     public:
      explicit GraphIndex(GraphNames& _names) : names_(_names) {}

      // the number of the usr of a declaration, or no_name
      [[nodiscard]] uint32_t number_of(const clang::Decl& _d) {
        const auto [it, isNew] = numbers_.try_emplace(&_d, no_name);
        if (isNew)
          if (const std::string usr = usr_of(_d); !usr.empty()) it->second = names_.add(usr);
        return it->second;
      }  // number_of

      [[nodiscard]] uint32_t number_of_name(const std::string_view _name) { return names_.add(_name); }
    };  // GraphIndex

    // the non-const member functions of the containers and the smart pointers that give a part of the object, for
    // example operator[] or front(). a call changes the object only if the code changes the part
    inline constexpr std::array<std::string_view, 15> part_functions = {
        "begin", "end",   "rbegin", "rend", "find",  "lower_bound", "upper_bound", "equal_range",
        "data",  "front", "back",   "at",   "value", "Find",        "FindRef",
    };

    // true if a call of a member function can change its object. _isPartWritten: the code changes the result of the
    // call, for example v[i] = 1
    [[nodiscard]] inline bool is_changing_call(const clang::CXXMethodDecl& _m, const bool _isPartWritten) {
      if (_m.isConst()) return false;
      const bool isPart =
          _m.isOverloadedOperator()
              ? llvm::is_contained({clang::OO_Subscript, clang::OO_Star, clang::OO_Arrow}, _m.getOverloadedOperator())
              : _m.getIdentifier() && llvm::is_contained(part_functions, std::string_view(_m.getName()));
      return !isPart || _isPartWritten;
    }  // is_changing_call

    // true if a parameter is a reference to non-const, so the function can change its argument
    [[nodiscard]] inline bool is_written_param(const clang::FunctionDecl* _fn, const size_t _param) {
      if (!_fn || _param >= _fn->getNumParams()) return false;
      const clang::QualType t = _fn->getParamDecl(unsigned(_param))->getType();
      return t->isLValueReferenceType() && !t.getNonReferenceType().isConstQualified();
    }  // is_written_param

    // true if a statement can change the value of its child: the left side of an assignment, the operand of ++, -- and
    // &, the object of a member function that changes it, an argument of a reference to non-const, a reference to
    // non-const or a range for with one, and a part of an object that the statement changes. _isWrite: the parent of
    // the statement can change the value of the statement
    [[nodiscard]] inline bool is_write(const clang::Stmt& _s, const clang::Stmt* _child, const bool _isWrite) {
      if (llvm::isa<clang::ParenExpr, clang::MaterializeTemporaryExpr>(_s)) return _isWrite;
      if (const auto* c = llvm::dyn_cast<clang::ImplicitCastExpr>(&_s)) {
        const clang::CastKind k = c->getCastKind();
        return _isWrite && (k == clang::CK_NoOp || k == clang::CK_DerivedToBase ||
                            k == clang::CK_UncheckedDerivedToBase || k == clang::CK_ArrayToPointerDecay);
      }
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(&_s))
        return b->isAssignmentOp() && _child == b->getLHS();
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(&_s))
        return u->isIncrementDecrementOp() || u->getOpcode() == clang::UO_AddrOf;
      // a change of a.b changes a. a change of p->b does not change the pointer p
      if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(&_s)) return _isWrite && !m->isArrow();
      if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(&_s))
        return _isWrite && _child == a->getBase() && a->getBase()->IgnoreImpCasts()->getType()->isArrayType();
      if (const auto* mc = llvm::dyn_cast<clang::CXXMemberCallExpr>(&_s)) {
        const clang::CXXMethodDecl* md = mc->getMethodDecl();
        if (_child == mc->getCallee()) return md && is_changing_call(*md, _isWrite);
        for (unsigned i = 0; i < mc->getNumArgs(); ++i)
          if (mc->getArg(i) == _child) return is_written_param(md, i);
        return false;
      }
      // the first argument of a member operator is its object. the other arguments are its parameters
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(&_s)) {
        const auto* md = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(op->getDirectCallee());
        for (unsigned i = 0; i < op->getNumArgs(); ++i) {
          if (op->getArg(i) != _child) continue;
          if (md) return i == 0 ? is_changing_call(*md, _isWrite) : is_written_param(md, i - 1);
          return is_written_param(op->getDirectCallee(), i);
        }
        return false;
      }
      if (const auto* c = llvm::dyn_cast<clang::CallExpr>(&_s)) {
        for (unsigned i = 0; i < c->getNumArgs(); ++i)
          if (c->getArg(i) == _child) return is_written_param(c->getDirectCallee(), i);
        return false;
      }
      if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(&_s)) {
        for (unsigned i = 0; i < c->getNumArgs(); ++i)
          if (c->getArg(i) == _child) return is_written_param(c->getConstructor(), i);
        return false;
      }
      // the variable of the range of a range for is a reference of the compiler: the loop variable tells the change
      if (const auto* d = llvm::dyn_cast<clang::DeclStmt>(&_s)) {
        for (const clang::Decl* x : d->decls()) {
          const auto* v = llvm::dyn_cast<clang::VarDecl>(x);
          if (!v || v->getInit() != _child) continue;
          if (v->isImplicit() || (v->getIdentifier() && v->getName().starts_with("__range"))) return _isWrite;
          return v->getType()->isLValueReferenceType() && !v->getType().getNonReferenceType().isConstQualified();
        }
        return false;
      }
      if (const auto* r = llvm::dyn_cast<clang::CXXForRangeStmt>(&_s)) {
        if (_child != r->getRangeStmt() || !r->getLoopVariable()) return false;
        const clang::QualType t = r->getLoopVariable()->getType();
        return t->isReferenceType() && !t.getNonReferenceType().isConstQualified();
      }
      return false;
    }  // is_write

    // the value of a case label. an enumerator of a scoped enum is no integer constant expression, thus the value
    // comes from an evaluation. nullopt for a label that depends on a template parameter
    [[nodiscard]] inline std::optional<llvm::APSInt> case_value(const clang::Expr* _e, const clang::ASTContext& _ctx) {
      if (!_e || _e->isValueDependent()) return std::nullopt;
      clang::Expr::EvalResult res;
      if (!_e->EvaluateAsInt(res, _ctx)) return std::nullopt;
      return res.Val.getInt();
    }  // case_value

    // a data member of an instantiation of a class template: the data member of the template, so all instantiations
    // have one usr
    [[nodiscard]] inline const clang::ValueDecl& member_pattern_of(const clang::ValueDecl& _d) {
      const auto* rd                      = llvm::dyn_cast<clang::CXXRecordDecl>(_d.getDeclContext());
      const clang::CXXRecordDecl* pattern = rd ? rd->getTemplateInstantiationPattern() : nullptr;
      if (!pattern || pattern == rd || !_d.getDeclName().isIdentifier()) return _d;
      for (const clang::NamedDecl* m : pattern->lookup(_d.getDeclName()))
        if (const auto* v = llvm::dyn_cast<clang::ValueDecl>(m); v && v->getKind() == _d.getKind()) return *v;
      return _d;
    }  // member_pattern_of

    // the calls of a body: the calls of the functions of the project, the virtual calls, and the constructors of the
    // project. a call in a lambda belongs to the body. the walk also records the uses of the address of a function of
    // the project, and the connections of signals of qt to slots. with an index, it also records the uses of the data
    // members and of the global variables of the project, and the switch statements on the enums of the project
    struct GraphCallWalker {
      const clang::SourceManager& sm_;
      ProjectFiles& files_;
      std::vector<GraphCall>& out_;
      std::vector<GraphRef>& refs_;
      std::vector<GraphConnect>& connects_;
      GraphIndex* index_                                 = nullptr;
      std::vector<GraphUse>* uses_                       = nullptr;
      std::vector<GraphSwitch>* switches_                = nullptr;
      llvm::SmallPtrSet<const clang::Expr*, 16> callees_ = {};  // the names that a call calls: no use of an address

      // _loops: the number of loops around _s. _isMainLoop: a loop with no fixed number of iterations is around _s.
      // _isWrite: the parent of _s can change the value of _s
      void walk(const clang::Stmt* _s, const uint32_t _loops, const bool _isMainLoop, const bool _isWrite = false) {
        if (!_s) return;
        uint32_t loops  = _loops;
        bool isMainLoop = _isMainLoop;
        if (llvm::isa<clang::ForStmt, clang::WhileStmt, clang::DoStmt, clang::CXXForRangeStmt>(_s)) {
          ++loops;
          isMainLoop = isMainLoop || is_open_loop(*_s);
        }
        if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_s)) {
          if (const clang::Expr* callee = c->getCallee()) callees_.insert(callee->IgnoreParenImpCasts());
          if (const clang::FunctionDecl* callee = called_function(c)) {
            add(pattern_of(*callee), c->getBeginLoc(), loops > 0, is_virtual_call(*c), isMainLoop);
            if (is_connect(*callee)) connect(*c);
          }
        } else if (const auto* e = llvm::dyn_cast<clang::CXXConstructExpr>(_s)) {
          if (const clang::CXXConstructorDecl* ctor = e->getConstructor(); ctor && !ctor->isImplicit())
            add(pattern_of(*ctor), e->getBeginLoc(), loops > 0, false, isMainLoop);
        } else if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_s); r && !callees_.contains(r)) {
          if (const auto* fn = llvm::dyn_cast<clang::FunctionDecl>(r->getDecl()))
            ref(pattern_of(*fn), r->getLocation());
        }
        if (index_) {
          use(*_s, _isWrite);
          if (const auto* sw = llvm::dyn_cast<clang::SwitchStmt>(_s)) add_switch(*sw);
        }
        for (const clang::Stmt* c : _s->children()) walk(c, loops, isMainLoop, index_ && is_write(*_s, c, _isWrite));
      }  // walk

     private:
      [[nodiscard]] uint32_t line_of(const clang::SourceLocation _at) const {
        return sm_.getExpansionLineNumber(sm_.getExpansionLoc(_at));
      }  // line_of

      // a use of a data member, a static data member or a global variable of the project. a constant is no use
      void use(const clang::Stmt& _s, const bool _isWrite) {
        const clang::ValueDecl* d = nullptr;
        clang::SourceLocation at;
        if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(&_s)) {
          d  = m->getMemberDecl();
          at = m->getMemberLoc();
        } else if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(&_s)) {
          d  = r->getDecl();
          at = r->getLocation();
        }
        if (!d) return;
        const auto* v = llvm::dyn_cast<clang::VarDecl>(d);
        const bool isGlobal =
            v && v->hasGlobalStorage() && !v->isStaticLocal() && !v->isConstexpr() && !v->getType().isConstQualified();
        if (!llvm::isa<clang::FieldDecl>(d) && !isGlobal) return;
        const clang::ValueDecl& pattern = member_pattern_of(*d);
        if (!files_.contains(pattern.getLocation())) return;
        const uint32_t name = index_->number_of(pattern);
        if (name == no_name) return;
        auto it = std::ranges::find(*uses_, name, &GraphUse::name_);
        if (it == uses_->end()) it = uses_->insert(uses_->end(), GraphUse{name, line_of(at), false, false});
        it->isRead_  = it->isRead_ || !_isWrite;
        it->isWrite_ = it->isWrite_ || _isWrite;
      }  // use

      // a switch statement on an enum of the project, with the enumerators of its case labels and a flag for default
      void add_switch(const clang::SwitchStmt& _s) {
        const clang::Expr* cond = _s.getCond();
        const clang::EnumDecl* e =
            cond && !cond->isTypeDependent() ? cond->IgnoreParenImpCasts()->getType()->getAsEnumDecl() : nullptr;
        if (e) e = e->getDefinition();
        if (!e || !files_.contains(e->getLocation())) return;
        GraphSwitch out;
        out.enum_ = index_->number_of(*e);
        if (out.enum_ == no_name) return;
        out.line_ = line_of(_s.getBeginLoc());
        for (const clang::SwitchCase* c = _s.getSwitchCaseList(); c; c = c->getNextSwitchCase()) {
          const auto* cs = llvm::dyn_cast<clang::CaseStmt>(c);
          if (!cs) {
            out.hasDefault_ = true;
            continue;
          }
          // a case label with a value or with a range of values, for example case 1 ... 3 of gnu
          const std::optional<llvm::APSInt> low  = case_value(cs->getLHS(), e->getASTContext());
          const std::optional<llvm::APSInt> high = cs->getRHS() ? case_value(cs->getRHS(), e->getASTContext()) : low;
          if (!low || !high) continue;
          for (const clang::EnumConstantDecl* k : e->enumerators()) {
            if (llvm::APSInt::compareValues(k->getInitVal(), *low) < 0 ||
                llvm::APSInt::compareValues(k->getInitVal(), *high) > 0)
              continue;
            const uint32_t n = index_->number_of_name(k->getName());
            if (!llvm::is_contained(out.handled_, n)) out.handled_.push_back(n);
          }
        }
        switches_->push_back(std::move(out));
      }  // add_switch

      // a use of the address of a function of the project, for example &Dialog::accept or a std::function = run
      void ref(const clang::FunctionDecl& _fn, const clang::SourceLocation _at) {
        if (!files_.contains(_fn.getLocation())) return;
        GraphRef r;
        r.to_ = usr_of(_fn);
        if (r.to_.empty()) return;
        r.line_ = line_of(_at);
        refs_.push_back(std::move(r));
      }  // ref

      // a connection with pointers to members: connect(sender, &Sender::signal, receiver, &Receiver::slot), or a
      // function as the slot. the arguments after the slot, for example the type of the connection, are no function. a
      // lambda as the slot is a part of the body
      void connect(const clang::CallExpr& _c) {
        if (_c.getNumArgs() < 3) return;
        const clang::DeclRefExpr* signalRef = function_ref_of(_c.getArg(1));
        const auto* signal = signalRef ? llvm::dyn_cast<clang::CXXMethodDecl>(signalRef->getDecl()) : nullptr;
        if (!signal) return;
        const clang::DeclRefExpr* slotRef = nullptr;
        for (unsigned i = _c.getNumArgs(); i-- > 2 && !slotRef;) slotRef = function_ref_of(_c.getArg(i));
        if (!slotRef) return;
        // the connection, not a use of an address, gives the callers of the slot
        callees_.insert(signalRef);
        callees_.insert(slotRef);
        const auto* slot = llvm::cast<clang::FunctionDecl>(slotRef->getDecl());
        if (!files_.contains(slot->getLocation())) return;
        GraphConnect g;
        g.signal_ = usr_of(pattern_of(*signal));
        g.slot_   = usr_of(pattern_of(*slot));
        if (g.signal_.empty() || g.slot_.empty()) return;
        g.signalName_ = signal->getQualifiedNameAsString();
        if (files_.contains(signal->getLocation())) {
          g.signalFile_ = file_of(sm_, signal->getLocation());
          g.signalLine_ = line_of(signal->getLocation());
        }
        g.line_ = line_of(_c.getBeginLoc());
        connects_.push_back(std::move(g));
      }  // connect

      // a call of a function out of the project counts only as a virtual call, because an override can be in the
      // project
      void add(const clang::FunctionDecl& _callee, const clang::SourceLocation _at, const bool _isInLoop,
               const bool _isVirtual, const bool _isMainLoop) {
        if (!_isVirtual && !files_.contains(_callee.getLocation())) return;
        GraphCall c;
        c.to_ = usr_of(_callee);
        if (c.to_.empty()) return;
        c.line_       = line_of(_at);
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
      GraphIndex index_;
      std::unique_ptr<ProjectFiles> files_;
      llvm::DenseMap<clang::FileID, std::vector<GraphFunction>*> owned_;  // null for a file that the unit did not get

     public:
      GraphConsumer(clang::CompilerInstance& _ci, const GraphScope& _scope, GraphClaims& _claims, const size_t _unit,
                    UnitFunctions& _out, bool& _isParsed, GraphNames& _names)
          : ci_(_ci),
            scope_(_scope),
            claims_(_claims),
            unit_(_unit),
            out_(_out),
            isParsed_(_isParsed),
            index_(_names) {}

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
          // a global or a static variable, for example a table of handlers, can use the address of a function
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->hasInit() && !v->isLocalVarDeclOrParm()) {
            if (std::vector<GraphFunction>* list = owned(v->getLocation())) add_init(*v, _sm, *list);
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
          // a frame function keeps its frame path
          if (g.frame_.empty()) g.libraryOverride_ = library_override_of(*m->getCanonicalDecl(), files());
          g.isSlot_ = is_slot(*m, _sm, ci_.getLangOpts());
        }
        GraphCallWalker walker{_sm, files(), g.calls_, g.refs_, g.connects_, &index_, &g.uses_, &g.switches_};
        walker.walk(_fn.getBody(), 0, false);
        if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(&_fn))
          for (const clang::CXXCtorInitializer* init : ctor->inits())
            if (init->isWritten() && init->getInit()) walker.walk(init->getInit(), 0, false);
        _out.push_back(std::move(g));
      }  // add

      // the uses of the addresses of functions in the initializer of a global or a static variable. they go into one
      // entry for the file, with no node in the graph
      void add_init(const clang::VarDecl& _v, const clang::SourceManager& _sm, std::vector<GraphFunction>& _out) {
        auto it = std::ranges::find_if(_out, [](const GraphFunction& _f) { return _f.isInit_; });
        if (it == _out.end()) {
          GraphFunction g;
          g.file_   = file_of(_sm, _v.getLocation());
          g.usr_    = "init:" + normalize_path(g.file_);
          g.name_   = "a global variable";
          g.isInit_ = true;
          _out.push_back(std::move(g));
          it = std::prev(_out.end());
        }
        std::vector<GraphCall> calls;  // a call of an initializer has no caller in the graph
        GraphCallWalker walker{_sm, files(), calls, it->refs_, it->connects_};
        walker.walk(_v.getInit(), 0, false);
      }  // add_init
    };  // GraphConsumer

    class GraphAction : public clang::ASTFrontendAction {
      const GraphScope& scope_;
      GraphClaims& claims_;
      const size_t unit_;
      UnitFunctions& out_;
      bool& isParsed_;
      GraphNames& names_;

     public:
      GraphAction(const GraphScope& _scope, GraphClaims& _claims, const size_t _unit, UnitFunctions& _out,
                  bool& _isParsed, GraphNames& _names)
          : scope_(_scope), claims_(_claims), unit_(_unit), out_(_out), isParsed_(_isParsed), names_(_names) {}

      std::unique_ptr<clang::ASTConsumer> CreateASTConsumer(clang::CompilerInstance& _ci, llvm::StringRef) override {
        return std::make_unique<GraphConsumer>(_ci, scope_, claims_, unit_, out_, isParsed_, names_);
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
      GraphNames& names_;

     public:
      GraphFactory(const std::vector<Buffer>& _buffers, const GraphScope& _scope, GraphClaims& _claims,
                   const size_t _unit, UnitFunctions& _out, bool& _isParsed, GraphNames& _names)
          : buffers_(_buffers),
            scope_(_scope),
            claims_(_claims),
            unit_(_unit),
            out_(_out),
            isParsed_(_isParsed),
            names_(_names) {}

      std::unique_ptr<clang::FrontendAction> create() override {
        return std::make_unique<GraphAction>(scope_, claims_, unit_, out_, isParsed_, names_);
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
    // parse. _names: the names of the index of the graph
    [[nodiscard]] inline std::optional<UnitFunctions> scan_unit(const CompileDb& _db, const std::string& _unit,
                                                                const size_t _index, const std::string& _resource_dir,
                                                                const std::vector<Buffer>& _buffers,
                                                                const GraphScope& _scope, GraphClaims& _claims,
                                                                GraphNames& _names) {
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
      GraphFactory factory(_buffers, _scope, _claims, _index, out, isParsed, _names);
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
    std::unordered_map<std::string, int32_t> fileIndex;
    for (size_t k = 0; k < keys.size(); ++k) fileIndex.emplace(*keys[k], int32_t(k));
    for (size_t k = 0; k < keys.size(); ++k)
      for (const GraphFunction& f : *_g.files_.at(*keys[k]))
        if (!f.isInit_ && _g.byUsr_.try_emplace(f.usr_, int32_t(_g.nodes_.size())).second) {
          _g.nodes_.push_back(&f);
          _g.fileOf_.push_back(int32_t(k));
        }

    // moc writes the body of a signal of qt into a file of the build folder, and the scan skips it. thus a connected
    // signal of the project gets a node with no body: the calls of emit go to it, and it calls its slots
    auto signalNodes = std::make_shared<std::deque<GraphFunction>>();
    for (size_t i = 0, n = _g.nodes_.size(); i < n; ++i)
      for (const GraphConnect& c : _g.nodes_[i]->connects_) {
        if (c.signalFile_.empty() || _g.byUsr_.contains(c.signal_)) continue;
        GraphFunction s;
        s.usr_      = c.signal_;
        s.name_     = c.signalName_;
        s.file_     = c.signalFile_;
        s.first_    = c.signalLine_;
        s.last_     = c.signalLine_;
        s.isSignal_ = true;
        signalNodes->push_back(std::move(s));
        const std::string key = normalize_path(c.signalFile_);
        const int32_t file    = fileIndex.try_emplace(key, int32_t(fileIndex.size())).first->second;
        _g.byUsr_.emplace(c.signal_, int32_t(_g.nodes_.size()));
        _g.nodes_.push_back(&signalNodes->back());
        _g.fileOf_.push_back(file);
      }
    _g.signals_        = std::move(signalNodes);
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
          _g.out_[i].push_back(GraphEdge{t, c.line_, c.isInLoop_, false});
          if (!llvm::is_contained(_g.callers_[size_t(t)], int32_t(i))) _g.callers_[size_t(t)].push_back(int32_t(i));
        }
      }

    // a connected signal of the project calls its slot
    for (size_t i = 0; i < count; ++i)
      for (const GraphConnect& c : _g.nodes_[i]->connects_) {
        const auto signal = _g.byUsr_.find(c.signal_);
        const auto slot   = _g.byUsr_.find(c.slot_);
        if (signal == _g.byUsr_.end() || slot == _g.byUsr_.end() || signal->second == slot->second) continue;
        std::vector<GraphEdge>& out = _g.out_[size_t(signal->second)];
        if (std::ranges::none_of(out, [&](const GraphEdge& _e) { return _e.to_ == slot->second; }))
          out.push_back(GraphEdge{slot->second, c.line_, false, true});
        if (std::vector<int32_t>& callers = _g.callers_[size_t(slot->second)];
            !llvm::is_contained(callers, signal->second))
          callers.push_back(signal->second);
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

    // the callers that the graph cannot see, the first cause of each node: a library calls an override, qt calls a slot
    // of a signal of a library, a pointer or a std::function can call a function whose address the code uses, and qt
    // can call a slot with no known caller
    _g.unknown_.assign(count, {});
    const auto mark = [&](const int32_t _n, const char* _cause, const std::string& _via, const std::string& _file,
                          const uint32_t _line) {
      if (GraphUnknown& u = _g.unknown_[size_t(_n)]; u.cause_.empty()) u = GraphUnknown{_cause, _via, _file, _line};
    };
    for (size_t i = 0; i < count; ++i)
      if (const GraphFunction& f = *_g.nodes_[i]; !f.libraryOverride_.empty())
        mark(int32_t(i), "libraryOverride", f.libraryOverride_, f.file_, f.first_);
    for (size_t i = 0; i < count; ++i)
      for (const GraphConnect& c : _g.nodes_[i]->connects_)
        if (const auto slot = _g.byUsr_.find(c.slot_); c.signalFile_.empty() && slot != _g.byUsr_.end())
          mark(slot->second, "slot", "the signal " + c.signalName_, _g.nodes_[i]->file_, c.line_);
    for (size_t k = 0; k < keys.size(); ++k)
      for (const GraphFunction& f : *_g.files_.at(*keys[k]))
        for (const GraphRef& r : f.refs_)
          if (const auto it = _g.byUsr_.find(r.to_); it != _g.byUsr_.end())
            mark(it->second, "address", f.name_, f.file_, r.line_);
    for (size_t i = 0; i < count; ++i)
      if (const GraphFunction& f = *_g.nodes_[i]; f.isSlot_ && _g.callers_[i].empty())
        mark(int32_t(i), "slot", "a slots section", f.file_, f.first_);

    // the index of the uses: the nodes that use each variable, and the nodes with a switch on each enum
    _g.usersOf_.clear();
    _g.switchesOf_.clear();
    for (size_t i = 0; i < count; ++i) {
      for (const GraphUse& u : _g.nodes_[i]->uses_) _g.usersOf_[u.name_].push_back(int32_t(i));
      for (const GraphSwitch& s : _g.nodes_[i]->switches_)
        if (std::vector<int32_t>& list = _g.switchesOf_[s.enum_]; list.empty() || list.back() != int32_t(i))
          list.push_back(int32_t(i));
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
        std::optional<Detail::UnitFunctions> fns =
            Detail::scan_unit(_dbs[size_t(_graph.dbs_[u])], _graph.units_[u], u, _resource_dir, _buffers, _graph.scope_,
                              claims, *_graph.names_);
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

  // the calls from a frame function that give a frame path its points. the walk goes past this limit, so the reach can
  // tell that a longer frame path gives no points
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

  // the nodes in the files of the tests. a folder with no separator is a name: a folder of the path with this name. a
  // folder with a separator is a path: absolute, or relative to the project folders
  [[nodiscard]] inline std::vector<char> test_nodes(const ProjectGraph& _g, const std::vector<std::string>& _folders) {
    std::vector<char> out(_g.nodes_.size(), 0);
    std::vector<std::string> names, dirs;
    for (const std::string& f : _folders) {
      if (f.empty()) continue;
      if (f.find_first_of("/\\") == std::string::npos) {
        names.push_back(normalize_path(f));
      } else if (llvm::sys::path::is_absolute(f)) {
        dirs.push_back(normalize_path(f));
      } else {
        for (const std::string& r : _g.roots_) dirs.push_back(normalize_path(r + "/" + f));
      }
    }
    if (names.empty() && dirs.empty()) return out;
    for (size_t i = 0; i < _g.nodes_.size(); ++i) {
      const std::string key     = normalize_path(_g.nodes_[i]->file_);
      const llvm::StringRef dir = llvm::sys::path::parent_path(key);
      bool isTest = std::ranges::any_of(dirs, [&](const std::string& _d) { return Detail::is_under(key, _d); });
      for (auto it = llvm::sys::path::begin(dir), end = llvm::sys::path::end(dir); !isTest && it != end; ++it)
        isTest = llvm::is_contained(names, std::string(*it));
      out[i] = isTest ? 1 : 0;
    }
    return out;
  }  // test_nodes

  // the reach of a function in the graph: the direct callers, the transitive callers, the files of the transitive
  // callers other than the file of the function, the frame path, the callers that the graph cannot see, and the test
  // functions among the transitive callers. _tests: the nodes in the files of the tests, or empty. null if the graph
  // has no node for the function
  [[nodiscard]] inline Json reach_to_json(const ProjectGraph& _g, const FramePaths& _paths,
                                          const clang::FunctionDecl& _fn, const std::vector<char>& _tests = {}) {
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
    size_t transitive = 0, tests = 0;
    std::vector<std::string> testFiles;
    while (!todo.empty() && transitive < max_transitive_callers) {
      const int32_t at = todo.back();
      todo.pop_back();
      for (const int32_t c : _g.callers_[size_t(at)]) {
        if (transitive == max_transitive_callers || !seen.insert(c).second) continue;
        ++transitive;
        if (_g.fileOf_[size_t(c)] != _g.fileOf_[size_t(n)]) files.insert(_g.fileOf_[size_t(c)]);
        if (size_t(c) < _tests.size() && _tests[size_t(c)]) {
          ++tests;
          if (const std::string& f = _g.nodes_[size_t(c)]->file_;
              testFiles.size() < 5 && !llvm::is_contained(testFiles, f))
            testFiles.push_back(f);
        }
        todo.push_back(c);
      }
    }
    const bool isCapped = transitive == max_transitive_callers;
    JsonObject out{{"callers", int64_t(_g.callers_[size_t(n)].size())},
                   {"transitiveCallers", int64_t(transitive)},
                   {"callerFiles", int64_t(files.size())}};
    if (isCapped) out["isCapped"] = true;
    if (const auto step = _paths.steps_.find(n); step != _paths.steps_.end()) {
      // the path from the frame function to the caller before the function
      std::vector<std::string> path;
      for (int32_t at = step->second.from_; at >= 0; at = _paths.steps_.at(at).from_)
        path.push_back(_g.nodes_[size_t(at)]->name_);
      std::ranges::reverse(path);
      JsonObject frame{{"reason", _paths.frames_[size_t(step->second.frame_)].reason_},
                       {"path", JsonArray(path)},
                       {"isInLoop", step->second.isInLoop_},
                       {"calls", int64_t(step->second.depth_)}};
      if (step->second.depth_ > frame_max_depth) frame["isPastLimit"] = true;
      out["frame"] = std::move(frame);
    }
    if (const GraphUnknown& u = _g.unknown_[size_t(n)]; !u.cause_.empty())
      out["unknownCallers"] =
          JsonObject{{"cause", u.cause_}, {"via", u.via_}, {"file", u.file_}, {"line", int64_t(u.line_)}};
    if (!_tests.empty()) {
      JsonObject t{{"functions", int64_t(tests)}, {"files", JsonArray(testFiles)}};
      if (isCapped) t["isCapped"] = true;
      out["tests"] = std::move(t);
    }
    return out;
  }  // reach_to_json

  // the callers of a function up to _depth calls, the first _max callers, each with the lines of its calls, and the
  // frame paths of the function: one path from each frame function that reaches it, _maxPaths paths at most. null if
  // the graph has no node for the function
  [[nodiscard]] inline Json callers_to_json(const ProjectGraph& _g, const FramePaths& _paths,
                                            const clang::FunctionDecl& _fn, const uint32_t _depth, const size_t _max,
                                            const size_t _maxPaths = 5) {
    const auto it = _g.byUsr_.find(Detail::usr_of(Detail::pattern_of(_fn)));
    if (it == _g.byUsr_.end()) return Json(nullptr);
    const int32_t n = it->second;

    // the callers in the sequence of their depth. each caller has the function that it calls on the way
    struct Visit {
      int32_t node_   = -1;
      int32_t to_     = -1;
      uint32_t depth_ = 0;
    };
    std::vector<Visit> visits;
    std::unordered_set<int32_t> seen{n};
    std::deque<Visit> todo{Visit{n, -1, 0}};
    bool isCapped = false;
    while (!todo.empty() && !isCapped) {
      const Visit v = todo.front();
      todo.pop_front();
      if (v.depth_ >= _depth) continue;
      for (const int32_t c : _g.callers_[size_t(v.node_)]) {
        if (!seen.insert(c).second) continue;
        if (visits.size() == _max) {
          isCapped = true;
          break;
        }
        visits.push_back(Visit{c, v.node_, v.depth_ + 1});
        todo.push_back(visits.back());
      }
    }
    JsonArray callers;
    for (const Visit& v : visits) {
      const GraphFunction& f = *_g.nodes_[size_t(v.node_)];
      JsonArray lines;
      bool isConnection = false;
      for (const GraphEdge& e : _g.out_[size_t(v.node_)])
        if (e.to_ == v.to_) {
          lines.push_back(int64_t(e.line_));
          isConnection = isConnection || e.isConnection_;
        }
      JsonObject o{{"name", f.name_},
                   {"file", f.file_},
                   {"first", int64_t(f.first_)},
                   {"last", int64_t(f.last_)},
                   {"depth", int64_t(v.depth_)},
                   {"calls", _g.nodes_[size_t(v.to_)]->name_},
                   {"lines", std::move(lines)}};
      if (f.isSignal_) o["isSignal"] = true;
      if (isConnection) o["isConnection"] = true;
      callers.push_back(std::move(o));
    }

    // the frame paths: a walk up the callers to the frame functions. next gives the node toward the function
    std::unordered_map<int32_t, size_t> frameOf;
    for (size_t r = 0; r < _paths.frames_.size(); ++r) frameOf.try_emplace(_paths.frames_[r].node_, r);
    std::unordered_map<int32_t, int32_t> next{{n, -1}};
    std::deque<int32_t> up{n};
    JsonArray framePaths;
    while (!up.empty() && framePaths.size() < _maxPaths) {
      const int32_t at = up.front();
      up.pop_front();
      if (const auto f = frameOf.find(at); f != frameOf.end()) {
        std::vector<std::string> path;
        for (int32_t p = at; p >= 0; p = next.at(p)) path.push_back(_g.nodes_[size_t(p)]->name_);
        framePaths.push_back(JsonObject{{"reason", _paths.frames_[f->second].reason_},
                                        {"calls", int64_t(path.size() - 1)},
                                        {"path", JsonArray(path)}});
      }
      for (const int32_t c : _g.callers_[size_t(at)])
        if (next.try_emplace(c, at).second) up.push_back(c);
    }

    JsonObject out{{"function", _g.nodes_[size_t(n)]->name_},
                   {"callers", std::move(callers)},
                   {"framePaths", std::move(framePaths)}};
    if (isCapped) out["isCapped"] = true;
    if (const GraphUnknown& u = _g.unknown_[size_t(n)]; !u.cause_.empty())
      out["unknownCallers"] =
          JsonObject{{"cause", u.cause_}, {"via", u.via_}, {"file", u.file_}, {"line", int64_t(u.line_)}};
    return out;
  }  // callers_to_json

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
    // the size of the index of the uses, with the memory of its parts
    size_t uses = 0, switches = 0, bytes = _g.names_->get_bytes();
    for (const GraphFunction* f : _g.nodes_) {
      uses += f->uses_.size();
      switches += f->switches_.size();
      bytes += f->uses_.capacity() * sizeof(GraphUse) + f->switches_.capacity() * sizeof(GraphSwitch);
      for (const GraphSwitch& s : f->switches_) bytes += s.handled_.capacity() * sizeof(uint32_t);
    }
    for (const auto* map : {&_g.usersOf_, &_g.switchesOf_})
      for (const auto& [name, list] : *map) bytes += 48 + list.capacity() * sizeof(int32_t);
    return JsonObject{{"units", int64_t(_g.units_.size())},
                      {"scanned", int64_t(_scanned)},
                      {"isComplete", is_graph_complete(_g)},
                      {"functions", int64_t(_g.nodes_.size())},
                      {"calls", int64_t(calls)},
                      {"frames", std::move(frames)},
                      {"failed", JsonArray(_g.failed_)},
                      {"index", JsonObject{{"uses", int64_t(uses)},
                                           {"switches", int64_t(switches)},
                                           {"names", int64_t(_g.names_->get_count())},
                                           {"bytes", int64_t(bytes)}}}};
  }  // graph_to_json

}  // namespace DataFlow
