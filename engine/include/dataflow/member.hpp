#pragma once

#include <dataflow/flow.hpp>
#include <dataflow/logic.hpp>

/*
  Flow analysis of one data member of a class, a static data member or a global variable, for Flow Lens:
    > the member: a request finds it at a position, or by the scope and the name. the scope is a class, or a
      namespace for a global variable
    > refs: the declaration, the initializers of the constructors and each access in the functions of the translation
      unit: the functions of the main file, and the class with its member functions and friends in the headers.
      a function in a system header is not a part of the trace
    > roles: as in the flow of a function. a call of a non-const member function on the member is a possible write
    > edges: reaching definitions in each body, between the accesses through the same object
    > threads: a body that runs on a different thread: a lambda or a function that a thread, an async function, a job
      queue or QThread::run runs. a lambda in such a body and a function of the trace that it calls run on the same
      thread. a thread of a different source file comes in through the entries of the options
    > locks: the lock guards, the lock() calls and std::lock that hold a mutex at the access, until an unlock(). the
      body of a lambda gets the locks around the lambda only if the call runs the lambda before it returns, for
      example the predicate of a wait
    > runs: the threads analysis of the translation unit gives each access its threads, the locks on the way to it and
      the threads that it is in sequence with: joins, starts and checks of the handles. a function can run on more
      than one thread
  The other source files of the class are not a part of the translation unit. The extension parses them, and it gives
  them the threads that call into them.
*/

namespace DataFlow {

  // a function or a lambda with an access, or the function around such a lambda
  struct MemberBody {
    const clang::FunctionDecl* fn_   = nullptr;  // the function, or the call operator of the lambda
    const clang::LambdaExpr* lambda_ = nullptr;
    int32_t outer_                   = -1;       // the body around a lambda
    int32_t thread_                  = -1;       // the thread start that runs the body
    const clang::CallExpr* call_     = nullptr;  // the call in a body on the thread that runs this function on it
  };  // MemberBody

  // a statement that starts a thread, the run function of a class derived from QThread, or a thread of a different
  // source file that calls a function of this unit
  struct ThreadStart {
    const clang::Stmt* at_   = nullptr;  // null for QThread::run and for a thread of a different source file
    const clang::Decl* decl_ = nullptr;  // the run function of QThread::run, or the function that the thread calls
    std::string via_;                    // for example std::thread, std::async or QThread::run
    bool isRepeated_ = false;            // a loop starts it, so more than one thread can run the body at the same time
    std::string file_;                   // the place of a thread of a different source file
    uint32_t line_ = 0;
    std::vector<std::string> calls_;  // the functions of other source files that the thread calls
  };  // ThreadStart

  // a thread context of an access from the threads analysis: the thread, the locks on the way to the access, and the
  // threads that the access is in sequence with
  struct MemberRun {
    int32_t thread_ = -1;  // -1 for the caller thread
    std::vector<std::string> locks_;
    std::vector<int32_t> ordered_;
  };  // MemberRun

  struct MemberRef {
    const clang::Expr* expr_ = nullptr;  // the member expression. null for the declaration and an initializer
    const clang::Stmt* at_   = nullptr;  // the statement where a write takes effect
    const clang::CXXCtorInitializer* init_ = nullptr;  // an initializer of a constructor
    clang::SourceLocation loc_;
    int32_t body_    = -1;  // -1 for the declaration
    Role role_       = Role::READ;
    bool isAlsoRead_ = false;  // x_ += 1 reads x_ before it writes x_
    bool isThis_     = false;  // an access through this, or through a member of this
    bool isWhole_    = false;  // a change of the whole object, for example an assignment of the object
    std::string object_;       // the text of the object if it is not this, for example _o or charge
    std::vector<std::string> locks_;
    std::vector<MemberRun> runs_;  // empty if the threads analysis has no data for the access
  };  // MemberRef

  struct MemberModel {
    const clang::ValueDecl* decl_ = nullptr;  // a FieldDecl, or the VarDecl of a static data member or a global
    std::vector<MemberBody> bodies_;
    std::vector<ThreadStart> threads_;
    std::vector<MemberRef> refs_;
    std::vector<std::pair<int32_t, int32_t>> edges_;  // definition ref, use ref
  };  // MemberModel

  // a thread of a different source file that calls a function of this translation unit
  struct ThreadEntry {
    std::string function_;  // the qualified name of the function
    std::string via_;
    std::string file_;  // the place of the thread start
    uint32_t line_   = 0;
    bool isRepeated_ = false;
  };  // ThreadEntry

  struct MemberOptions {
    std::vector<std::string> async_functions_;  // functions that run a callable on a different thread
    std::vector<std::string> read_functions_;   // functions that only read their arguments and their object
    std::vector<ThreadEntry> entries_;

    // the result of the check for a job queue, for each member function: 0 for no queue, 1 for a queue with one worker
    // thread, 2 for a queue with more than one worker thread. one request fills it
    mutable std::shared_ptr<std::unordered_map<const clang::CXXMethodDecl*, int32_t>> queues_;
  };  // MemberOptions

  namespace Detail {
    // true if a namespace around the declaration is std, for example std::ranges
    [[nodiscard]] inline bool is_in_std(const clang::Decl* _d) {
      for (const clang::DeclContext* dc = _d ? _d->getDeclContext() : nullptr; dc; dc = dc->getParent())
        if (dc->isStdNamespace()) return true;
      return false;
    }  // is_in_std

    [[nodiscard]] inline const clang::CXXRecordDecl* record_of(const clang::QualType _t) {
      return _t.isNull() ? nullptr : _t->getAsCXXRecordDecl();
    }  // record_of

    // the name of a thread type: std::thread, std::jthread, llvm::thread or boost::thread. empty for other types
    [[nodiscard]] inline std::string thread_type_name(const clang::QualType _t) {
      const clang::CXXRecordDecl* rd = record_of(_t);
      if (!rd || !rd->getIdentifier()) return {};
      if (is_in_std(rd) && llvm::is_contained({"thread", "jthread"}, rd->getName()))
        return "std::" + rd->getName().str();
      const std::string name = rd->getQualifiedNameAsString();
      return name == "llvm::thread" || name == "boost::thread" ? name : std::string();
    }  // thread_type_name

    // the thread or the async function that a call or a construction starts, for example std::thread or std::async.
    // empty if it starts none. start_name also finds the job queues
    [[nodiscard]] inline std::string direct_start_name(const clang::Expr* _e, const MemberOptions& _opts) {
      if (const auto* c = llvm::dyn_cast_or_null<clang::CXXConstructExpr>(_e)) return thread_type_name(c->getType());
      const auto* call = llvm::dyn_cast_or_null<clang::CallExpr>(_e);
      if (!call) return {};
      const clang::FunctionDecl* fn = call->getDirectCallee();
      if (name_in(fn, _opts.async_functions_) || name_in(fn, {"QThread::create"}))
        return fn->getQualifiedNameAsString();

      // emplace_back on a container of threads constructs a thread with the arguments
      const auto* member = llvm::dyn_cast<clang::CXXMemberCallExpr>(call);
      if (!member || !fn || !fn->getIdentifier() || !fn->getName().starts_with("emplace")) return {};
      const auto* spec = llvm::dyn_cast_or_null<clang::ClassTemplateSpecializationDecl>(member->getRecordDecl());
      if (!spec || spec->getTemplateArgs().size() == 0) return {};
      const clang::TemplateArgument& arg = spec->getTemplateArgs()[0];
      return arg.getKind() == clang::TemplateArgument::Type ? thread_type_name(arg.getAsType()) : std::string();
    }  // direct_start_name

    // the function of an argument, as in std::thread(&Worker::run, this). null for other arguments
    [[nodiscard]] inline const clang::FunctionDecl* function_argument(const clang::Expr* _arg) {
      const clang::Expr* e = _arg ? _arg->IgnoreImplicit()->IgnoreParenImpCasts() : nullptr;
      if (const auto* u = llvm::dyn_cast_or_null<clang::UnaryOperator>(e); u && u->getOpcode() == clang::UO_AddrOf)
        e = u->getSubExpr()->IgnoreParenImpCasts();
      const auto* ref = llvm::dyn_cast_or_null<clang::DeclRefExpr>(e);
      return ref ? llvm::dyn_cast<clang::FunctionDecl>(ref->getDecl()) : nullptr;
    }  // function_argument

    // the call or the construction that gets the lambda as an argument, through conversions, for example to
    // std::function. null if there is none
    [[nodiscard]] inline const clang::Expr* call_of_lambda(const clang::LambdaExpr* _l, const clang::ParentMap& _pm) {
      const clang::Stmt* child = _l;
      for (const clang::Stmt* p = _pm.getParent(child); p; child = p, p = _pm.getParent(p)) {
        if (llvm::isa<clang::ImplicitCastExpr, clang::MaterializeTemporaryExpr, clang::CXXBindTemporaryExpr,
                      clang::ParenExpr, clang::ExprWithCleanups, clang::CXXFunctionalCastExpr>(p))
          continue;
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(p)) {
          if (!llvm::is_contained(c->arguments(), child)) return nullptr;
          if (!thread_type_name(c->getType()).empty() || c->getNumArgs() != 1) return c;
          continue;  // a conversion
        }
        if (const auto* call = llvm::dyn_cast<clang::CallExpr>(p))
          return llvm::is_contained(call->arguments(), child) ? call : nullptr;
        return nullptr;
      }
      return nullptr;
    }  // call_of_lambda

    // true if the call that gets the lambda runs it before the call returns: the predicate of a wait of a condition
    // variable, or a standard algorithm
    [[nodiscard]] inline bool is_synchronous(const clang::LambdaExpr* _l, const clang::ParentMap& _pm) {
      static const std::vector<llvm::StringRef> algorithms = {
          "all_of",      "any_of",      "none_of",       "for_each",       "for_each_n",   "find_if",
          "find_if_not", "count_if",    "remove_if",     "replace_if",     "copy_if",      "transform",
          "accumulate",  "reduce",      "sort",          "stable_sort",    "partial_sort", "nth_element",
          "partition",   "min_element", "max_element",   "minmax_element", "is_sorted",    "lower_bound",
          "upper_bound", "equal_range", "binary_search", "adjacent_find",  "generate",     "generate_n",
          "unique",      "erase_if",    "invoke",        "apply",          "visit",        "call_once"};
      const auto* call = llvm::dyn_cast_or_null<clang::CallExpr>(call_of_lambda(_l, _pm));
      if (!call) return false;

      // a niebloid, for example std::ranges::for_each, is an object with a call operator
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(call);
          op && op->getOperator() == clang::OO_Call) {
        const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(op->getArg(0)->IgnoreParenImpCasts());
        return ref && ref->getDecl()->getIdentifier() && is_in_std(ref->getDecl()) &&
               llvm::is_contained(algorithms, ref->getDecl()->getName());
      }
      const clang::FunctionDecl* fn = call->getDirectCallee();
      if (!fn || !fn->getIdentifier()) return false;
      if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(fn); m && fn->getName().starts_with("wait"))
        return m->getParent()->getIdentifier() &&
               llvm::is_contained({"condition_variable", "condition_variable_any"}, m->getParent()->getName());
      return is_in_std(fn) && llvm::is_contained(algorithms, fn->getName());
    }  // is_synchronous

    // true if a loop around the statement in the body runs it more than one time
    [[nodiscard]] inline bool is_in_loop(const clang::Stmt* _s, const clang::ParentMap& _pm) {
      for (const clang::Stmt* p = _pm.getParent(_s); p; p = _pm.getParent(p)) {
        if (llvm::isa<clang::ForStmt, clang::WhileStmt, clang::DoStmt, clang::CXXForRangeStmt>(p)) return true;
        if (llvm::isa<clang::LambdaExpr>(p)) return false;
      }
      return false;
    }  // is_in_loop

    //----------------------------------
    // Job queues

    // true for the type of a parameter that can be a callable: a template parameter, std::function, or a class with a
    // call operator, for example a lambda
    [[nodiscard]] inline bool is_callable_type(clang::QualType _t) {
      _t = _t.getNonReferenceType();
      if (_t->isDependentType()) return true;
      const clang::CXXRecordDecl* rd = record_of(_t);
      if (!rd || !rd->hasDefinition()) return false;
      if (rd->isLambda()) return true;
      return is_in_std(rd) && rd->getIdentifier() &&
             llvm::is_contained({"function", "move_only_function", "copyable_function", "packaged_task"},
                                rd->getName());
    }  // is_callable_type

    // finds the data member that a member function puts a callable parameter into: a call of push, emplace or insert
    // on the member, with the parameter as an argument, also through std::move, std::forward or a conversion
    class QueueFinder : public clang::RecursiveASTVisitor<QueueFinder> {
      const clang::CXXMethodDecl& fn_;

     public:
      const clang::FieldDecl* out_ = nullptr;

      explicit QueueFinder(const clang::CXXMethodDecl& _fn) : fn_(_fn) {}

      bool VisitCXXMemberCallExpr(clang::CXXMemberCallExpr* _c) {
        const clang::CXXMethodDecl* md = _c->getMethodDecl();
        if (!md || !md->getIdentifier() ||
            !llvm::is_contained(
                {"push", "push_back", "push_front", "emplace", "emplace_back", "emplace_front", "insert"},
                md->getName()))
          return true;
        const auto* m = llvm::dyn_cast<clang::MemberExpr>(_c->getImplicitObjectArgument()->IgnoreParenImpCasts());
        const auto* f = m ? llvm::dyn_cast<clang::FieldDecl>(m->getMemberDecl()) : nullptr;
        if (!f || f->getParent() != fn_.getParent()) return true;
        if (llvm::any_of(_c->arguments(), [&](const clang::Expr* _a) { return is_callable_param(_a); })) out_ = f;
        return !out_;
      }  // VisitCXXMemberCallExpr

     private:
      [[nodiscard]] bool is_callable_param(const clang::Expr* _a) const {
        const clang::Expr* e = _a;
        for (int32_t i = 0; e && i < 4; ++i) {
          e = e->IgnoreImplicit()->IgnoreParenImpCasts();
          if (const auto* call = llvm::dyn_cast<clang::CallExpr>(e);
              call && call->getNumArgs() == 1 && call->getDirectCallee() && is_in_std(call->getDirectCallee()) &&
              call->getDirectCallee()->getIdentifier() &&
              llvm::is_contained({"move", "forward"}, call->getDirectCallee()->getName()))
            e = call->getArg(0);
          else if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(e); c && c->getNumArgs() == 1)
            e = c->getArg(0);
          else
            break;
        }
        const auto* ref = e ? llvm::dyn_cast<clang::DeclRefExpr>(e->IgnoreImplicit()->IgnoreParenImpCasts()) : nullptr;
        const auto* p   = ref ? llvm::dyn_cast<clang::ParmVarDecl>(ref->getDecl()) : nullptr;
        return p && p->getDeclContext() == static_cast<const clang::DeclContext*>(&fn_) &&
               is_callable_type(p->getType());
      }  // is_callable_param

    };  // QueueFinder

    // collects the lambdas of a body, and finds the uses of a data member
    class LambdaFinder : public clang::RecursiveASTVisitor<LambdaFinder> {
     public:
      std::vector<const clang::LambdaExpr*> out_;

      bool VisitLambdaExpr(clang::LambdaExpr* _e) {
        out_.push_back(_e);
        return true;
      }
    };  // LambdaFinder

    class FieldUseFinder : public clang::RecursiveASTVisitor<FieldUseFinder> {
      const clang::FieldDecl& field_;

     public:
      bool isUsed_ = false;

      explicit FieldUseFinder(const clang::FieldDecl& _field) : field_(_field) {}

      bool VisitMemberExpr(clang::MemberExpr* _e) {
        isUsed_ = _e->getMemberDecl() == &field_;
        return !isUsed_;
      }
    };  // FieldUseFinder

    // the worker threads of a job queue: 0 if no thread start in a member function of the class runs a lambda that
    // uses the container, 1 for one such start, 2 for a start in a loop or for more than one start
    [[nodiscard]] inline int32_t queue_workers(const clang::CXXRecordDecl& _rd, const clang::FieldDecl& _queue,
                                               const MemberOptions& _opts) {
      int32_t out = 0;
      for (const clang::CXXMethodDecl* m : _rd.methods()) {
        const clang::FunctionDecl* def = nullptr;
        if (!m->isDefined(def) || !def->getBody()) continue;
        clang::ParentMap pm(def->getBody());
        LambdaFinder lambdas;
        lambdas.TraverseStmt(def->getBody());
        if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(def))
          for (const clang::CXXCtorInitializer* init : ctor->inits())
            if (init->isWritten() && init->getInit()) {
              pm.addStmt(init->getInit());
              lambdas.TraverseStmt(init->getInit());
            }
        for (const clang::LambdaExpr* l : lambdas.out_) {
          const clang::Expr* start = call_of_lambda(l, pm);
          if (direct_start_name(start, _opts).empty()) continue;
          FieldUseFinder uses(_queue);
          uses.TraverseStmt(l->getBody());
          if (uses.isUsed_) out += is_in_loop(start, pm) ? 2 : 1;
        }
      }
      return std::min(out, 2);
    }  // queue_workers

    // the worker threads of the job queue of a call: a call of a member function that puts its callable argument into
    // a container member of its class, while a thread of the class uses that container, for example
    // WorkerPool::post. the callable runs later on a worker thread. 0 for a call that is not such a post
    [[nodiscard]] inline int32_t queue_post_workers(const clang::Expr* _e, const MemberOptions& _opts) {
      const auto* call               = llvm::dyn_cast_or_null<clang::CXXMemberCallExpr>(_e);
      const clang::CXXMethodDecl* md = call ? call->getMethodDecl() : nullptr;
      if (!md ||
          llvm::none_of(md->parameters(), [](const clang::ParmVarDecl* _p) { return is_callable_type(_p->getType()); }))
        return 0;
      if (md->getASTContext().getSourceManager().isInSystemHeader(md->getLocation())) return 0;
      if (!_opts.queues_) _opts.queues_ = std::make_shared<std::unordered_map<const clang::CXXMethodDecl*, int32_t>>();
      if (const auto it = _opts.queues_->find(md); it != _opts.queues_->end()) return it->second;

      int32_t out                    = 0;
      const clang::FunctionDecl* def = nullptr;
      if (md->isDefined(def) && def->getBody()) {
        QueueFinder finder(*llvm::cast<clang::CXXMethodDecl>(def));
        finder.TraverseStmt(def->getBody());
        if (finder.out_) out = queue_workers(*md->getParent(), *finder.out_, _opts);
      }
      (*_opts.queues_)[md] = out;
      return out;
    }  // queue_post_workers

    // the thread or the async function that a call or a construction starts, for example std::thread, std::async or
    // the post function of a job queue. empty if it starts none
    [[nodiscard]] inline std::string start_name(const clang::Expr* _e, const MemberOptions& _opts) {
      std::string out = direct_start_name(_e, _opts);
      if (out.empty() && queue_post_workers(_e, _opts) > 0)
        out = llvm::cast<clang::CXXMemberCallExpr>(_e)->getMethodDecl()->getQualifiedNameAsString();
      return out;
    }  // start_name

    // true if more than one thread of a start can run at the same time: a loop runs the start, or a job queue has more
    // than one worker thread
    [[nodiscard]] inline bool is_repeated_start(const clang::Expr* _e, const clang::ParentMap& _pm,
                                                const MemberOptions& _opts) {
      return is_in_loop(_e, _pm) || queue_post_workers(_e, _opts) == 2;
    }  // is_repeated_start

    [[nodiscard]] inline bool derives_from(const clang::CXXRecordDecl* _rd, const llvm::StringRef _name,
                                           const int32_t _depth = 0) {
      if (!_rd || !_rd->hasDefinition() || _depth > 16) return false;
      for (const clang::CXXBaseSpecifier& b : _rd->getDefinition()->bases()) {
        const clang::CXXRecordDecl* base = record_of(b.getType());
        if (base && ((base->getIdentifier() && base->getName() == _name) || derives_from(base, _name, _depth + 1)))
          return true;
      }
      return false;
    }  // derives_from

    // true for run() of a class derived from QThread. it runs on the thread of the object
    [[nodiscard]] inline bool is_qthread_run(const clang::FunctionDecl* _fn) {
      const auto* m = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(_fn);
      return m && m->getIdentifier() && m->getName() == "run" && m->getNumParams() == 0 &&
             derives_from(m->getParent(), "QThread");
    }  // is_qthread_run

    [[nodiscard]] inline bool is_guard_type(const clang::QualType _t) {
      const clang::CXXRecordDecl* rd = record_of(_t);
      return rd && rd->getIdentifier() &&
             llvm::is_contained({"lock_guard", "unique_lock", "scoped_lock", "shared_lock", "QMutexLocker",
                                 "QReadLocker", "QWriteLocker", "MutexLock", "ReaderMutexLock", "WriterMutexLock"},
                                rd->getName());
    }  // is_guard_type

    // true for a mutex type, for example std::mutex or QMutex
    [[nodiscard]] inline bool is_mutex_type(const clang::QualType _t) {
      const clang::CXXRecordDecl* rd = record_of(_t.getNonReferenceType());
      if (!rd || !rd->getIdentifier()) return false;
      if (is_in_std(rd))
        return llvm::is_contained(
            {"mutex", "recursive_mutex", "timed_mutex", "recursive_timed_mutex", "shared_mutex", "shared_timed_mutex"},
            rd->getName());
      return llvm::is_contained({"QMutex", "QRecursiveMutex", "QReadWriteLock"}, rd->getName());
    }  // is_mutex_type

    // a statement takes or releases mutexes. a guard releases its mutexes at the end of its block
    struct LockAction {
      bool isTake_ = true;
      std::vector<const clang::Expr*> mutexes_;
      bool isGuard_ = false;  // a guard, or lock() and unlock() of a guard
    };  // LockAction

    using guards_t = std::unordered_map<const clang::VarDecl*, std::vector<const clang::Expr*>>;

    inline constexpr int32_t lock_max_depth = 2;  // the calls into functions that take or release mutexes

    // the construction of a guard, also in a cast as in auto lock = std::unique_lock(m)
    [[nodiscard]] inline const clang::CXXConstructExpr* guard_construction(const clang::Expr* _e) {
      const clang::Expr* e = _e ? _e->IgnoreImplicit() : nullptr;
      if (const auto* cast = llvm::dyn_cast_or_null<clang::CXXFunctionalCastExpr>(e))
        e = cast->getSubExpr()->IgnoreImplicit();
      return llvm::dyn_cast_or_null<clang::CXXConstructExpr>(e);
    }  // guard_construction

    // the mutexes of the construction of a guard, and true if it has std::defer_lock
    [[nodiscard]] inline std::pair<std::vector<const clang::Expr*>, bool> guard_mutexes(
        const clang::CXXConstructExpr& _c) {
      std::pair<std::vector<const clang::Expr*>, bool> out;
      for (const clang::Expr* a : _c.arguments()) {
        if (llvm::isa<clang::CXXDefaultArgExpr>(a)) continue;
        const clang::CXXRecordDecl* rd = record_of(a->getType());
        const llvm::StringRef type     = rd && rd->getIdentifier() ? rd->getName() : "";
        if (type == "defer_lock_t") out.second = true;
        if (type.ends_with("_lock_t") || type == "duration" || type == "time_point") continue;  // a tag or a time
        out.first.push_back(a);
      }
      return out;
    }  // guard_mutexes

    // the function of a call whose mutexes count in the caller: a function of the user with a body, called on this or
    // with no object. on a different object, the mutexes of its body are not the mutexes of the caller
    [[nodiscard]] inline const clang::FunctionDecl* lock_callee(const clang::CallExpr& _call) {
      if (llvm::isa<clang::CXXOperatorCallExpr>(_call)) return nullptr;
      const clang::FunctionDecl* fn  = _call.getDirectCallee();
      const clang::FunctionDecl* def = fn ? fn->getDefinition() : nullptr;
      if (!def || !def->hasBody() || is_in_std(def) ||
          def->getASTContext().getSourceManager().isInSystemHeader(def->getLocation()))
        return nullptr;
      if (const auto* m = llvm::dyn_cast<clang::CXXMemberCallExpr>(&_call)) {
        const clang::Expr* object = m->getImplicitObjectArgument();
        if (!object || !llvm::isa<clang::CXXThisExpr>(object->IgnoreParenImpCasts())) return nullptr;
      }
      return def;
    }  // lock_callee

    // a mutex of the body of a called function in the terms of the caller. a parameter becomes its argument. a data
    // member of this and a global variable stay the same. nullptr for a local variable of the function
    [[nodiscard]] inline const clang::Expr* caller_mutex(const clang::Expr* _m, const clang::CallExpr& _call) {
      const clang::Expr* e = _m->IgnoreParenImpCasts();
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(e); u && u->getOpcode() == clang::UO_AddrOf)
        e = u->getSubExpr()->IgnoreParenImpCasts();  // &m, as for QMutexLocker
      const clang::Expr* root = e;
      while (const auto* me = llvm::dyn_cast<clang::MemberExpr>(root)) root = me->getBase()->IgnoreParenImpCasts();
      if (llvm::isa<clang::CXXThisExpr>(root)) return _m;
      const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(root);
      if (!ref) return nullptr;
      if (const auto* p = llvm::dyn_cast<clang::ParmVarDecl>(ref->getDecl()); p && root == e) {
        const uint32_t i = p->getFunctionScopeIndex();
        return i < _call.getNumArgs() ? _call.getArg(i) : nullptr;
      }
      const auto* v = llvm::dyn_cast<clang::VarDecl>(ref->getDecl());
      return v && v->hasGlobalStorage() ? _m : nullptr;
    }  // caller_mutex

    inline void add_lock_actions(const clang::Stmt* _s, guards_t& _guards, std::vector<LockAction>& _out,
                                 int32_t _depth = 0);

    // the mutexes of the guard that a function returns, in the terms of the caller
    [[nodiscard]] inline std::pair<std::vector<const clang::Expr*>, bool> returned_guard(const clang::CallExpr& _call) {
      const clang::FunctionDecl* fn = lock_callee(_call);
      if (!fn) return {};
      const clang::ReturnStmt* ret = nullptr;
      std::vector<const clang::Stmt*> stack{fn->getBody()};
      while (!stack.empty() && !ret) {
        const clang::Stmt* s = stack.back();
        stack.pop_back();
        if (!s || llvm::isa<clang::LambdaExpr>(s)) continue;
        if (const auto* r = llvm::dyn_cast<clang::ReturnStmt>(s)) ret = r;
        for (const clang::Stmt* c : s->children()) stack.push_back(c);
      }
      const clang::CXXConstructExpr* c = ret ? guard_construction(ret->getRetValue()) : nullptr;
      if (!c) return {};
      auto [mutexes, isDeferred] = guard_mutexes(*c);
      std::vector<const clang::Expr*> out;
      for (const clang::Expr* m : mutexes) {
        const clang::Expr* mapped = caller_mutex(m, _call);
        if (!mapped) return {};
        out.push_back(mapped);
      }
      return {std::move(out), isDeferred};
    }  // returned_guard

    // the lock actions of the bodies of called functions for one analysis, by the function and the depth of its body.
    // the pointers of the AST stay valid while the analysis runs
    struct LockCache {
      std::map<std::pair<const clang::FunctionDecl*, int32_t>, std::vector<LockAction>> calls_;
    };  // LockCache

    inline thread_local LockCache* lock_cache = nullptr;

    // the cache of the lock actions of the calls while the scope lives, for example during one analysis
    class LockCacheScope {
      LockCache cache_;
      LockCache* outer_ = nullptr;

     public:
      LockCacheScope() : outer_(lock_cache) { lock_cache = &cache_; }
      ~LockCacheScope() { lock_cache = outer_; }
      LockCacheScope(const LockCacheScope&)            = delete;
      LockCacheScope& operator=(const LockCacheScope&) = delete;
    };  // LockCacheScope

    // the lock actions of the body of a function in its own terms: mutex.lock(), mutex.unlock() and std::lock, also in
    // the functions that it calls. its guards release their mutexes at its end
    [[nodiscard]] inline std::vector<LockAction> body_lock_actions(const clang::FunctionDecl& _fn,
                                                                   const int32_t _depth) {
      std::vector<LockAction> out;
      const auto* body = llvm::dyn_cast<clang::CompoundStmt>(_fn.getBody());
      if (!body) return out;
      guards_t guards;
      for (const clang::Stmt* s : body->body()) add_lock_actions(s, guards, out, _depth);
      std::erase_if(out, [](const LockAction& _a) { return _a.isGuard_; });
      return out;
    }  // body_lock_actions

    // the lock actions that a call leaves in the caller, in the terms of the caller
    inline void add_call_lock_actions(const clang::CallExpr& _call, std::vector<LockAction>& _out,
                                      const int32_t _depth) {
      const clang::FunctionDecl* fn = _depth < lock_max_depth ? lock_callee(_call) : nullptr;
      if (!fn) return;
      std::vector<LockAction> local;
      const std::vector<LockAction>* inner = &local;
      if (lock_cache) {
        const std::pair<const clang::FunctionDecl*, int32_t> key{fn, _depth + 1};
        auto it = lock_cache->calls_.find(key);
        if (it == lock_cache->calls_.end())
          it = lock_cache->calls_.emplace(key, body_lock_actions(*fn, _depth + 1)).first;
        inner = &it->second;
      } else {
        local = body_lock_actions(*fn, _depth + 1);
      }
      for (const LockAction& a : *inner) {
        LockAction mapped{a.isTake_, {}, false};
        for (const clang::Expr* m : a.mutexes_)
          if (const clang::Expr* c = caller_mutex(m, _call)) mapped.mutexes_.push_back(c);
        if (!mapped.mutexes_.empty()) _out.push_back(std::move(mapped));
      }
    }  // add_call_lock_actions

    // the lock actions of a statement of a block. a lock guard takes its mutexes, unless it has std::defer_lock. a
    // guard that a function returns takes the mutexes of the guard of its return. mutex.lock(), guard.lock() and
    // std::lock(a, b) take, and unlock() releases. a call of a function on this, or with no object, has the actions of
    // its body. _guards keeps the mutexes of each guard of the block, for a later guard.unlock() or guard.lock()
    inline void add_lock_actions(const clang::Stmt* _s, guards_t& _guards, std::vector<LockAction>& _out,
                                 const int32_t _depth) {
      if (const auto* ds = llvm::dyn_cast_or_null<clang::DeclStmt>(_s)) {
        for (const clang::Decl* d : ds->decls()) {
          const auto* v = llvm::dyn_cast<clang::VarDecl>(d);
          if (!v || !v->getInit() || !is_guard_type(v->getType())) continue;
          std::pair<std::vector<const clang::Expr*>, bool> guard;
          if (const clang::CXXConstructExpr* c = guard_construction(v->getInit()))
            guard = guard_mutexes(*c);
          else if (const auto* call = llvm::dyn_cast<clang::CallExpr>(v->getInit()->IgnoreImplicit()))
            guard = returned_guard(*call);
          auto& [mutexes, isDeferred] = guard;
          _guards[v]                  = mutexes;
          if (!isDeferred && !mutexes.empty()) _out.push_back(LockAction{true, std::move(mutexes), true});
        }
        return;
      }
      const auto* e = llvm::dyn_cast_or_null<clang::Expr>(_s);
      if (!e) return;
      e = e->IgnoreImplicit();
      if (const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(e)) {
        const clang::CXXMethodDecl* md = call->getMethodDecl();
        const llvm::StringRef name     = md && md->getIdentifier() ? md->getName() : "";
        const bool isTake              = name == "lock" || name == "lock_shared";
        if (!isTake && name != "unlock" && name != "unlock_shared") return add_call_lock_actions(*call, _out, _depth);
        const clang::Expr* object = call->getImplicitObjectArgument()->IgnoreParenImpCasts();
        if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(object))
          if (const auto it = _guards.find(llvm::dyn_cast<clang::VarDecl>(ref->getDecl())); it != _guards.end()) {
            _out.push_back(LockAction{isTake, it->second, true});
            return;
          }
        if (is_mutex_type(object->getType())) _out.push_back(LockAction{isTake, {object}});
        return;
      }
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(e)) {
        const clang::FunctionDecl* fn = call->getDirectCallee();
        if (fn && fn->getIdentifier() && fn->getName() == "lock" && is_in_std(fn))
          _out.push_back(LockAction{true, std::vector<const clang::Expr*>(call->arg_begin(), call->arg_end())});
        else
          add_call_lock_actions(*call, _out, _depth);
      }
    }  // add_lock_actions

    // the mutexes that a statement holds: the lock actions of the statements before it in each block around it, from
    // the outermost block. _same tells if two expressions name the same mutex, for an unlock(). the walk goes out of
    // the body of a lambda only if the call runs the lambda before it returns. _isAtEnd: _s is a block, and the
    // mutexes are the mutexes at its end, after the lock actions of all its statements
    template <class Same>
    [[nodiscard]] std::vector<const clang::Expr*> held_mutexes(const clang::Stmt* _s, const clang::ParentMap& _pm,
                                                               Same&& _same, const bool _isAtEnd = false) {
      std::vector<std::pair<const clang::Stmt*, const clang::Stmt*>> chain;  // a statement and its child on the way
      const clang::Stmt* child = _s;
      for (const clang::Stmt* p = _pm.getParent(child); p; child = p, p = _pm.getParent(p)) {
        if (const auto* l = llvm::dyn_cast<clang::LambdaExpr>(p); l && child == l->getBody() && !is_synchronous(l, _pm))
          break;
        chain.emplace_back(p, child);
      }

      std::vector<const clang::Expr*> out;
      std::unordered_map<const clang::VarDecl*, std::vector<const clang::Expr*>> guards;
      std::vector<LockAction> actions;
      const auto apply = [&](const clang::Stmt* _x) -> void {
        actions.clear();
        add_lock_actions(_x, guards, actions);
        for (const LockAction& a : actions)
          for (const clang::Expr* m : a.mutexes_) {
            if (a.isTake_)
              out.push_back(m);
            else
              std::erase_if(out, [&](const clang::Expr* _held) { return _same(_held, m); });
          }
      };
      for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
        const auto [p, c] = *it;
        if (const auto* cs = llvm::dyn_cast<clang::CompoundStmt>(p)) {
          for (const clang::Stmt* s : cs->body()) {
            if (s == c) break;
            apply(s);
          }
        } else if (const auto* s = llvm::dyn_cast<clang::IfStmt>(p)) {
          if (s->getInit() && s->getInit() != c) apply(s->getInit());
        } else if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(p)) {
          if (s->getInit() && s->getInit() != c) apply(s->getInit());
        }
      }
      if (const auto* cs = llvm::dyn_cast<clang::CompoundStmt>(_s); cs && _isAtEnd)
        for (const clang::Stmt* s : cs->body()) apply(s);
      return out;
    }  // held_mutexes

    // the text of a mutex, with no & and no this->
    [[nodiscard]] inline std::string mutex_text(const clang::Expr* _m, const clang::ASTContext& _ctx) {
      std::string text = short_text(_ctx, _m->getSourceRange());
      if (text.starts_with("&")) text.erase(0, 1);
      if (text.starts_with("this->")) text.erase(0, 6);
      return text;
    }  // mutex_text

    // the texts of the mutexes that a statement holds. _isAtEnd: the mutexes at the end of the block _s
    [[nodiscard]] inline std::vector<std::string> locks_at(const clang::Stmt* _s, const clang::ParentMap& _pm,
                                                           const clang::ASTContext& _ctx, const bool _isAtEnd = false) {
      std::vector<std::string> out;
      const auto same = [&](const clang::Expr* _a, const clang::Expr* _b) {
        return mutex_text(_a, _ctx) == mutex_text(_b, _ctx);
      };
      for (const clang::Expr* m : held_mutexes(_s, _pm, same, _isAtEnd))
        if (std::string text = mutex_text(m, _ctx); !text.empty()) out.push_back(std::move(text));
      std::ranges::sort(out);
      out.erase(std::unique(out.begin(), out.end()), out.end());
      return out;
    }  // locks_at

    // true for a std::atomic or a Qt atomic type. an atomic member needs no lock
    [[nodiscard]] inline bool is_atomic_type(const clang::QualType _t) {
      const clang::CXXRecordDecl* rd = record_of(_t);
      if (!rd || !rd->getIdentifier()) return false;
      if (is_in_std(rd)) return llvm::is_contained({"atomic", "atomic_flag", "atomic_ref"}, rd->getName());
      return llvm::is_contained({"QAtomicInt", "QAtomicInteger", "QAtomicPointer"}, rd->getName());
    }  // is_atomic_type

    // true for a mutex, a condition variable or a different object that threads use to synchronize. threads can use
    // it at the same time
    [[nodiscard]] inline bool is_sync_type(const clang::QualType _t) {
      const clang::CXXRecordDecl* rd = record_of(_t);
      if (!rd || !rd->getIdentifier()) return false;
      if (is_in_std(rd))
        return llvm::is_contained(
            {"mutex", "recursive_mutex", "timed_mutex", "recursive_timed_mutex", "shared_mutex", "shared_timed_mutex",
             "condition_variable", "condition_variable_any", "counting_semaphore", "latch", "barrier", "once_flag"},
            rd->getName());
      return llvm::is_contained({"QMutex", "QRecursiveMutex", "QReadWriteLock", "QWaitCondition", "QSemaphore"},
                                rd->getName());
    }  // is_sync_type

    //----------------------------------
    // Visitors

    // collects the calls in a body. the body of a lambda in it is a body of its own
    class CallFinder : public clang::RecursiveASTVisitor<CallFinder> {
     public:
      std::vector<const clang::CallExpr*> out_;

      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        for (clang::Expr* init : _e->capture_inits())
          if (init && !TraverseStmt(init)) return false;
        return true;
      }

      bool VisitCallExpr(clang::CallExpr* _e) {
        out_.push_back(_e);
        return true;
      }
    };  // CallFinder

    // the names and the data members in a body that can be the object of a group of accesses. a lambda is a body of
    // its own
    class ObjectFinder : public clang::RecursiveASTVisitor<ObjectFinder> {
     public:
      std::vector<const clang::Expr*> out_;

      bool TraverseLambdaExpr(clang::LambdaExpr*) { return true; }

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        out_.push_back(_e);
        return true;
      }

      bool VisitMemberExpr(clang::MemberExpr* _e) {
        if (llvm::isa<clang::FieldDecl>(_e->getMemberDecl())) out_.push_back(_e);
        return true;
      }
    };  // ObjectFinder

    // true if _object is the object of a group of accesses or an object that contains it, for example charge for the
    // group charge.optimizers[i]
    [[nodiscard]] inline bool is_object_of(const std::string_view _object, const std::string_view _group) {
      if (_object.empty() || !_group.starts_with(_object)) return false;
      const std::string_view rest = _group.substr(_object.size());
      return rest.empty() || rest.starts_with(".") || rest.starts_with("->") || rest.starts_with("[");
    }  // is_object_of

    // true for a static data member or a global variable that the trace can follow: not a constant, not a part of
    // the standard library or of a system header
    [[nodiscard]] inline bool is_traced_var(const clang::VarDecl* _v, const clang::SourceManager& _sm) {
      return _v && _v->getIdentifier() && _v->hasGlobalStorage() && !_v->isStaticLocal() && !_v->isConstexpr() &&
             !llvm::isa<clang::ParmVarDecl>(_v) && !is_in_std(_v) &&
             !_sm.isInSystemHeader(_sm.getFileLoc(_v->getLocation()));
    }  // is_traced_var

    // finds the member at a position of the main file: an access, the declaration or an initializer of a constructor.
    // the member is a data member, a static data member or a global variable
    class FieldFinder : public clang::RecursiveASTVisitor<FieldFinder> {
      using Base = clang::RecursiveASTVisitor<FieldFinder>;
      const clang::ASTContext& ctx_;
      uint32_t line_ = 0;
      uint32_t col_  = 0;

     public:
      const clang::ValueDecl* out_ = nullptr;

      FieldFinder(const clang::ASTContext& _ctx, const uint32_t _line, const uint32_t _col)
          : ctx_(_ctx), line_(_line), col_(_col) {}

      bool VisitMemberExpr(clang::MemberExpr* _e) {
        if (!is_at(_e->getMemberLoc())) return true;
        if (const auto* field = llvm::dyn_cast<clang::FieldDecl>(_e->getMemberDecl()); field && field->getIdentifier())
          out_ = pattern_field(field);
        if (const auto* v = llvm::dyn_cast<clang::VarDecl>(_e->getMemberDecl());
            is_traced_var(v, ctx_.getSourceManager()))
          out_ = v->getCanonicalDecl();
        return !out_;
      }

      // in a template: an access through an object of a dependent type
      bool VisitCXXDependentScopeMemberExpr(clang::CXXDependentScopeMemberExpr* _e) {
        if (is_at(_e->getMemberLoc())) out_ = dependent_field(_e);
        return !out_;
      }

      // a static data member through its class, or a global variable
      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        const auto* v = llvm::dyn_cast<clang::VarDecl>(_e->getDecl());
        if (is_traced_var(v, ctx_.getSourceManager()) && is_at(_e->getLocation())) out_ = v->getCanonicalDecl();
        return !out_;
      }

      bool VisitFieldDecl(clang::FieldDecl* _d) {
        if (_d->getIdentifier() && is_at(_d->getLocation())) out_ = _d;
        return !out_;
      }

      bool VisitVarDecl(clang::VarDecl* _d) {
        if (is_traced_var(_d, ctx_.getSourceManager()) && is_at(_d->getLocation())) out_ = _d->getCanonicalDecl();
        return !out_;
      }

      bool TraverseConstructorInitializer(clang::CXXCtorInitializer* _init) {
        if (_init->isMemberInitializer() && _init->isWritten() && is_at(_init->getMemberLocation()))
          out_ = _init->getMember();
        return !out_ && Base::TraverseConstructorInitializer(_init);
      }

     private:
      [[nodiscard]] bool is_at(const clang::SourceLocation _loc) const {
        const clang::SourceManager& sm = ctx_.getSourceManager();
        const clang::SourceLocation at = sm.getFileLoc(_loc);
        if (!sm.isInMainFile(at) || sm.getExpansionLineNumber(at) != line_) return false;
        const uint32_t col = sm.getExpansionColumnNumber(at);
        return col <= col_ && col_ <= col + clang::Lexer::MeasureTokenLength(at, sm, ctx_.getLangOpts());
      }  // is_at

    };  // FieldFinder

    // collects the accesses of the member and the bodies around them. a static data member and a global variable
    // compare by their first declaration
    class MemberCollector : public clang::RecursiveASTVisitor<MemberCollector> {
      using Base = clang::RecursiveASTVisitor<MemberCollector>;
      const clang::ASTContext& ctx_;
      const clang::ValueDecl* decl_ = nullptr;
      const MemberOptions& opts_;
      MemberModel& model_;
      std::vector<int32_t> stack_;  // the bodies around the node
      std::unordered_set<const clang::Decl*> seen_;

     public:
      // a thread start that gets a function, for example std::thread(&Worker::run, this): the function, the start, the
      // name of the start and the outermost body around the start
      struct FunctionStart {
        const clang::FunctionDecl* fn_ = nullptr;
        const clang::Expr* at_         = nullptr;
        std::string via_;
        int32_t root_ = -1;
      };  // FunctionStart
      std::vector<FunctionStart> starts_;

      MemberCollector(const clang::ASTContext& _ctx, const clang::ValueDecl& _decl, const MemberOptions& _opts,
                      MemberModel& _model)
          : ctx_(_ctx), decl_(&_decl), opts_(_opts), model_(_model) {}

      bool TraverseDecl(clang::Decl* _d) {
        auto* fn = llvm::dyn_cast_or_null<clang::FunctionDecl>(_d);
        if (!fn || !fn->doesThisDeclarationHaveABody()) return Base::TraverseDecl(_d);
        if (!seen_.insert(fn).second || ctx_.getSourceManager().isInSystemHeader(fn->getLocation())) return true;

        // the code that the user wrote: no instantiations of templates, and the body of a lambda only in its function
        const auto* method = llvm::dyn_cast<clang::CXXMethodDecl>(fn);
        if (fn->isTemplateInstantiation() || fn->isImplicit() || (method && method->getParent()->isLambda()))
          return true;
        stack_.push_back(add_body(fn, nullptr));
        const bool res = Base::TraverseDecl(_d);
        stack_.pop_back();
        return res;
      }  // TraverseDecl

      // the captures belong to the body around the lambda
      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        for (clang::Expr* init : _e->capture_inits())
          if (init && !TraverseStmt(init)) return false;
        stack_.push_back(add_body(_e->getCallOperator(), _e));
        const bool res = TraverseStmt(_e->getBody());
        stack_.pop_back();
        return res;
      }  // TraverseLambdaExpr

      bool TraverseConstructorInitializer(clang::CXXCtorInitializer* _init) {
        if (_init->isMemberInitializer() && _init->isWritten() && _init->getMember() == decl_ && !stack_.empty()) {
          MemberRef ref;
          ref.init_   = _init;
          ref.loc_    = _init->getMemberLocation();
          ref.body_   = stack_.back();
          ref.role_   = Role::DEF;
          ref.isThis_ = true;
          model_.refs_.push_back(std::move(ref));
        }
        return Base::TraverseConstructorInitializer(_init);
      }  // TraverseConstructorInitializer

      // an access of the member. the member of a specialization of a class template is the member of the template. a
      // static data member is one object for all accesses
      bool VisitMemberExpr(clang::MemberExpr* _e) {
        const clang::ValueDecl* d = _e->getMemberDecl();
        if (!d || d->getDeclName() != decl_->getDeclName()) return true;
        if (const auto* f = llvm::dyn_cast<clang::FieldDecl>(d)) {
          if (pattern_field(f) == decl_) add_ref(_e, _e->getMemberLoc(), _e->getBase());
        } else if (d->getCanonicalDecl() == decl_) {
          add_ref(_e, _e->getMemberLoc(), nullptr);
        }
        return true;
      }  // VisitMemberExpr

      // a static data member through its class, or a global variable
      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        if (_e->getDecl()->getCanonicalDecl() == decl_) add_ref(_e, _e->getLocation(), nullptr);
        return true;
      }  // VisitDeclRefExpr

      // in a template: an access through an object of a dependent type, for example _b.isFlat_
      bool VisitCXXDependentScopeMemberExpr(clang::CXXDependentScopeMemberExpr* _e) {
        if (_e->getMember() != decl_->getDeclName() || dependent_field(_e) != decl_) return true;
        add_ref(_e, _e->getMemberLoc(), _e->isImplicitAccess() ? nullptr : _e->getBase());
        return true;
      }  // VisitCXXDependentScopeMemberExpr

      bool VisitCXXConstructExpr(clang::CXXConstructExpr* _e) {
        add_function_start(_e, _e->arguments());
        return true;
      }

      bool VisitCallExpr(clang::CallExpr* _e) {
        add_function_start(_e, _e->arguments());
        return true;
      }

     private:
      [[nodiscard]] int32_t add_body(const clang::FunctionDecl* _fn, const clang::LambdaExpr* _lambda) {
        model_.bodies_.push_back(MemberBody{_fn, _lambda, _lambda && !stack_.empty() ? stack_.back() : -1, -1});
        return int32_t(model_.bodies_.size()) - 1;
      }  // add_body

      void add_ref(const clang::Expr* _e, const clang::SourceLocation _loc, const clang::Expr* _base) {
        const clang::SourceManager& sm = ctx_.getSourceManager();
        if (stack_.empty() || sm.isInSystemHeader(sm.getFileLoc(_loc))) return;
        MemberRef ref;
        ref.expr_ = _e;
        ref.loc_  = _loc;
        ref.body_ = stack_.back();
        set_object(ref, _base);
        model_.refs_.push_back(std::move(ref));
      }  // add_ref

      // the object of the access: this, a chain of members of this, or a different object. a null base is an implicit
      // this in a template
      void set_object(MemberRef& _ref, const clang::Expr* _base) const {
        if (!_base) {
          _ref.isThis_ = true;
          return;
        }
        const clang::Expr* base = _base->IgnoreParenImpCasts();
        const clang::Expr* root = base;
        for (int32_t i = 0; i < 16; ++i) {
          if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(root))
            root = m->getBase()->IgnoreParenImpCasts();
          else if (const auto* d = llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(root);
                   d && !d->isImplicitAccess())
            root = d->getBase()->IgnoreParenImpCasts();
          else
            break;
        }
        if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(root); u && u->getOpcode() == clang::UO_Deref)
          root = u->getSubExpr()->IgnoreParenImpCasts();
        _ref.isThis_ = llvm::isa<clang::CXXThisExpr>(root);
        if (llvm::isa<clang::CXXThisExpr>(base)) return;

        std::string text = short_text(ctx_, base->getSourceRange());
        if (text.starts_with("this->")) text.erase(0, 6);
        if (text == "*this" || text == "(*this)") text.clear();
        _ref.object_ = std::move(text);
      }  // set_object

      template <class Args>
      void add_function_start(const clang::Expr* _e, const Args& _args) {
        if (stack_.empty()) return;
        std::string via = start_name(_e, opts_);
        if (via.empty()) return;
        for (const clang::Expr* a : _args)
          if (const clang::FunctionDecl* fn = function_argument(a)) {
            starts_.push_back(FunctionStart{fn->getCanonicalDecl(), _e, std::move(via), root_of(stack_.back())});
            return;
          }
      }  // add_function_start

     public:
      // the outermost body around a body
      [[nodiscard]] int32_t root_of(int32_t _body) const {
        while (model_.bodies_[_body].outer_ >= 0) _body = model_.bodies_[_body].outer_;
        return _body;
      }  // root_of

    };  // MemberCollector

    //----------------------------------
    // Edges

    // reaching definitions in one body for the accesses through the same object. adds an edge from each definition to
    // each access that it reaches
    inline void add_body_edges(MemberModel& _model, const std::vector<int32_t>& _refs, const clang::CFG& _cfg) {
      std::vector<int32_t> defs;  // definition -> ref
      std::unordered_map<int32_t, int32_t> def_of_ref;
      for (const int32_t i : _refs) {
        const Role role = _model.refs_[i].role_;
        if (role != Role::DEF && role != Role::WRITE && role != Role::MAY_WRITE) continue;
        def_of_ref[i] = int32_t(defs.size());
        defs.push_back(i);
      }
      if (defs.empty()) return;

      // the uses and the definitions at each statement or initializer
      struct Event {
        int32_t ref_ = -1;
        bool isUse_  = false;
        bool isDef_  = false;
        bool isKill_ = false;
      };  // Event
      std::unordered_map<const void*, std::vector<Event>> events;
      for (const int32_t i : _refs) {
        const MemberRef& r = _model.refs_[i];
        if (r.init_)
          events[r.init_].push_back({i, false, true, true});
        else if (r.role_ == Role::READ || r.role_ == Role::CHECK)
          events[r.expr_].push_back({i, true, false, false});
        else if (r.at_)
          events[r.at_].push_back({i, r.isAlsoRead_ || r.role_ == Role::MAY_WRITE, true, r.role_ == Role::WRITE});
      }

      const size_t n      = defs.size();
      const auto transfer = [&](const clang::CFGBlock& _b, llvm::BitVector _set,
                                const bool _record) -> llvm::BitVector {
        for (const clang::CFGElement& el : _b) {
          const void* key = nullptr;
          if (const auto s = el.getAs<clang::CFGStmt>())
            key = s->getStmt();
          else if (const auto ci = el.getAs<clang::CFGInitializer>())
            key = ci->getInitializer();
          const auto it = key ? events.find(key) : events.end();
          if (it == events.end()) continue;

          for (const Event& ev : it->second) {
            if (ev.isUse_ && _record)
              for (size_t d = 0; d < n; ++d)
                if (_set.test(d) && defs[d] != ev.ref_) _model.edges_.emplace_back(defs[d], ev.ref_);
            if (!ev.isDef_) continue;
            if (ev.isKill_) _set.reset();
            _set.set(def_of_ref.at(ev.ref_));
          }
        }
        return _set;
      };

      // iterate until no set changes. then record the edges with the final sets
      std::vector<llvm::BitVector> in(_cfg.getNumBlockIDs(), llvm::BitVector(n));
      std::vector<llvm::BitVector> out(_cfg.getNumBlockIDs(), llvm::BitVector(n));
      for (bool changed = true; changed;) {
        changed = false;
        for (const clang::CFGBlock* b : _cfg) {
          llvm::BitVector set(n);
          for (const clang::CFGBlock::AdjacentBlock& pred : b->preds())
            if (const clang::CFGBlock* p = pred.getReachableBlock()) set |= out[p->getBlockID()];
          in[b->getBlockID()]         = set;
          const llvm::BitVector after = transfer(*b, set, false);
          if (after != out[b->getBlockID()]) {
            out[b->getBlockID()] = after;
            changed              = true;
          }
        }
      }
      for (const clang::CFGBlock* b : _cfg) transfer(*b, in[b->getBlockID()], true);
    }  // add_body_edges

    // keeps the bodies with an access and the bodies around them
    inline void drop_unused_bodies(MemberModel& _model) {
      std::vector<bool> isUsed(_model.bodies_.size(), false);
      for (const MemberRef& r : _model.refs_)
        for (int32_t b = r.body_; b >= 0 && !isUsed[b]; b = _model.bodies_[b].outer_) isUsed[b] = true;

      std::vector<int32_t> index(_model.bodies_.size(), -1);
      std::vector<MemberBody> bodies;
      for (size_t b = 0; b < _model.bodies_.size(); ++b) {
        if (!isUsed[b]) continue;
        index[b] = int32_t(bodies.size());
        bodies.push_back(_model.bodies_[b]);
      }
      for (MemberBody& b : bodies)
        if (b.outer_ >= 0) b.outer_ = index[b.outer_];
      for (MemberRef& r : _model.refs_)
        if (r.body_ >= 0) r.body_ = index[r.body_];
      _model.bodies_ = std::move(bodies);
    }  // drop_unused_bodies
  }  // namespace Detail

  //----------------------------------
  // Member

  // the data member, the static data member or the global variable at a position of the main file. _line and _col
  // start at 1
  [[nodiscard]] inline const clang::ValueDecl* field_at(clang::ASTUnit& _ast, const uint32_t _line,
                                                        const uint32_t _col) {
    const clang::SourceManager& sm = _ast.getSourceManager();
    Detail::FieldFinder finder(_ast.getASTContext(), _line, _col);
    const auto contains = [&](const clang::Decl* _d) {
      const clang::CharSourceRange r = sm.getExpansionRange(_d->getSourceRange());
      return sm.getExpansionLineNumber(r.getBegin()) <= _line && _line <= sm.getExpansionLineNumber(r.getEnd());
    };

    // the namespaces around the line, then the declaration at the line
    std::vector<clang::Decl*> todo(_ast.top_level_begin(), _ast.top_level_end());
    while (!todo.empty() && !finder.out_) {
      clang::Decl* d = todo.back();
      todo.pop_back();
      if (!contains(d)) continue;
      if (llvm::isa<clang::NamespaceDecl, clang::LinkageSpecDecl>(d))
        for (clang::Decl* child : llvm::cast<clang::DeclContext>(d)->decls()) todo.push_back(child);
      else
        finder.TraverseDecl(d);
    }
    return finder.out_;
  }  // field_at

  namespace Detail {
    // the definition of a class by its qualified name, for example DataFlow::WorkerPool
    [[nodiscard]] inline const clang::CXXRecordDecl* class_by_name(clang::ASTContext& _ctx,
                                                                   const std::string_view _name) {
      std::vector<const clang::DeclContext*> scopes{_ctx.getTranslationUnitDecl()};
      for (size_t pos = 0; !scopes.empty();) {
        const size_t end = _name.find("::", pos);
        const std::string_view part =
            _name.substr(pos, end == std::string_view::npos ? std::string_view::npos : end - pos);
        const bool isLast = end == std::string_view::npos;

        std::vector<const clang::DeclContext*> next;
        for (const clang::DeclContext* dc : scopes) {
          if (part == "(anonymous namespace)") {
            const clang::NamespaceDecl* anon = nullptr;
            if (const auto* tu = llvm::dyn_cast<clang::TranslationUnitDecl>(dc)) anon = tu->getAnonymousNamespace();
            if (const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(dc)) anon = ns->getAnonymousNamespace();
            if (anon) next.push_back(anon);
            continue;
          }
          for (const clang::NamedDecl* d : dc->lookup(&_ctx.Idents.get(llvm::StringRef(part.data(), part.size())))) {
            const clang::Decl* t = d;
            if (const auto* ct = llvm::dyn_cast<clang::ClassTemplateDecl>(t)) t = ct->getTemplatedDecl();
            if (const auto* rd = llvm::dyn_cast<clang::CXXRecordDecl>(t); rd && rd->getDefinition()) {
              if (isLast) return rd->getDefinition();
              next.push_back(rd->getDefinition());
            } else if (const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(t)) {
              next.push_back(ns);
            }
          }
        }
        if (isLast) break;
        scopes = std::move(next);
        pos    = end + 2;
      }
      return nullptr;
    }  // class_by_name

    // a namespace by its qualified name. an empty name is the global namespace
    [[nodiscard]] inline const clang::DeclContext* namespace_by_name(clang::ASTContext& _ctx,
                                                                     const std::string_view _name) {
      const clang::DeclContext* dc = _ctx.getTranslationUnitDecl();
      for (size_t pos = 0; dc && pos < _name.size();) {
        const size_t end = _name.find("::", pos);
        const std::string_view part =
            _name.substr(pos, end == std::string_view::npos ? std::string_view::npos : end - pos);
        const clang::DeclContext* next = nullptr;
        if (part == "(anonymous namespace)") {
          if (const auto* tu = llvm::dyn_cast<clang::TranslationUnitDecl>(dc)) next = tu->getAnonymousNamespace();
          if (const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(dc)) next = ns->getAnonymousNamespace();
        } else {
          for (const clang::NamedDecl* d : dc->lookup(&_ctx.Idents.get(llvm::StringRef(part.data(), part.size()))))
            if (const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(d)) next = ns;
        }
        dc  = next;
        pos = end == std::string_view::npos ? _name.size() : end + 2;
      }
      return dc;
    }  // namespace_by_name
  }  // namespace Detail

  // a member by the qualified name of its scope and its name: a data member or a static data member of a class, or a
  // global variable of a namespace. an empty scope is the global namespace
  [[nodiscard]] inline const clang::ValueDecl* field_by_name(clang::ASTContext& _ctx, const std::string& _scope,
                                                             const std::string& _name) {
    clang::IdentifierInfo& id      = _ctx.Idents.get(_name);
    const clang::CXXRecordDecl* rd = _scope.empty() ? nullptr : Detail::class_by_name(_ctx, _scope);
    if (rd) {
      for (const clang::FieldDecl* f : rd->fields())
        if (f->getIdentifier() == &id) return f;
      for (const clang::NamedDecl* d : rd->lookup(&id))
        if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->isStaticDataMember())
          return v->getCanonicalDecl();
      return nullptr;
    }
    const clang::DeclContext* ns = Detail::namespace_by_name(_ctx, _scope);
    for (const clang::NamedDecl* d : ns ? ns->lookup(&id) : clang::DeclContext::lookup_result())
      if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->hasGlobalStorage()) return v->getCanonicalDecl();
    return nullptr;
  }  // field_by_name

  [[nodiscard]] inline MemberModel build_member(const clang::ValueDecl& _decl, clang::ASTUnit& _ast,
                                                const MemberOptions& _opts) {
    const Detail::LockCacheScope lockCache;
    clang::ASTContext& ctx         = _ast.getASTContext();
    const clang::SourceManager& sm = ctx.getSourceManager();
    MemberModel out;
    out.decl_ = &_decl;

    // the declaration. a static data member or a global variable can also have a definition with an initializer
    if (!sm.isInSystemHeader(_decl.getLocation())) {
      MemberRef decl;
      decl.loc_  = _decl.getLocation();
      decl.role_ = Role::DEF;
      out.refs_.push_back(std::move(decl));
    }
    if (const auto* v = llvm::dyn_cast<clang::VarDecl>(&_decl))
      if (const clang::VarDecl* def = v->getDefinition(); def && def != v && !sm.isInSystemHeader(def->getLocation())) {
        MemberRef ref;
        ref.loc_  = def->getLocation();
        ref.role_ = Role::DEF;
        out.refs_.push_back(std::move(ref));
      }

    // the functions of the main file, then the class and its functions in the headers
    Detail::MemberCollector collector(ctx, _decl, _opts, out);
    for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it) collector.TraverseDecl(*it);
    if (auto* rd = const_cast<clang::CXXRecordDecl*>(llvm::dyn_cast<clang::CXXRecordDecl>(_decl.getDeclContext()))) {
      if (!sm.isInMainFile(sm.getExpansionLoc(rd->getLocation()))) collector.TraverseDecl(rd);

      // the definitions outside of the class, and the friends
      const auto traverse_definition = [&](const clang::Decl* _d) {
        if (const auto* t = llvm::dyn_cast_or_null<clang::FunctionTemplateDecl>(_d)) _d = t->getTemplatedDecl();
        const auto* fn                 = llvm::dyn_cast_or_null<clang::FunctionDecl>(_d);
        const clang::FunctionDecl* def = nullptr;
        if (fn && fn->isDefined(def)) collector.TraverseDecl(const_cast<clang::FunctionDecl*>(def));
      };
      for (const clang::Decl* d : rd->decls()) {
        if (const auto* f = llvm::dyn_cast<clang::FriendDecl>(d))
          traverse_definition(f->getFriendDecl());
        else
          traverse_definition(d);
      }
    }

    // the outermost body of each body, and its parent map
    std::unordered_map<int32_t, std::unique_ptr<clang::ParentMap>> maps;
    const auto parents = [&](const int32_t _root) -> const clang::ParentMap& {
      std::unique_ptr<clang::ParentMap>& pm = maps[_root];
      if (pm) return *pm;
      const clang::FunctionDecl* fn = out.bodies_[_root].fn_;
      pm                            = std::make_unique<clang::ParentMap>(fn->getBody());

      // the initializers of a constructor are not a part of its body, for example thread_([this]() { run(); })
      if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(fn))
        for (const clang::CXXCtorInitializer* init : ctor->inits())
          if (init->isWritten() && init->getInit()) pm->addStmt(init->getInit());
      return *pm;
    };

    // the threads. a lambda that a thread start gets runs on a new thread. else a body runs on the thread of the body
    // around it
    for (int32_t b = 0; b < int32_t(out.bodies_.size()); ++b) {
      MemberBody& body = out.bodies_[b];
      if (body.lambda_ && body.outer_ >= 0) {
        const clang::ParentMap& pm = parents(collector.root_of(b));
        const clang::Expr* call    = Detail::call_of_lambda(body.lambda_, pm);
        std::string via            = Detail::start_name(call, _opts);
        if (!via.empty()) {
          body.thread_ = int32_t(out.threads_.size());
          out.threads_.push_back(
              ThreadStart{call, nullptr, std::move(via), Detail::is_repeated_start(call, pm, _opts)});
        } else {
          body.thread_ = out.bodies_[body.outer_].thread_;
        }
        continue;
      }
      if (body.lambda_) continue;

      const auto start = std::ranges::find(collector.starts_, body.fn_->getCanonicalDecl(),
                                           &Detail::MemberCollector::FunctionStart::fn_);
      if (start != collector.starts_.end()) {
        body.thread_ = int32_t(out.threads_.size());
        out.threads_.push_back(ThreadStart{start->at_, nullptr, start->via_,
                                           Detail::is_repeated_start(start->at_, parents(start->root_), _opts)});
      } else if (Detail::is_qthread_run(body.fn_)) {
        body.thread_ = int32_t(out.threads_.size());
        out.threads_.push_back(ThreadStart{nullptr, body.fn_, "QThread::run", false});
      } else if (const auto entry = std::ranges::find_if(
                     _opts.entries_,
                     [&](const ThreadEntry& _e) { return _e.function_ == body.fn_->getQualifiedNameAsString(); });
                 entry != _opts.entries_.end()) {
        // a thread of a different source file calls this function. the threads of one start are one thread
        const auto same = std::ranges::find_if(out.threads_, [&](const ThreadStart& _t) {
          return !_t.at_ && _t.via_ == entry->via_ && _t.file_ == entry->file_ && _t.line_ == entry->line_;
        });
        body.thread_    = int32_t(same - out.threads_.begin());
        if (same == out.threads_.end())
          out.threads_.push_back(
              ThreadStart{nullptr, body.fn_, entry->via_, entry->isRepeated_, entry->file_, entry->line_, {}});
      }
    }

    // a function that a body on a thread calls runs on the same thread, and a lambda in it too. the walk follows the
    // calls into the functions of the trace
    std::unordered_map<const clang::FunctionDecl*, int32_t> body_of;
    std::vector<int32_t> todo;
    for (int32_t b = 0; b < int32_t(out.bodies_.size()); ++b) {
      if (!out.bodies_[b].lambda_) body_of.emplace(out.bodies_[b].fn_->getCanonicalDecl(), b);
      if (out.bodies_[b].thread_ >= 0) todo.push_back(b);
    }
    while (!todo.empty()) {
      const int32_t b = todo.back();
      todo.pop_back();
      Detail::CallFinder calls;
      calls.TraverseStmt(out.bodies_[b].fn_->getBody());
      for (const clang::CallExpr* call : calls.out_) {
        const clang::FunctionDecl* callee = Detail::called_function(call);
        const auto it                     = callee ? body_of.find(callee->getCanonicalDecl()) : body_of.end();
        if (it == body_of.end() || out.bodies_[it->second].thread_ >= 0) continue;
        out.bodies_[it->second].thread_ = out.bodies_[b].thread_;
        out.bodies_[it->second].call_   = call;
        todo.push_back(it->second);
      }
      for (int32_t l = b + 1; l < int32_t(out.bodies_.size()); ++l) {
        MemberBody& lambda = out.bodies_[l];
        if (lambda.outer_ != b || lambda.thread_ >= 0) continue;
        lambda.thread_ = out.bodies_[b].thread_;
        todo.push_back(l);
      }
    }

    // the functions of other source files that each thread calls: a function with no body in this unit. the extension
    // gives the thread to these functions when it parses the other source files
    for (const MemberBody& body : out.bodies_) {
      if (body.thread_ < 0) continue;
      Detail::CallFinder calls;
      calls.TraverseStmt(body.lambda_ ? body.lambda_->getBody() : body.fn_->getBody());
      std::vector<std::string>& names = out.threads_[body.thread_].calls_;
      for (const clang::CallExpr* call : calls.out_) {
        const clang::FunctionDecl* callee = Detail::called_function(call);
        if (!callee || callee->isDefined() || !callee->getIdentifier() || Detail::is_in_std(callee) ||
            sm.isInSystemHeader(sm.getFileLoc(callee->getLocation())))
          continue;
        std::string name = callee->getQualifiedNameAsString();
        if (!llvm::is_contained(names, name)) names.push_back(std::move(name));
      }
    }

    // the roles and the locks. each body has its own mutation analyzer. the analyzers need the parents of the nodes
    // of the functions with an access only
    std::vector<const clang::FunctionDecl*> roots;
    for (const MemberRef& r : out.refs_)
      if (r.expr_ && !llvm::is_contained(roots, out.bodies_[collector.root_of(r.body_)].fn_))
        roots.push_back(out.bodies_[collector.root_of(r.body_)].fn_);
    const TraversalScope scope(ctx, roots);
    std::unordered_map<int32_t, std::unique_ptr<clang::ExprMutationAnalyzer>> analyzers;
    for (MemberRef& r : out.refs_) {
      if (!r.expr_) continue;  // the declaration or an initializer
      const clang::ParentMap& pm = parents(collector.root_of(r.body_));
      r.locks_                   = Detail::locks_at(r.expr_, pm, ctx);
      if (Detail::is_plain_read(r.expr_, pm) || Detail::is_const_type(_decl.getType())) {
        r.role_ = Detail::is_in_condition(r.expr_, pm) ? Role::CHECK : Role::READ;
        continue;
      }
      std::unique_ptr<clang::ExprMutationAnalyzer>& ma = analyzers[r.body_];
      if (!ma) ma = std::make_unique<clang::ExprMutationAnalyzer>(*out.bodies_[r.body_].fn_->getBody(), ctx);

      const clang::Stmt* m  = Detail::find_change(*ma, r.expr_, false, _opts.read_functions_);
      const auto also_reads = m ? Detail::assign_kind(m, r.expr_) : std::nullopt;
      if (also_reads) {
        r.at_         = m;
        r.role_       = Role::WRITE;
        r.isAlsoRead_ = *also_reads;
      } else if (m && !Detail::is_read_through_accessor(m, r.expr_, *ma, _opts.read_functions_) &&
                 !Detail::is_returned(r.expr_, pm)) {
        r.at_   = m;
        r.role_ = Role::MAY_WRITE;
      } else {
        r.role_ = Detail::is_in_condition(r.expr_, pm) ? Role::CHECK : Role::READ;
      }
    }

    // the edges in each body, between the accesses through the same object: this, or the same text of a different
    // object, for example charge in charge.is_dirty
    std::map<std::pair<int32_t, std::string>, std::vector<int32_t>> groups;
    for (int32_t i = 0; i < int32_t(out.refs_.size()); ++i)
      if (out.refs_[i].body_ >= 0) groups[{out.refs_[i].body_, out.refs_[i].object_}].push_back(i);

    // a change of the whole object of a group can change the member, for example an assignment of the object, a call
    // that gets the object by a reference to non-const, or a call of a non-const member function on the object. such
    // a change is a definition on the rail of the member. a change of an object that contains the object also counts
    if (llvm::isa<clang::FieldDecl>(&_decl)) {
      std::unordered_map<const clang::Expr*, int32_t> wholeRef;  // an object expression -> its ref
      for (auto& [key, refs] : groups) {
        const auto& [b, group] = key;
        if (group.empty()) continue;  // this
        Detail::ObjectFinder finder;
        finder.TraverseStmt(out.bodies_[b].fn_->getBody());
        const clang::ParentMap& pm = parents(collector.root_of(b));
        const auto parent_of       = [&](const clang::Stmt* _s) -> const clang::Stmt* {
          const clang::Stmt* p = pm.getParent(_s);
          while (p && (llvm::isa<clang::ParenExpr>(p) ||
                       (llvm::isa<clang::ImplicitCastExpr>(p) &&
                        llvm::cast<clang::ImplicitCastExpr>(p)->getCastKind() != clang::CK_LValueToRValue)))
            p = pm.getParent(p);
          return p;
        };
        for (const clang::Expr* e : finder.out_) {
          std::string text = Detail::short_text(ctx, e->getSourceRange());
          if (text.starts_with("this->")) text.erase(0, 6);
          if (!Detail::is_object_of(text, group)) continue;

          // a data member of the object, or a data member of an element of it, is not the whole object
          const clang::Stmt* p = parent_of(e);
          if (const auto* op = llvm::dyn_cast_or_null<clang::CXXOperatorCallExpr>(p);
              (op && op->getOperator() == clang::OO_Subscript) || llvm::isa_and_nonnull<clang::ArraySubscriptExpr>(p))
            p = parent_of(p);
          if (const auto* m = llvm::dyn_cast_or_null<clang::MemberExpr>(p);
              m && llvm::isa<clang::FieldDecl>(m->getMemberDecl()))
            continue;
          if (const auto* d = llvm::dyn_cast_or_null<clang::CXXDependentScopeMemberExpr>(p);
              d && Detail::dependent_field(d))
            continue;

          if (const auto it = wholeRef.find(e); it != wholeRef.end()) {
            refs.push_back(it->second);
            continue;
          }
          std::unique_ptr<clang::ExprMutationAnalyzer>& ma = analyzers[b];
          if (!ma) ma = std::make_unique<clang::ExprMutationAnalyzer>(*out.bodies_[b].fn_->getBody(), ctx);
          const clang::Stmt* m = Detail::find_change(*ma, e, false, _opts.read_functions_);
          if (!m) continue;

          MemberRef r;
          r.expr_               = e;
          r.at_                 = m;
          r.loc_                = e->getBeginLoc();
          r.body_               = b;
          r.object_             = std::move(text);
          r.isWhole_            = true;
          r.locks_              = Detail::locks_at(e, pm, ctx);
          const auto also_reads = Detail::assign_kind(m, e);
          r.role_               = also_reads ? Role::WRITE : Role::MAY_WRITE;
          r.isAlsoRead_         = also_reads && *also_reads;
          wholeRef.emplace(e, int32_t(out.refs_.size()));
          refs.push_back(int32_t(out.refs_.size()));
          out.refs_.push_back(std::move(r));
        }
      }
    }
    std::unordered_map<int32_t, std::unique_ptr<clang::CFG>> cfgs;
    for (const auto& [key, refs] : groups) {
      std::unique_ptr<clang::CFG>& cfg = cfgs[key.first];
      if (!cfg) {
        clang::CFG::BuildOptions opts;
        opts.setAllAlwaysAdd();  // each expression is an element, in the sequence of the evaluation
        opts.AddInitializers          = true;
        const clang::FunctionDecl* fn = out.bodies_[key.first].fn_;
        cfg                           = build_cfg(fn, fn->getBody(), ctx, opts);
        if (!cfg) continue;
      }
      Detail::add_body_edges(out, refs, *cfg);
    }

    Detail::drop_unused_bodies(out);
    return out;
  }  // build_member

  //----------------------------------
  // Json

  namespace Detail {
    // the file, the line, the column and the length of a name. columns are utf-8 bytes and start at 1
    [[nodiscard]] inline JsonObject place_to_json(const clang::SourceLocation _loc, const clang::ASTContext& _ctx) {
      const clang::SourceManager& sm = _ctx.getSourceManager();
      const clang::SourceLocation at = sm.getFileLoc(_loc);
      return JsonObject{{"file", file_of(sm, at)},
                        {"line", int64_t(sm.getExpansionLineNumber(at))},
                        {"col", int64_t(sm.getExpansionColumnNumber(at))},
                        {"len", int64_t(clang::Lexer::MeasureTokenLength(at, sm, _ctx.getLangOpts()))}};
    }  // place_to_json

    [[nodiscard]] inline const char* access_name(const clang::AccessSpecifier _access) {
      switch (_access) {
        case clang::AS_private:
          return "private";
        case clang::AS_protected:
          return "protected";
        default:
          return "public";
      }
    }  // access_name

    [[nodiscard]] inline const char* body_kind(const MemberBody& _body) {
      if (_body.lambda_) return "lambda";
      if (llvm::isa<clang::CXXConstructorDecl>(_body.fn_)) return "constructor";
      if (llvm::isa<clang::CXXDestructorDecl>(_body.fn_)) return "destructor";
      if (llvm::isa<clang::CXXMethodDecl>(_body.fn_)) return "method";
      return "function";
    }  // body_kind
  }  // namespace Detail

  [[nodiscard]] inline JsonObject member_to_json(const MemberModel& _model, clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const clang::PrintingPolicy policy(_ctx.getLangOpts());
    const clang::ValueDecl& decl = *_model.decl_;
    const auto* field            = llvm::dyn_cast<clang::FieldDecl>(&decl);
    const auto* var              = llvm::dyn_cast<clang::VarDecl>(&decl);
    const auto* rd               = llvm::dyn_cast<clang::RecordDecl>(decl.getDeclContext());

    // the scope of a global variable is its namespace
    std::string scope;
    if (const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(decl.getDeclContext()))
      scope = ns->getQualifiedNameAsString();
    JsonObject member{{"name", decl.getNameAsString()},
                      {"type", decl.getType().getAsString(policy)},
                      {"kind", field ? "field"
                               : rd  ? "static"
                                     : "global"},
                      {"className", rd ? rd->getNameAsString() : std::string()},
                      {"qualifiedClass", rd ? rd->getQualifiedNameAsString() : scope},
                      {"access", rd ? Detail::access_name(decl.getAccess()) : "public"},
                      {"isAtomic", Detail::is_atomic_type(decl.getType())},
                      {"isSync", Detail::is_sync_type(decl.getType())},
                      {"decl", Detail::place_to_json(decl.getLocation(), _ctx)}};
    const clang::Expr* init = field ? field->getInClassInitializer() : nullptr;
    if (var && var->getDefinition()) init = var->getDefinition()->getInit();
    if (init) member["init"] = Detail::short_text(_ctx, init->getSourceRange());

    // the data members and the static data members of the class
    JsonArray fields;
    const auto add_field = [&](const clang::ValueDecl* _f) -> void {
      fields.push_back(JsonObject{{"name", _f->getNameAsString()},
                                  {"type", _f->getType().getAsString(policy)},
                                  {"line", int64_t(sm.getExpansionLineNumber(sm.getFileLoc(_f->getLocation())))}});
    };
    if (rd)
      for (const clang::Decl* d : rd->decls()) {
        const auto* v = llvm::dyn_cast<clang::VarDecl>(d);
        if (const auto* f = llvm::dyn_cast<clang::FieldDecl>(d); f && f->getIdentifier()) add_field(f);
        if (v && v->isStaticDataMember() && v->getIdentifier()) add_field(v);
      }

    JsonArray bodies;
    for (const MemberBody& b : _model.bodies_) {
      const clang::SourceLocation at = sm.getFileLoc(b.lambda_ ? b.lambda_->getBeginLoc() : b.fn_->getLocation());
      JsonObject o{{"name", b.lambda_ ? std::string("lambda") : b.fn_->getNameAsString()},
                   {"qualifiedName", b.lambda_ ? std::string() : b.fn_->getQualifiedNameAsString()},
                   {"kind", Detail::body_kind(b)},
                   {"file", Detail::file_of(sm, at)},
                   {"line", int64_t(sm.getExpansionLineNumber(at))},
                   {"outer", int64_t(b.outer_)},
                   {"thread", int64_t(b.thread_)}};
      if (b.call_) {
        const clang::SourceLocation call = sm.getFileLoc(b.call_->getBeginLoc());
        o["threadCall"] =
            JsonObject{{"file", Detail::file_of(sm, call)}, {"line", int64_t(sm.getExpansionLineNumber(call))}};
      }
      bodies.push_back(std::move(o));
    }

    const auto strings = [](const std::vector<std::string>& _list) -> JsonArray {
      JsonArray out;
      for (const std::string& s : _list) out.push_back(s);
      return out;
    };

    // a thread of a different source file keeps the place of its start in that file
    JsonArray threads;
    for (const ThreadStart& t : _model.threads_) {
      const clang::SourceLocation at = sm.getFileLoc(t.at_ ? t.at_->getBeginLoc() : t.decl_->getLocation());
      JsonObject o{{"via", t.via_},
                   {"file", t.file_.empty() ? Detail::file_of(sm, at) : t.file_},
                   {"line", int64_t(t.file_.empty() ? sm.getExpansionLineNumber(at) : t.line_)},
                   {"isRepeated", t.isRepeated_}};
      if (!t.calls_.empty()) o["calls"] = strings(t.calls_);
      threads.push_back(std::move(o));
    }

    JsonArray refs;
    for (const MemberRef& r : _model.refs_) {
      JsonObject o = Detail::place_to_json(r.loc_, _ctx);
      o["fn"]      = int64_t(r.body_);
      o["role"]    = Detail::role_name(r.role_);
      if (r.isAlsoRead_) o["alsoRead"] = true;
      if (r.isWhole_) o["whole"] = true;
      if (!r.object_.empty()) o["object"] = r.object_;
      if (!r.locks_.empty()) o["locks"] = strings(r.locks_);
      if (!r.runs_.empty()) {
        JsonArray runs;
        for (const MemberRun& run : r.runs_) {
          JsonArray ordered;
          for (const int32_t t : run.ordered_) ordered.push_back(int64_t(t));
          JsonObject ro{{"thread", int64_t(run.thread_)}};
          if (!run.locks_.empty()) ro["locks"] = strings(run.locks_);
          if (!ordered.empty()) ro["ordered"] = std::move(ordered);
          runs.push_back(std::move(ro));
        }
        o["runs"] = std::move(runs);
      }
      refs.push_back(std::move(o));
    }

    JsonArray edges;
    for (const auto& [from, to] : _model.edges_) edges.push_back(JsonArray{int64_t(from), int64_t(to)});

    return JsonObject{{"member", std::move(member)},   {"fields", std::move(fields)}, {"functions", std::move(bodies)},
                      {"threads", std::move(threads)}, {"refs", std::move(refs)},     {"edges", std::move(edges)}};
  }  // member_to_json

}  // namespace DataFlow
