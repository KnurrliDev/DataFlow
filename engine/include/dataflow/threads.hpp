#pragma once

#include <dataflow/calls.hpp>

/*
  Threads and races, for the lens Threads:
    > threads: the statements that start a thread or an async call, the body that runs on the new thread, the handle
      that keeps the thread or its future, and the joins of the handle: join(), get(), wait(), and the destructors that
      join
    > accesses: the accesses of data members, of static and global variables, and of the local objects that a thread
      uses. a thread lambda captures such an object by reference, or a call gives it to a function that gives it to a
      thread. the walk starts at the functions of the main file that no function of the file calls, and it follows the
      calls and the destructors into the functions of the main file and of the project headers. a parameter of a
      called function gets the object of its argument, and this gets the object of the call. thus an access has the
      same object on each thread
    > protection: the lock guards at an access and at each call on the way to it, and the order to each thread:
      > after: a join of the handle comes before the access in the same block
      > ready: the access is in a branch where the future of the thread is ready
      > empty: the access is in a branch where the handle is empty, so no thread of the handle runs
      > before: the start comes after the access, and the thread ends in the same function, or the function is a
        constructor. else a thread of an earlier call can still run
    > conditions: the conditions around an access of the caller thread, for example a state. a condition can keep two
      threads apart, but the engine cannot see if it does
  The extension finds the accesses that can run at the same time, and it gives a verdict for each item.
*/

namespace DataFlow {

  struct ThreadsOptions {
    std::vector<std::string> async_functions_;  // functions that run a callable on a different thread
    std::vector<std::string> roots_;            // the folders of the project. the walk follows calls into their headers
  };  // ThreadsOptions

  // an object: a root and the steps to it. the root is a variable, or this of a class. a step is a data member, or
  // null for an element of a container or an array
  struct ObjectPath {
    const clang::Decl* root_ = nullptr;  // a VarDecl, a BindingDecl, or the canonical CXXRecordDecl of this
    bool isThis_             = false;
    std::vector<const clang::FieldDecl*> steps_;

    bool operator==(const ObjectPath&) const = default;
  };  // ObjectPath

  // a function, or a lambda in a function
  struct ThreadsBody {
    const clang::FunctionDecl* fn_   = nullptr;  // the function, or the call operator of the lambda
    const clang::LambdaExpr* lambda_ = nullptr;
    int32_t outer_                   = -1;  // the body around a lambda
    int32_t root_                    = -1;  // the function: the body itself, or the outermost body around a lambda
    std::vector<int32_t> threads_;          // the threads that run the body. -1 is the caller thread
  };  // ThreadsBody

  // a join of the handle of a thread: join(), get() or wait(). a loop over a container of threads is one join. a call
  // of a function that joins the handle of an argument or of its object in each run is also a join. so is a destructor
  // that joins a thread of its object, the destructor of std::jthread, and the destructor of the future of std::async
  struct ThreadsJoin {
    const clang::Stmt* at_   = nullptr;  // the call, the loop around it, or the block at the end of which it runs
    const clang::Expr* call_ = nullptr;  // null for a destructor at the end of a block
    int32_t body_            = -1;
    std::string kind_;   // join, get, wait, or the destructor, for example ~Worker
    ObjectPath handle_;  // the handle in the terms of the body
    bool isAtEnd_ = false;  // the join runs at the end of at_
  };  // ThreadsJoin

  // a statement that starts a thread, or the run function of a class derived from QThread
  struct ThreadsStart {
    const clang::Expr* at_ = nullptr;   // null for QThread::run
    int32_t body_          = -1;        // the body with the start, or -1 for QThread::run
    int32_t runs_          = -1;        // the body that runs on the thread, or -1 if it is not a part of the analysis
    std::string via_;                   // for example std::thread or tf::Executor::async
    std::string name_;                  // the function that the thread runs, or lambda
    std::optional<ObjectPath> handle_;  // the variable or the member that keeps the thread or its future
    std::string handleText_;
    bool isRepeated_ = false;  // more than one thread of the start can run at the same time
    bool isJoined_   = false;  // a join comes after the start in the same function. the thread ends in the function
    std::vector<ThreadsJoin> joins_;
  };  // ThreadsStart

  // a call or a thread start on the way to an access, and the body with it
  struct ThreadsVia {
    const clang::Stmt* at_ = nullptr;
    int32_t body_          = -1;
  };  // ThreadsVia

  // a condition around an access of the caller thread
  struct ThreadsGuard {
    std::string text_;
    bool isNegated_ = false;         // the access is in the branch where the condition is false
    std::vector<std::string> keys_;  // the items that the condition reads

    bool operator==(const ThreadsGuard& _o) const { return text_ == _o.text_ && isNegated_ == _o.isNegated_; }
  };  // ThreadsGuard

  // the threads that an access is in sequence with. each list is sorted
  struct ThreadsOrder {
    std::vector<int32_t> after_;   // a join of the thread comes before the access
    std::vector<int32_t> before_;  // the start of the thread comes after the access
    std::vector<int32_t> empty_;   // the handle of the thread is empty at the access
    std::vector<int32_t> ready_;   // the future of the thread is ready at the access

    bool operator==(const ThreadsOrder&) const = default;
  };  // ThreadsOrder

  struct ThreadsAccess {
    const clang::Expr* expr_ = nullptr;
    int32_t body_            = -1;
    int32_t thread_          = -1;  // -1 for the caller thread
    Role role_               = Role::READ;
    bool isAlsoRead_         = false;
    bool isWhole_            = false;  // an access of the whole object, for example a call that gets it by reference
    bool isAtomic_           = false;  // the accessed object is atomic
    std::string path_;                 // the text of the object, for example charge.optimizers[].schedule.kw
    std::vector<std::string> sub_;     // the steps after the item. "[]" is an element
    std::vector<std::string> locks_;
    ThreadsOrder order_;
    std::vector<ThreadsGuard> guards_;
    std::vector<ThreadsVia> via_;
    int32_t swapThread_ = -1;  // the condition reads the item before it checks the handle of this thread
    std::string swapFrom_;
    std::string swapTo_;
  };  // ThreadsAccess

  // data that the code of the threads uses: a data member of an object, a static or global variable, or a local
  // object that a thread uses
  struct ThreadsItem {
    std::string key_;
    std::string root_;  // the key of the root object
    std::string label_;
    std::string kind_;  // member, static, global, local or whole
    const clang::ValueDecl* decl_ = nullptr;
    std::vector<ThreadsAccess> accesses_;
  };  // ThreadsItem

  // the local variables that a thread lambda captures by reference, if the thread can run after its function returns
  struct ThreadsCapture {
    int32_t thread_ = -1;
    std::vector<const clang::VarDecl*> vars_;
  };  // ThreadsCapture

  struct ThreadsModel {
    std::vector<ThreadsBody> bodies_;
    std::vector<ThreadsStart> threads_;
    std::vector<ThreadsItem> items_;
    std::vector<ThreadsCapture> captures_;
    bool isTruncated_   = false;  // the walk stopped at a limit

    // the size and the times of the analysis, for the log
    int32_t visits_     = 0;
    size_t rawAccesses_ = 0;
    double functionsMs_ = 0.0;
    double scanMs_      = 0.0;
    double prepareMs_   = 0.0;
    double walkMs_      = 0.0;
    double finishMs_    = 0.0;
    double cleanupMs_   = 0.0;
  };  // ThreadsModel

  namespace Detail {
    // the objects of the parameters of a called function, and the object of this. the key of this is its class
    using Subst                                  = std::vector<std::pair<const clang::Decl*, ObjectPath>>;

    inline constexpr int32_t threads_max_depth   = 8;       // the calls from a root to a body
    inline constexpr int32_t threads_max_visits  = 20000;   // the bodies in a context
    inline constexpr size_t threads_max_accesses = 400000;  // the accesses of the walk, before the selection
    inline constexpr size_t threads_max_headers  = 300;     // the functions of the project headers
    inline constexpr size_t threads_max_guards   = 6;

    [[nodiscard]] inline bool has_name(const clang::NamedDecl* _d,
                                       const std::initializer_list<llvm::StringRef> _names) {
      return _d && _d->getIdentifier() && llvm::is_contained(_names, _d->getName());
    }  // has_name

    // the expression without the nodes that keep the object: parentheses, implicit casts, temporaries and conversions
    [[nodiscard]] inline const clang::Expr* object_expr(const clang::Expr* _e) {
      for (int32_t i = 0; _e && i < 16; ++i) {
        const clang::Expr* next = _e->IgnoreParenImpCasts();
        if (const auto* c = llvm::dyn_cast<clang::ExprWithCleanups>(next))
          next = c->getSubExpr();
        else if (const auto* m = llvm::dyn_cast<clang::MaterializeTemporaryExpr>(next))
          next = m->getSubExpr();
        else if (const auto* t = llvm::dyn_cast<clang::CXXBindTemporaryExpr>(next))
          next = t->getSubExpr();
        else if (const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(next);
                 call && llvm::isa_and_nonnull<clang::CXXConversionDecl>(call->getMethodDecl()))
          next = call->getImplicitObjectArgument();
        if (next == _e) return _e;
        _e = next;
      }
      return _e;
    }  // object_expr

    // the object of an expression: a variable or this, and the data members and elements to it. nullopt for other
    // expressions, for example the result of a call. with _isThroughRefs false, a local reference stays the root, so
    // the path is the path of the source text
    [[nodiscard]] inline std::optional<ObjectPath> object_path(const clang::Expr* _e, const Subst& _subst,
                                                               const int32_t _depth      = 0,
                                                               const bool _isThroughRefs = true) {
      const clang::Expr* e = object_expr(_e);
      if (!e || _depth > 16) return std::nullopt;
      const auto find = [&](const clang::Decl* _key) -> const ObjectPath* {
        for (const auto& [key, path] : _subst)
          if (key == _key) return &path;
        return nullptr;
      };
      const auto add_step = [](std::optional<ObjectPath> _p, const clang::FieldDecl* _step) {
        if (_p) _p->steps_.push_back(_step);
        return _p;
      };

      if (llvm::isa<clang::CXXThisExpr>(e)) {
        const clang::CXXRecordDecl* rd = record_of(e->getType()->getPointeeType());
        if (!rd) return std::nullopt;
        rd = rd->getCanonicalDecl();
        if (const ObjectPath* p = find(rd)) return *p;
        return ObjectPath{rd, true, {}};
      }
      if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(e)) {
        if (const auto* b = llvm::dyn_cast<clang::BindingDecl>(ref->getDecl())) return ObjectPath{b, false, {}};
        const auto* v = llvm::dyn_cast<clang::VarDecl>(ref->getDecl());
        if (!v) return std::nullopt;
        if (const ObjectPath* p = find(v)) return *p;

        // a local reference is the object of its initializer
        if (_isThroughRefs && v->getType()->isReferenceType() && v->isLocalVarDecl() && v->getInit())
          if (auto p = object_path(v->getInit(), _subst, _depth + 1, _isThroughRefs)) return p;
        return ObjectPath{v, false, {}};
      }
      if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(e)) {
        if (const auto* v = llvm::dyn_cast<clang::VarDecl>(m->getMemberDecl())) return ObjectPath{v, false, {}};
        const auto* f = llvm::dyn_cast<clang::FieldDecl>(m->getMemberDecl());
        if (!f) return std::nullopt;
        return add_step(object_path(m->getBase(), _subst, _depth + 1, _isThroughRefs), pattern_field(f));
      }

      // in a template: a data member of an object of a dependent type, or of this with a dependent base class
      if (const auto* d = llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(e)) {
        const clang::FieldDecl* f = dependent_field(d);
        if (!f) return std::nullopt;
        if (!d->isImplicitAccess()) return add_step(object_path(d->getBase(), _subst, _depth + 1, _isThroughRefs), f);
        const clang::CXXRecordDecl* rd = class_of_type(d->getBaseType(), d->isArrow());
        if (!rd) return std::nullopt;
        rd                          = rd->getCanonicalDecl();
        std::optional<ObjectPath> p = ObjectPath{rd, true, {}};
        if (const ObjectPath* s = find(rd)) p = *s;
        return add_step(std::move(p), f);
      }
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(e);
          u && (u->getOpcode() == clang::UO_Deref || u->getOpcode() == clang::UO_AddrOf))
        return object_path(u->getSubExpr(), _subst, _depth + 1, _isThroughRefs);
      if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(e))
        return add_step(object_path(a->getBase(), _subst, _depth + 1, _isThroughRefs), nullptr);
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(e); op && op->getNumArgs() > 0) {
        if (op->getOperator() == clang::OO_Subscript)
          return add_step(object_path(op->getArg(0), _subst, _depth + 1, _isThroughRefs), nullptr);
        if (op->getOperator() == clang::OO_Arrow || (op->getOperator() == clang::OO_Star && op->getNumArgs() == 1))
          return object_path(op->getArg(0), _subst, _depth + 1, _isThroughRefs);
        return std::nullopt;
      }
      if (const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(e)) {
        const clang::CXXMethodDecl* md = call->getMethodDecl();
        if (has_name(md, {"front", "back", "at"}))
          return add_step(object_path(call->getImplicitObjectArgument(), _subst, _depth + 1, _isThroughRefs), nullptr);
        if (has_name(md, {"value"}))
          return object_path(call->getImplicitObjectArgument(), _subst, _depth + 1, _isThroughRefs);
      }
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(e)) {
        if (const clang::CXXDependentScopeMemberExpr* d = dependent_accessor(call)) {
          if (d->getMember().getAsIdentifierInfo()->getName() == "value")
            return object_path(d->getBase(), _subst, _depth + 1, _isThroughRefs);
          return add_step(object_path(d->getBase(), _subst, _depth + 1, _isThroughRefs), nullptr);
        }
      }
      return std::nullopt;
    }  // object_path

    // the text of the first _steps steps of a path, for example charge.optimizers[]. this is not a part of the text
    [[nodiscard]] inline std::string object_text(const ObjectPath& _p, const size_t _steps) {
      std::string out;
      if (const auto* n = llvm::dyn_cast_or_null<clang::NamedDecl>(_p.root_); n && !_p.isThis_)
        out = n->getNameAsString();
      for (size_t i = 0; i < _steps && i < _p.steps_.size(); ++i) {
        if (!_p.steps_[i]) {
          out += "[]";
          continue;
        }
        if (!out.empty()) out += '.';
        out += _p.steps_[i]->getNameAsString();
      }
      return out;
    }  // object_text

    [[nodiscard]] inline std::string object_key(const ObjectPath& _p, const size_t _steps) {
      std::string out = std::to_string(reinterpret_cast<uintptr_t>(_p.root_));
      for (size_t i = 0; i < _steps && i < _p.steps_.size(); ++i)
        out += _p.steps_[i] ? "/" + std::to_string(reinterpret_cast<uintptr_t>(_p.steps_[i])) : std::string("/[]");
      return out;
    }  // object_key

    // the class of the user in a type: the type, the pointee of a pointer, or the value of std::unique_ptr,
    // std::shared_ptr or std::optional. null for the types of std and of the system headers
    [[nodiscard]] inline const clang::CXXRecordDecl* user_class_of(clang::QualType _t,
                                                                   const clang::SourceManager& _sm) {
      for (int32_t i = 0; i < 4 && !_t.isNull(); ++i) {
        _t = _t.getNonReferenceType();
        if (_t->isPointerType()) _t = _t->getPointeeType();
        const clang::CXXRecordDecl* rd = record_of(_t);
        if (!rd) return nullptr;
        if (!is_in_std(rd)) return _sm.isInSystemHeader(rd->getLocation()) ? nullptr : rd;
        const auto* spec = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(rd);
        if (!spec || !has_name(rd, {"unique_ptr", "shared_ptr", "optional"}) || spec->getTemplateArgs().size() == 0 ||
            spec->getTemplateArgs()[0].getKind() != clang::TemplateArgument::Type)
          return nullptr;
        _t = spec->getTemplateArgs()[0].getAsType();
      }
      return nullptr;
    }  // user_class_of

    // the steps of the item of a path: the root and its data members, while the type of the member is a class of the
    // user. thus srv.pool_.jobs_ is an item, and an element of a container belongs to the container. a path with an
    // element first is its root
    [[nodiscard]] inline size_t item_steps(const ObjectPath& _p, const clang::SourceManager& _sm) {
      size_t n = 0;
      while (n < _p.steps_.size() && _p.steps_[n]) {
        ++n;
        if (!user_class_of(_p.steps_[n - 1]->getType(), _sm)) break;
      }
      return n;
    }  // item_steps

    // true for a call of an accessor that gives an element or the value of its object
    [[nodiscard]] inline bool is_path_call(const clang::Expr* _e) {
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_e))
        return op->getOperator() == clang::OO_Subscript || op->getOperator() == clang::OO_Arrow ||
               (op->getOperator() == clang::OO_Star && op->getNumArgs() == 1);
      if (const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(_e))
        return has_name(call->getMethodDecl(), {"front", "back", "at", "value"});
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(_e)) return dependent_accessor(call) != nullptr;
      return false;
    }  // is_path_call

    // true if the parent of the expression makes a longer path of it: a data member of it, or an element
    [[nodiscard]] inline bool is_inner_step(const clang::Expr* _e, const clang::ParentMap& _pm) {
      const clang::Stmt* child = _e;
      const clang::Stmt* p     = _pm.getParent(child);
      while (p && llvm::isa<clang::ImplicitCastExpr, clang::ParenExpr, clang::MaterializeTemporaryExpr,
                            clang::CXXBindTemporaryExpr>(p)) {
        child = p;
        p     = _pm.getParent(p);
      }
      if (!p) return false;
      if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(p)) {
        if (m->getBase() != child) return false;
        if (llvm::isa<clang::FieldDecl>(m->getMemberDecl())) return true;

        // a call of front(), back(), at() or value() on the expression
        return has_name(m->getMemberDecl(), {"front", "back", "at", "value"}) &&
               llvm::isa_and_nonnull<clang::CXXMemberCallExpr>(_pm.getParent(p));
      }
      if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(p)) return a->getBase() == child;
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(p))
        return op->getNumArgs() > 0 && op->getArg(0) == child && is_path_call(op);

      // in a template: a data member of an object of a dependent type, or an accessor on it
      if (const auto* d = llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(p)) {
        if (d->isImplicitAccess() || d->getBase() != child) return false;
        if (dependent_field(d)) return true;
        const auto* call = llvm::dyn_cast_or_null<clang::CallExpr>(_pm.getParent(d));
        return call && dependent_accessor(call) == d;
      }
      return false;
    }  // is_inner_step

    using AccessRole = std::pair<Role, bool>;  // the role, and true if a write also reads the old value

    // the role of a value that a parameter gets: a non-const reference or a pointer to non-const can change the object.
    // a forwarding reference of std::move changes it, the formatting functions of std only read it
    [[nodiscard]] inline bool is_changing_param(const clang::FunctionDecl* _fn, const uint32_t _param) {
      if (!_fn) return true;
      if (_param >= _fn->getNumParams()) return false;  // a variadic argument is a copy
      const clang::QualType t = _fn->getParamDecl(_param)->getType();
      if (t->isLValueReferenceType()) return !t.getNonReferenceType().isConstQualified();
      if (t->isRValueReferenceType())
        return !(is_in_std(_fn) && has_name(_fn, {"format", "format_to", "print", "println", "make_format_args",
                                                  "forward", "invoke", "apply", "visit"}));
      if (t->isPointerType()) return !t->getPointeeType().isConstQualified();
      return false;  // a copy
    }  // is_changing_param

    // the role of an access from the nodes around it: a write, a possible write, a check or a read. the mutation
    // analyzer of clang is more exact, but its first use needs the parents of all nodes of the translation unit
    [[nodiscard]] inline AccessRole access_role(const clang::Expr* _e, const clang::ParentMap& _pm,
                                                const int32_t _depth = 0) {
      const auto read    = [&]() -> AccessRole { return {is_in_condition(_e, _pm) ? Role::CHECK : Role::READ, false}; };
      const auto through = [&](const clang::Expr* _result) -> AccessRole {
        // an accessor gives a part of the object: a change of the result changes the object
        if (_depth > 4) return {Role::MAY_WRITE, false};
        const AccessRole r = access_role(_result, _pm, _depth + 1);
        return r.first == Role::WRITE || r.first == Role::MAY_WRITE ? AccessRole{Role::MAY_WRITE, false} : read();
      };
      const clang::Stmt* child = _e;
      const clang::Stmt* p     = _pm.getParent(child);
      while (p && llvm::isa<clang::ImplicitCastExpr, clang::ParenExpr, clang::MaterializeTemporaryExpr,
                            clang::CXXBindTemporaryExpr, clang::ExprWithCleanups>(p)) {
        // a cast that keeps the object, for example to a base class. all other casts read the value
        if (const auto* cast = llvm::dyn_cast<clang::ImplicitCastExpr>(p)) {
          const clang::CastKind k = cast->getCastKind();
          if (k != clang::CK_NoOp && k != clang::CK_DerivedToBase && k != clang::CK_UncheckedDerivedToBase &&
              k != clang::CK_ArrayToPointerDecay)
            return read();
        }
        child = p;
        p     = _pm.getParent(p);
      }
      if (!p) return read();

      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p)) {
        if (b->isAssignmentOp() && b->getLHS() == child) return {Role::WRITE, b->isCompoundAssignmentOp()};
        return read();
      }
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(p)) {
        if (u->isIncrementDecrementOp()) return {Role::WRITE, true};
        if (u->getOpcode() == clang::UO_AddrOf) return through(u);
        return read();
      }
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(p);
          op && op->getNumArgs() > 0 && op->getArg(0) == child) {
        switch (op->getOperator()) {
          case clang::OO_Equal:
            return {Role::WRITE, false};
          case clang::OO_PlusEqual:
          case clang::OO_MinusEqual:
          case clang::OO_StarEqual:
          case clang::OO_SlashEqual:
          case clang::OO_PercentEqual:
          case clang::OO_CaretEqual:
          case clang::OO_AmpEqual:
          case clang::OO_PipeEqual:
          case clang::OO_LessLessEqual:
          case clang::OO_GreaterGreaterEqual:
          case clang::OO_PlusPlus:
          case clang::OO_MinusMinus:
            return {Role::WRITE, true};
          default:
            break;
        }
        // in a template, a dependent operator has no callee. only a stream operator and the operators of an object
        // can change the left operand
        if (!op->getDirectCallee()) {
          const clang::OverloadedOperatorKind k = op->getOperator();
          const bool isChanging = k == clang::OO_LessLess || k == clang::OO_GreaterGreater || k == clang::OO_Call ||
                                  k == clang::OO_Subscript || k == clang::OO_Arrow ||
                                  (op->getNumArgs() == 1 && (k == clang::OO_Star || k == clang::OO_Amp));
          return isChanging ? AccessRole{Role::MAY_WRITE, false} : read();
        }
        const auto* md = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(op->getDirectCallee());
        if (!md) return is_changing_param(op->getDirectCallee(), 0) ? AccessRole{Role::MAY_WRITE, false} : read();
        if (md->isConst()) return read();
        if (is_path_call(op)) return through(op);
        return {Role::MAY_WRITE, false};
      }

      // in a template: a member function of an object of a dependent type. const functions only read the object
      if (const auto* d = llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(p);
          d && !d->isImplicitAccess() && d->getBase() == child) {
        const auto* call = llvm::dyn_cast_or_null<clang::CallExpr>(_pm.getParent(d));
        if (!call) return read();
        const std::vector<const clang::CXXMethodDecl*> methods = dependent_methods(d);
        if (!methods.empty() && llvm::all_of(methods, [](const clang::CXXMethodDecl* _m) { return _m->isConst(); }))
          return read();
        const clang::IdentifierInfo* name = d->getMember().getAsIdentifierInfo();
        if (name && llvm::is_contained({"front", "back", "at", "value", "get", "data", "begin", "end", "find"},
                                       name->getName()))
          return through(call);
        return {Role::MAY_WRITE, false};
      }
      if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(p); m && m->getBase() == child) {
        // a member function of the object
        const auto* md = llvm::dyn_cast<clang::CXXMethodDecl>(m->getMemberDecl());
        if (!md || md->isConst()) return read();
        const auto* call = llvm::dyn_cast_or_null<clang::CXXMemberCallExpr>(_pm.getParent(m));
        if (call && has_name(md, {"front", "back", "at", "value", "get", "data", "begin", "end", "find"}))
          return through(call);
        return {Role::MAY_WRITE, false};
      }
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(p)) {
        const clang::FunctionDecl* fn = call->getDirectCallee();
        const uint32_t first =
            llvm::isa<clang::CXXOperatorCallExpr>(call) && llvm::isa_and_nonnull<clang::CXXMethodDecl>(fn) ? 1 : 0;
        for (uint32_t i = first; i < call->getNumArgs(); ++i)
          if (call->getArg(i) == child) {
            if (fn && is_in_std(fn) && has_name(fn, {"move"})) return through(call);
            if (fn) return is_changing_param(fn, i - first) ? AccessRole{Role::MAY_WRITE, false} : read();

            // in a template, an unresolved call: the candidates of the name decide
            const std::vector<const clang::FunctionDecl*> fns = call_candidates(call);
            const bool isChanging = fns.empty() || llvm::any_of(fns, [&](const clang::FunctionDecl* _f) {
                                      const clang::QualType t = param_type_of(_f, i);
                                      return t.isNull() ? !_f->isVariadic() : is_changing_type(t);
                                    });
            return isChanging ? AccessRole{Role::MAY_WRITE, false} : read();
          }
        return read();
      }
      if (llvm::isa<clang::CXXUnresolvedConstructExpr>(p))
        return read();  // in a template, a conversion or a construction of a dependent type copies its arguments
      if (const auto* ce = llvm::dyn_cast<clang::CXXConstructExpr>(p)) {
        for (uint32_t i = 0; i < ce->getNumArgs(); ++i)
          if (ce->getArg(i) == child)
            return is_changing_param(ce->getConstructor(), i) ? AccessRole{Role::MAY_WRITE, false} : read();
        return read();
      }
      if (const auto* ds = llvm::dyn_cast<clang::DeclStmt>(p)) {
        // a range for loop: the loop variable decides
        if (const auto* loop = llvm::dyn_cast_or_null<clang::CXXForRangeStmt>(_pm.getParent(ds));
            loop && loop->getRangeStmt() == ds) {
          const clang::QualType t = loop->getLoopVariable()->getType();
          return t->isReferenceType() && !t.getNonReferenceType().isConstQualified()
                     ? AccessRole{Role::MAY_WRITE, false}
                     : read();
        }
        // a non-const reference to the object can change it later
        for (const clang::Decl* d : ds->decls())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getInit() == child) {
            const clang::QualType t = v->getType();
            if (t->isReferenceType() && !t.getNonReferenceType().isConstQualified()) return {Role::MAY_WRITE, false};
            if (t->isPointerType() && !t->getPointeeType().isConstQualified() && llvm::isa<clang::UnaryOperator>(child))
              return {Role::MAY_WRITE, false};
          }
        return read();
      }
      return read();
    }  // access_role

    // the place of the name of an access: the last data member or variable of its path
    [[nodiscard]] inline clang::SourceLocation name_loc(const clang::Expr* _e) {
      for (int32_t i = 0; _e && i < 16; ++i) {
        const clang::Expr* e = object_expr(_e);
        if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(e)) return m->getMemberLoc();
        if (const auto* d = llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(e)) return d->getMemberLoc();
        if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(e)) return r->getLocation();
        const auto* call = llvm::dyn_cast<clang::CallExpr>(e);
        if (const clang::CXXDependentScopeMemberExpr* d = call ? dependent_accessor(call) : nullptr)
          _e = d->getBase();
        else if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(e))
          _e = a->getBase();
        else if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(e); op && op->getNumArgs() > 0)
          _e = op->getArg(0);
        else if (const auto* c = llvm::dyn_cast<clang::CXXMemberCallExpr>(e))
          _e = c->getImplicitObjectArgument();
        else if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(e))
          _e = u->getSubExpr();
        else
          return e->getExprLoc();
      }
      return _e ? _e->getExprLoc() : clang::SourceLocation();
    }  // name_loc

    //----------------------------------
    // Locks and conditions

    // the mutexes that lock guards, lock() calls and std::lock hold at a statement, as in locks_at. two expressions
    // name the same mutex if they have the same object path
    [[nodiscard]] inline std::vector<const clang::Expr*> mutexes_at(const clang::Stmt* _s,
                                                                    const clang::ParentMap& _pm) {
      return held_mutexes(_s, _pm, [](const clang::Expr* _a, const clang::Expr* _b) {
        const std::optional<ObjectPath> a = object_path(_a, {});
        const std::optional<ObjectPath> b = object_path(_b, {});
        return a && b ? *a == *b : _a == _b;
      });
    }  // mutexes_at

    // the operands of a chain of &&
    inline void add_conjuncts(const clang::Expr* _e, std::vector<const clang::Expr*>& _out) {
      const clang::Expr* e = _e ? _e->IgnoreParenImpCasts() : nullptr;
      if (const auto* b = llvm::dyn_cast_or_null<clang::BinaryOperator>(e); b && b->getOpcode() == clang::BO_LAnd) {
        add_conjuncts(b->getLHS(), _out);
        add_conjuncts(b->getRHS(), _out);
      } else if (e) {
        _out.push_back(e);
      }
    }  // add_conjuncts

    // EMPTY: no thread of the handle runs. SET: a thread runs, or a future has a value to come. READY: the future has
    // its value, so the callable of the thread returned
    enum class HandleCheck { NONE, EMPTY, SET, READY };

    // a condition that checks an object as a handle: the kind and the object. the caller compares the object with the
    // handles of the threads
    [[nodiscard]] inline std::pair<HandleCheck, std::optional<ObjectPath>> handle_check(const clang::Expr* _e) {
      using Result         = std::pair<HandleCheck, std::optional<ObjectPath>>;
      const Result none    = {HandleCheck::NONE, std::nullopt};
      const clang::Expr* e = object_expr(_e);
      if (!e) return none;
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(e); u && u->getOpcode() == clang::UO_LNot) {
        const auto [kind, path] = handle_check(u->getSubExpr());
        if (kind == HandleCheck::SET) return {HandleCheck::EMPTY, path};
        if (kind == HandleCheck::EMPTY) return {HandleCheck::SET, path};
        return none;
      }

      // a comparison with nullptr or std::nullopt, and wait_for(...) == std::future_status::ready
      const auto compare = [&](const clang::Expr* _l, const clang::Expr* _r, const bool _isEq) -> Result {
        for (int32_t i = 0; i < 2; ++i, std::swap(_l, _r)) {
          const clang::Expr* r           = object_expr(_r);
          const clang::CXXRecordDecl* rd = r ? record_of(r->getType()) : nullptr;
          if (r && (llvm::isa<clang::CXXNullPtrLiteralExpr, clang::GNUNullExpr>(r) || has_name(rd, {"nullopt_t"})))
            if (auto p = object_path(_l, {})) return {_isEq ? HandleCheck::EMPTY : HandleCheck::SET, p};
          const auto* ref  = llvm::dyn_cast_or_null<clang::DeclRefExpr>(r);
          const auto* call = llvm::dyn_cast_or_null<clang::CXXMemberCallExpr>(object_expr(_l));
          if (_isEq && ref && llvm::isa<clang::EnumConstantDecl>(ref->getDecl()) &&
              has_name(ref->getDecl(), {"ready"}) && call &&
              has_name(call->getMethodDecl(), {"wait_for", "wait_until"}))
            if (auto p = object_path(call->getImplicitObjectArgument(), {})) return {HandleCheck::READY, p};
        }
        return none;
      };
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(e); b && b->isEqualityOp())
        return compare(b->getLHS(), b->getRHS(), b->getOpcode() == clang::BO_EQ);
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(e);
          op && op->getNumArgs() == 2 &&
          (op->getOperator() == clang::OO_EqualEqual || op->getOperator() == clang::OO_ExclaimEqual))
        return compare(op->getArg(0), op->getArg(1), op->getOperator() == clang::OO_EqualEqual);

      if (const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(e)) {
        const clang::CXXMethodDecl* md = call->getMethodDecl();
        auto p                         = object_path(call->getImplicitObjectArgument(), {});
        if (!p) return none;
        if (has_name(md, {"valid", "joinable", "has_value", "isRunning"})) return {HandleCheck::SET, p};
        if (has_name(md, {"is_ready", "isReady", "isFinished", "ready"})) return {HandleCheck::READY, p};
        return none;
      }

      // the handle as a condition: a set optional or a valid pointer
      if (auto p = object_path(e, {})) return {HandleCheck::SET, p};
      return none;
    }  // handle_check

    //----------------------------------
    // Order of statements

    // the statement and its parents in the function, from the statement up
    [[nodiscard]] inline std::vector<const clang::Stmt*> parents_up(const clang::Stmt* _s,
                                                                    const clang::ParentMap& _pm) {
      std::vector<const clang::Stmt*> out;
      for (const clang::Stmt* s = _s; s; s = _pm.getParent(s)) out.push_back(s);
      return out;
    }  // parents_up

    // true if the statement runs in each run of _top: no branch, no loop body and no lambda between them
    [[nodiscard]] inline bool is_unconditional(const clang::Stmt* _s, const clang::Stmt* _top,
                                               const clang::ParentMap& _pm) {
      for (const clang::Stmt* c = _s; c && c != _top;) {
        const clang::Stmt* p = _pm.getParent(c);
        if (!p) return false;
        if (const auto* s = llvm::dyn_cast<clang::IfStmt>(p)) {
          if (c == s->getThen() || c == s->getElse()) return false;
        } else if (const auto* s = llvm::dyn_cast<clang::ForStmt>(p)) {
          if (c != s->getInit()) return false;
        } else if (const auto* s = llvm::dyn_cast<clang::WhileStmt>(p)) {
          if (c != s->getCond()) return false;
        } else if (const auto* s = llvm::dyn_cast<clang::CXXForRangeStmt>(p)) {
          if (c != s->getRangeStmt() && c != s->getInit()) return false;
        } else if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(p)) {
          if (c == s->getBody()) return false;
        } else if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p)) {
          if (b->isLogicalOp() && c == b->getRHS()) return false;
        } else if (const auto* co = llvm::dyn_cast<clang::AbstractConditionalOperator>(p)) {
          if (c != co->getCond()) return false;
        } else if (llvm::isa<clang::LambdaExpr, clang::CXXCatchStmt, clang::SwitchCase>(p)) {
          return false;
        }
        c = p;
      }
      return true;
    }  // is_unconditional

    // true if a join runs in each run of _top in which the handle has a thread: no branch between them, except a check
    // of the same handle, for example if (t.joinable()) t.join()
    [[nodiscard]] inline bool is_join_unconditional(const clang::Stmt* _s, const clang::Stmt* _top,
                                                    const ObjectPath& _handle, const clang::ParentMap& _pm) {
      for (const clang::Stmt* c = _s; c && c != _top;) {
        const clang::Stmt* p = _pm.getParent(c);
        if (!p) return false;
        const auto* s     = llvm::dyn_cast<clang::IfStmt>(p);
        const bool isTest = s && c == s->getThen() && !s->getInit() && !s->getConditionVariable() && [&]() -> bool {
          const auto [kind, path] = handle_check(s->getCond());
          return kind == HandleCheck::SET && path && *path == _handle;
        }();
        if (!isTest && !is_unconditional(c, p, _pm)) return false;
        c = p;
      }
      return true;
    }  // is_join_unconditional

    // a path in the terms of a called function in the terms of the caller: a parameter and this get the objects of the
    // call. a global stays. nullopt for a local variable of the called function, or a parameter with no object
    [[nodiscard]] inline std::optional<ObjectPath> rebased(const ObjectPath& _p, const Subst& _subst) {
      for (const auto& [key, path] : _subst)
        if (key == _p.root_) {
          ObjectPath out = path;
          out.steps_.insert(out.steps_.end(), _p.steps_.begin(), _p.steps_.end());
          return out;
        }
      const auto* v = llvm::dyn_cast_or_null<clang::VarDecl>(_p.root_);
      if (!_p.isThis_ && v && v->hasGlobalStorage()) return _p;
      return std::nullopt;
    }  // rebased

    // the innermost statement that contains two statements, and its children that contain them
    struct Precedence {
      const clang::Stmt* lca_ = nullptr;
      const clang::Stmt* ca_  = nullptr;
      const clang::Stmt* cb_  = nullptr;
    };  // Precedence

    // _a runs before _b in each run that runs both: _a is in an earlier statement of a block, in the condition of an if
    // and _b in a branch, or on the left of && or || and _b on the right. nullopt if it does not
    [[nodiscard]] inline std::optional<Precedence> precedes(const clang::Stmt* _a, const clang::Stmt* _b,
                                                            const clang::ParentMap& _pm) {
      const std::vector<const clang::Stmt*> as = parents_up(_a, _pm);
      const std::vector<const clang::Stmt*> bs = parents_up(_b, _pm);
      for (size_t i = 1; i < as.size(); ++i) {
        const auto it = std::ranges::find(bs, as[i]);
        if (it == bs.end()) continue;
        if (it == bs.begin()) return std::nullopt;  // _b contains _a
        const Precedence out{as[i], as[i - 1], *(it - 1)};

        bool isBefore = false;
        if (const auto* cs = llvm::dyn_cast<clang::CompoundStmt>(out.lca_)) {
          for (const clang::Stmt* s : cs->body()) {
            if (s == out.cb_) break;
            if (s == out.ca_) {
              isBefore = true;
              break;
            }
          }
        } else if (const auto* s = llvm::dyn_cast<clang::IfStmt>(out.lca_)) {
          const bool isHead =
              out.ca_ == s->getInit() || out.ca_ == s->getConditionVariableDeclStmt() || out.ca_ == s->getCond();
          isBefore = isHead && (out.cb_ == s->getThen() || out.cb_ == s->getElse() || out.ca_ == s->getInit());
        } else if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(out.lca_)) {
          isBefore = (b->isLogicalOp() || b->getOpcode() == clang::BO_Comma) && out.ca_ == b->getLHS() &&
                     out.cb_ == b->getRHS();
        } else if (const auto* co = llvm::dyn_cast<clang::AbstractConditionalOperator>(out.lca_)) {
          isBefore = out.ca_ == co->getCond();
        } else if (const auto* ds = llvm::dyn_cast<clang::DeclStmt>(out.lca_)) {
          for (const clang::Stmt* s : ds->children()) {
            if (s == out.cb_) break;
            if (s == out.ca_) {
              isBefore = true;
              break;
            }
          }
        } else if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(out.lca_)) {
          isBefore = out.cb_ == s->getBody() && out.ca_ != s->getBody();
        }
        if (!isBefore) return std::nullopt;
        return out;
      }
      return std::nullopt;
    }  // precedes

    // the innermost loop around a statement in its body, or null
    [[nodiscard]] inline const clang::Stmt* loop_around(const clang::Stmt* _s, const clang::ParentMap& _pm) {
      for (const clang::Stmt* p = _pm.getParent(_s); p; p = _pm.getParent(p)) {
        if (llvm::isa<clang::ForStmt, clang::WhileStmt, clang::DoStmt, clang::CXXForRangeStmt>(p)) return p;
        if (llvm::isa<clang::LambdaExpr>(p)) return nullptr;
      }
      return nullptr;
    }  // loop_around

    // the range for loop around a statement that has the variable as its loop variable, or null
    [[nodiscard]] inline const clang::CXXForRangeStmt* range_loop_of(const clang::Decl* _var, const clang::Stmt* _s,
                                                                     const clang::ParentMap& _pm) {
      for (const clang::Stmt* p = _pm.getParent(_s); p; p = _pm.getParent(p)) {
        if (const auto* loop = llvm::dyn_cast<clang::CXXForRangeStmt>(p); loop && loop->getLoopVariable() == _var)
          return loop;
        if (llvm::isa<clang::LambdaExpr>(p)) return nullptr;
      }
      return nullptr;
    }  // range_loop_of

    template <class T>
    [[nodiscard]] inline std::vector<T> merged(std::vector<T> _a, const std::vector<T>& _b) {
      _a.insert(_a.end(), _b.begin(), _b.end());
      std::ranges::sort(_a);
      _a.erase(std::unique(_a.begin(), _a.end()), _a.end());
      return _a;
    }  // merged

    [[nodiscard]] inline ThreadsOrder merged(const ThreadsOrder& _a, const ThreadsOrder& _b) {
      return ThreadsOrder{merged(_a.after_, _b.after_), merged(_a.before_, _b.before_), merged(_a.empty_, _b.empty_),
                          merged(_a.ready_, _b.ready_)};
    }  // merged

    // the order that stays true later: a join and a ready future. code that runs later, for example a new thread or a
    // lambda that a call keeps, can run after the start of a thread and while the handle is set
    [[nodiscard]] inline ThreadsOrder lasting(ThreadsOrder _o) {
      _o.before_.clear();
      _o.empty_.clear();
      return _o;
    }  // lasting

    // the inner conditions first, then the outer conditions, each one time
    [[nodiscard]] inline std::vector<ThreadsGuard> merged_guards(const std::vector<ThreadsGuard>& _inner,
                                                                 const std::vector<ThreadsGuard>& _outer) {
      std::vector<ThreadsGuard> out;
      for (const std::vector<ThreadsGuard>* list : {&_inner, &_outer})
        for (const ThreadsGuard& g : *list)
          if (out.size() < threads_max_guards && !llvm::is_contained(out, g)) out.push_back(g);
      return out;
    }  // merged_guards

    // the constructor that std::make_unique, std::make_shared or std::allocate_shared calls. the walk looks for the
    // construction of the type in the instantiation, and in the functions of std that it calls. null for other calls
    [[nodiscard]] inline const clang::CXXConstructorDecl* constructor_of(const clang::CallExpr* _c) {
      const clang::FunctionDecl* fn = _c->getDirectCallee();
      if (!fn || !is_in_std(fn) || !has_name(fn, {"make_unique", "make_shared", "allocate_shared"})) return nullptr;
      const clang::TemplateArgumentList* args = fn->getTemplateSpecializationArgs();
      if (!args || args->size() == 0 || args->get(0).getKind() != clang::TemplateArgument::Type) return nullptr;
      const clang::CXXRecordDecl* rd = record_of(args->get(0).getAsType());
      if (!rd) return nullptr;
      rd = rd->getCanonicalDecl();

      std::vector<const clang::FunctionDecl*> todo{fn};
      for (size_t i = 0; i < todo.size() && i < 16; ++i) {
        std::vector<const clang::Stmt*> stack{todo[i]->getBody()};
        if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(todo[i]))
          for (const clang::CXXCtorInitializer* init : ctor->inits()) stack.push_back(init->getInit());
        while (!stack.empty()) {
          const clang::Stmt* s = stack.back();
          stack.pop_back();
          if (!s) continue;
          if (const auto* ce = llvm::dyn_cast<clang::CXXConstructExpr>(s); ce && ce->getConstructor()) {
            const clang::CXXRecordDecl* t = record_of(ce->getType());
            if (t && t->getCanonicalDecl() == rd) return ce->getConstructor();
            if (is_in_std(ce->getConstructor()) && !llvm::is_contained(todo, ce->getConstructor()))
              todo.push_back(ce->getConstructor());
          } else if (const auto* call = llvm::dyn_cast<clang::CallExpr>(s)) {
            const clang::FunctionDecl* callee = call->getDirectCallee();
            if (callee && is_in_std(callee) && !llvm::is_contained(todo, callee)) todo.push_back(callee);
          }
          for (const clang::Stmt* child : s->children()) stack.push_back(child);
        }
      }
      return nullptr;
    }  // constructor_of

    // the class that the destruction of an object of the type destroys: the type, the value of std::unique_ptr or
    // std::optional, or the element of an array or of a container of std. true for an element. null for other types
    [[nodiscard]] inline std::pair<const clang::CXXRecordDecl*, bool> destroyed_class(clang::QualType _t) {
      bool isElement = false;
      for (int32_t i = 0; i < 4 && !_t.isNull(); ++i) {
        if (const clang::ArrayType* a = _t->getAsArrayTypeUnsafe()) {
          _t        = a->getElementType();
          isElement = true;
          continue;
        }
        const clang::CXXRecordDecl* rd = record_of(_t);
        if (!rd) return {nullptr, false};
        const auto* spec   = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(rd);
        const bool isOwner = is_in_std(rd) && spec && spec->getTemplateArgs().size() > 0 &&
                             spec->getTemplateArgs()[0].getKind() == clang::TemplateArgument::Type;
        if (isOwner && has_name(rd, {"unique_ptr", "optional"})) {
          _t = spec->getTemplateArgs()[0].getAsType();
          continue;
        }
        if (isOwner && has_name(rd, {"vector", "array", "deque", "list", "forward_list"})) {
          _t        = spec->getTemplateArgs()[0].getAsType();
          isElement = true;
          continue;
        }
        return {rd, isElement};
      }
      return {nullptr, false};
    }  // destroyed_class

    // the nodes of a body that the walk needs. a lambda in the body is a body of its own
    class ThreadsScanner : public clang::RecursiveASTVisitor<ThreadsScanner> {
     public:
      std::vector<const clang::Expr*> objects_;  // the expressions of objects. the analysis keeps the outermost steps
      std::vector<const clang::CallExpr*> calls_;
      std::vector<const clang::Expr*> starts_;                  // the calls and constructions that can start a thread
      std::vector<const clang::CXXConstructExpr*> constructs_;  // the constructions with a constructor of the user
      std::vector<const clang::LambdaExpr*> lambdas_;
      std::vector<const clang::DeclStmt*> decls_;
      std::vector<const clang::CXXDeleteExpr*> deletes_;
      std::unordered_set<const clang::Expr*> refBinds_;  // the objects of the captures by reference with an initializer

      // a capture by copy reads the variable when the lambda starts. a capture by reference does not use the variable,
      // and a capture by reference with an initializer, for example [&srv = _srv], only names its object
      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        lambdas_.push_back(_e);
        for (const auto [capture, init] : llvm::zip(_e->captures(), _e->capture_inits())) {
          if (capture.getCaptureKind() == clang::LCK_ByRef && !_e->isInitCapture(&capture)) continue;
          if (init && capture.getCaptureKind() == clang::LCK_ByRef) refBinds_.insert(object_expr(init));
          if (init && !TraverseStmt(init)) return false;
        }
        return true;
      }  // TraverseLambdaExpr

      bool VisitExpr(clang::Expr* _e) {
        if (llvm::isa<clang::DeclRefExpr, clang::MemberExpr, clang::ArraySubscriptExpr>(_e) || is_path_call(_e) ||
            dependent_field(llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(_e)))
          objects_.push_back(_e);
        if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_e); c && called_function(c)) calls_.push_back(c);
        if (llvm::isa<clang::CallExpr, clang::CXXConstructExpr>(_e)) starts_.push_back(_e);
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(_e);
            c && c->getConstructor() && c->getConstructor()->isUserProvided())
          constructs_.push_back(c);
        if (const auto* d = llvm::dyn_cast<clang::CXXDeleteExpr>(_e)) deletes_.push_back(d);
        return true;
      }  // VisitExpr

      bool VisitDeclStmt(clang::DeclStmt* _s) {
        decls_.push_back(_s);
        return true;
      }  // VisitDeclStmt
    };  // ThreadsScanner

    //----------------------------------
    // Analysis

    class ThreadsAnalysis {
      // the context of a visit of a body
      struct Ctx {
        int32_t thread_ = -1;
        Subst subst_;
        std::vector<std::string> locks_;
        ThreadsOrder order_;
        std::vector<ThreadsGuard> guards_;
        std::vector<ThreadsVia> via_;
      };  // Ctx

      // an access before the selection of the items: the analysis completes only the accesses of the shared items
      struct RawAccess {
        const clang::Expr* expr_ = nullptr;
        int32_t body_            = -1;
        int32_t ctx_             = -1;
        std::string path_;
        std::vector<std::string> sub_;
        bool isWhole_  = false;
        bool isAtomic_ = false;
      };  // RawAccess

      struct RawItem {
        ThreadsItem item_;
        std::vector<RawAccess> raw_;
      };  // RawItem

      // a construction of an object with a constructor of the user: a construct expression, or a call of
      // std::make_unique or std::make_shared
      struct Construction {
        const clang::Expr* at_                 = nullptr;
        const clang::CXXConstructorDecl* ctor_ = nullptr;
      };  // Construction

      // an implicit call of a destructor: at the end of the block of a local object, at the end of a destructor for the
      // data members and the base classes, and at a delete or at reset() of std::unique_ptr or std::optional. the
      // destructor of std::jthread joins, and the destructor of the future of std::async waits
      struct Destruction {
        const clang::Stmt* at_                = nullptr;
        const clang::Stmt* place_             = nullptr;  // the declaration of the object, the body or the call
        bool isAtEnd_                         = false;    // the destructor runs at the end of at_
        const clang::CXXDestructorDecl* dtor_ = nullptr;  // a destructor of the user, or null
        std::string kind_;                                // for example ~Worker, ~jthread or ~future
        const clang::Expr* objectExpr_ = nullptr;         // the object of a delete or of reset()
        ObjectPath object_;  // the object in the terms of the body. with objectExpr_, only the steps after it
      };  // Destruction

      struct BodyData {
        std::vector<const clang::Expr*> objects_;
        std::vector<const clang::CallExpr*> calls_;
        std::vector<Construction> constructs_;
        std::vector<Destruction> dtors_;
        std::vector<const clang::Expr*> starts_;  // the expressions that can start a thread
        std::vector<int32_t> lambdas_;            // the bodies of the lambdas in the body
        std::vector<int32_t> functionStarts_;     // the threads that run a function, started in the body
      };  // BodyData

      // the handle of a thread in the terms of a body, and the start or the call in the body that gives it
      struct ThreadHandle {
        ObjectPath path_;
        int32_t thread_        = -1;
        const clang::Stmt* at_ = nullptr;
      };  // ThreadHandle

      clang::ASTContext& ctx_;
      const clang::SourceManager& sm_;
      const ThreadsOptions& opts_;
      const MemberOptions memberOpts_;
      ThreadsModel& model_;

      std::vector<BodyData> data_;
      std::unordered_map<const clang::FunctionDecl*, int32_t> bodyOf_;          // the canonical declaration -> the body
      std::unordered_map<int32_t, std::unique_ptr<clang::ParentMap>> parents_;  // the body of a function -> its map
      std::unordered_map<int32_t, int32_t> threadOfLambda_;  // the body of a lambda -> the thread that runs it
      std::unordered_map<const clang::LambdaExpr*, int32_t> lambdaBody_;
      std::unordered_set<const clang::Expr*> bound_;  // the arguments that a called body gets by reference
      std::unordered_set<const clang::VarDecl*> captured_;
      std::unordered_set<const clang::VarDecl*> shared_;  // the local objects that a thread uses through a call
      llvm::DenseMap<clang::FileID, bool> projectFiles_;

      std::vector<Ctx> ctxs_;
      std::unordered_set<std::string> seen_;
      int32_t visits_  = 0;
      size_t rawCount_ = 0;
      std::vector<RawItem> items_;
      std::unordered_map<std::string, size_t> itemIndex_;
      std::unordered_map<const clang::Stmt*, ThreadsOrder> orders_;
      std::unordered_map<const clang::Expr*, AccessRole> roles_;
      std::vector<std::vector<ThreadHandle>> handles_;  // the handles of the threads in the terms of each body
      std::vector<std::vector<ThreadsJoin>> bodyJoins_;  // the joins of each body in its terms, also of calls

     public:
      ThreadsAnalysis(clang::ASTContext& _ctx, const ThreadsOptions& _opts, ThreadsModel& _model)
          : ctx_(_ctx),
            sm_(_ctx.getSourceManager()),
            opts_(_opts),
            memberOpts_{_opts.async_functions_},
            model_(_model) {}

      void run(const std::vector<const clang::FunctionDecl*>& _fns) {
        using Clock   = std::chrono::steady_clock;
        const auto ms = [](const Clock::time_point _from) {
          return std::chrono::duration<double, std::milli>(Clock::now() - _from).count();
        };
        Clock::time_point start = Clock::now();
        for (const clang::FunctionDecl* f : _fns) add_function(f);
        add_header_functions();
        find_threads();
        model_.scanMs_ = ms(start);
        if (model_.threads_.empty()) return;
        start = Clock::now();
        find_joins();
        for (int32_t t = 0; t < int32_t(model_.threads_.size()); ++t) set_thread_kind(t);
        find_captures();
        find_bound();
        find_shared();
        model_.prepareMs_ = ms(start);
        start             = Clock::now();
        walk();
        model_.walkMs_      = ms(start);
        model_.visits_      = visits_;
        model_.rawAccesses_ = rawCount_;
        start               = Clock::now();
        finish();
        model_.finishMs_ = ms(start);
      }  // run

     private:
      [[nodiscard]] const clang::ParentMap& parents(const int32_t _b) const {
        return *parents_.at(model_.bodies_[_b].root_);
      }  // parents

      [[nodiscard]] const clang::Stmt* body_stmt(const int32_t _b) const {
        const ThreadsBody& b = model_.bodies_[_b];
        return b.lambda_ ? b.lambda_->getBody() : b.fn_->getBody();
      }  // body_stmt

      [[nodiscard]] bool is_constructor(const int32_t _b) const {
        return llvm::isa<clang::CXXConstructorDecl>(model_.bodies_[model_.bodies_[_b].root_].fn_);
      }  // is_constructor

      [[nodiscard]] bool is_before(const clang::Stmt* _a, const clang::Stmt* _b) const {
        return sm_.isBeforeInTranslationUnit(sm_.getExpansionLoc(_a->getBeginLoc()),
                                             sm_.getExpansionLoc(_b->getBeginLoc()));
      }  // is_before

      // true if the join comes before the statement in the source. a join at the end of a block comes at its end
      [[nodiscard]] bool is_join_before(const ThreadsJoin& _j, const clang::Stmt* _s) const {
        const clang::SourceLocation at = _j.isAtEnd_ ? _j.at_->getEndLoc() : _j.at_->getBeginLoc();
        return sm_.isBeforeInTranslationUnit(sm_.getExpansionLoc(at), sm_.getExpansionLoc(_s->getBeginLoc()));
      }  // is_join_before

      //----------------------------------
      // Bodies

      int32_t add_function(const clang::FunctionDecl* _fn) {
        const auto [it, isNew] = bodyOf_.try_emplace(_fn->getCanonicalDecl(), int32_t(model_.bodies_.size()));
        if (!isNew) return it->second;
        const int32_t b = int32_t(model_.bodies_.size());
        model_.bodies_.push_back(ThreadsBody{_fn, nullptr, -1, b, {}});
        data_.emplace_back();
        parents_[b] = parents_of(*_fn);
        scan(b);
        return b;
      }  // add_function

      // collects the nodes of a body, and adds its lambdas as bodies
      void scan(const int32_t _b) {
        const ThreadsBody body = model_.bodies_[_b];  // a copy: the lambdas add bodies
        ThreadsScanner scanner;
        if (body.lambda_) {
          scanner.TraverseStmt(body.lambda_->getBody());
        } else {
          scanner.TraverseStmt(body.fn_->getBody());
          if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(body.fn_))
            for (const clang::CXXCtorInitializer* init : ctor->inits())
              if (init->isWritten() && init->getInit()) scanner.TraverseStmt(init->getInit());
        }

        const clang::ParentMap& pm = parents(_b);
        std::vector<const clang::Expr*> objects;
        for (const clang::Expr* e : scanner.objects_)
          if (!is_inner_step(e, pm) && !scanner.refBinds_.contains(e)) objects.push_back(e);
        std::vector<const clang::Expr*> starts;
        for (const clang::Expr* e : scanner.starts_)
          if (!start_name(e, memberOpts_).empty()) starts.push_back(e);
        std::vector<Construction> constructs;
        for (const clang::CXXConstructExpr* c : scanner.constructs_) constructs.push_back({c, c->getConstructor()});
        for (const clang::CallExpr* c : scanner.calls_)
          if (const clang::CXXConstructorDecl* ctor = constructor_of(c)) constructs.push_back({c, ctor});

        std::vector<int32_t> lambdas;
        for (const clang::LambdaExpr* l : scanner.lambdas_) {
          const int32_t lb = int32_t(model_.bodies_.size());
          model_.bodies_.push_back(ThreadsBody{l->getCallOperator(), l, _b, body.root_, {}});
          data_.emplace_back();
          bodyOf_.try_emplace(l->getCallOperator()->getCanonicalDecl(),
                              lb);  // a call through a variable runs the lambda
          lambdaBody_[l] = lb;
          lambdas.push_back(lb);
          scan(lb);
        }
        data_[_b].dtors_      = destructions(_b, scanner);
        data_[_b].objects_    = std::move(objects);
        data_[_b].calls_      = std::move(scanner.calls_);
        data_[_b].constructs_ = std::move(constructs);
        data_[_b].starts_     = std::move(starts);
        data_[_b].lambdas_    = std::move(lambdas);
      }  // scan

      // the implicit calls of destructors in a body
      [[nodiscard]] std::vector<Destruction> destructions(const int32_t _b, const ThreadsScanner& _scanner) const {
        std::vector<Destruction> out;
        const clang::ParentMap& pm = parents(_b);
        const ThreadsBody& body    = model_.bodies_[_b];

        // a local object that std::move, std::forward, std::swap or std::exchange gives away. its destructor does not
        // end the thread
        std::unordered_set<const clang::Decl*> moved;
        for (const clang::CallExpr* c : _scanner.calls_) {
          const clang::FunctionDecl* fn = c->getDirectCallee();
          if (!fn || !is_in_std(fn) || !has_name(fn, {"move", "forward", "swap", "exchange"})) continue;
          for (const clang::Expr* a : c->arguments())
            if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(object_expr(a))) moved.insert(ref->getDecl());
        }

        // the local objects at the end of their block, or of the statement with their declaration
        for (const clang::DeclStmt* ds : _scanner.decls_) {
          const clang::Stmt* scope = pm.getParent(ds);
          bool isScope             = llvm::isa_and_nonnull<clang::CompoundStmt>(scope);
          if (const auto* s = llvm::dyn_cast_or_null<clang::IfStmt>(scope))
            isScope = ds == s->getInit() || ds == s->getConditionVariableDeclStmt();
          else if (const auto* s = llvm::dyn_cast_or_null<clang::SwitchStmt>(scope))
            isScope = ds == s->getInit() || ds == s->getConditionVariableDeclStmt();
          else if (const auto* s = llvm::dyn_cast_or_null<clang::ForStmt>(scope))
            isScope = ds == s->getInit();
          else if (const auto* s = llvm::dyn_cast_or_null<clang::CXXForRangeStmt>(scope))
            isScope = ds == s->getInit();
          if (!isScope) continue;
          for (const clang::Decl* d : ds->decls()) {
            const auto* v = llvm::dyn_cast<clang::VarDecl>(d);
            if (!v || !v->hasLocalStorage() || v->getType()->isReferenceType() || v->isNRVOVariable() ||
                moved.contains(v))
              continue;
            add_destroyed(out, Destruction{scope, ds, true, nullptr, {}, nullptr, ObjectPath{v, false, {}}},
                          v->getType(), 0);
          }
        }

        // the data members and the base classes at the end of a destructor, in the reverse sequence
        if (const auto* dtor = llvm::dyn_cast<clang::CXXDestructorDecl>(body.fn_); dtor && !body.lambda_) {
          const clang::CXXRecordDecl* rd = dtor->getParent();
          const clang::Stmt* end         = body_stmt(_b);
          const ObjectPath self{rd->getCanonicalDecl(), true, {}};
          const std::vector<const clang::FieldDecl*> fields(rd->field_begin(), rd->field_end());
          for (auto it = fields.rbegin(); it != fields.rend(); ++it) {
            if ((*it)->getType()->isReferenceType()) continue;
            Destruction d{end, end, true, nullptr, {}, nullptr, self};
            d.object_.steps_.push_back(pattern_field(*it));
            add_destroyed(out, std::move(d), (*it)->getType(), 0);
          }
          for (const clang::CXXBaseSpecifier& base : llvm::reverse(rd->bases()))
            add_destroyed(out, Destruction{end, end, true, nullptr, {}, nullptr, self}, base.getType(), 0);
        }

        // delete, and reset() of std::unique_ptr or std::optional
        for (const clang::CXXDeleteExpr* d : _scanner.deletes_) {
          ObjectPath element;
          if (d->isArrayForm()) element.steps_.push_back(nullptr);
          add_destroyed(out, Destruction{d, d, false, nullptr, {}, d->getArgument(), std::move(element)},
                        d->getDestroyedType(), 0);
        }
        for (const clang::CallExpr* c : _scanner.calls_) {
          const auto* m = llvm::dyn_cast<clang::CXXMemberCallExpr>(c);
          if (!m || !has_name(m->getMethodDecl(), {"reset"}) || !is_in_std(m->getMethodDecl()) ||
              !has_name(m->getRecordDecl(), {"unique_ptr", "optional"}))
            continue;
          const clang::Expr* object = m->getImplicitObjectArgument();
          clang::QualType t         = object->getType();
          if (t->isPointerType()) t = t->getPointeeType();
          add_destroyed(out, Destruction{c, c, false, nullptr, {}, object, {}}, t, 0);
        }
        return out;
      }  // destructions

      // adds the destruction of an object of the type: the destructor of the user, the destructor of std::jthread or
      // of std::future, or for a destructor of the compiler the destructions of the data members and the base classes
      void add_destroyed(std::vector<Destruction>& _out, Destruction _d, const clang::QualType _t,
                         const int32_t _depth) const {
        const auto [found, isElement]  = destroyed_class(_t);
        const clang::CXXRecordDecl* rd = found ? found->getDefinition() : nullptr;
        if (!rd || _depth > 4) return;

        // a thread or a future in a container: the handle is the container
        if (is_in_std(rd) && has_name(rd, {"jthread", "future"})) {
          _d.kind_ = "~" + rd->getNameAsString();
          _out.push_back(std::move(_d));
          return;
        }
        if (is_in_std(rd) || sm_.isInSystemHeader(rd->getLocation())) return;
        if (isElement) _d.object_.steps_.push_back(nullptr);
        if (const clang::CXXDestructorDecl* dtor = rd->getDestructor(); dtor && dtor->isUserProvided()) {
          _d.dtor_ = dtor;
          _d.kind_ = "~" + rd->getNameAsString();
          _out.push_back(std::move(_d));
          return;
        }
        if (rd->hasTrivialDestructor()) return;

        // the destructor of the compiler destroys the data members and the base classes
        const std::vector<const clang::FieldDecl*> fields(rd->field_begin(), rd->field_end());
        for (auto it = fields.rbegin(); it != fields.rend(); ++it) {
          if ((*it)->getType()->isReferenceType()) continue;
          Destruction d = _d;
          d.object_.steps_.push_back(pattern_field(*it));
          add_destroyed(_out, std::move(d), (*it)->getType(), _depth + 1);
        }
        for (const clang::CXXBaseSpecifier& base : llvm::reverse(rd->bases()))
          add_destroyed(_out, _d, base.getType(), _depth + 1);
      }  // add_destroyed

      // the object of a destruction in the terms of a context: this gets the object of the context
      [[nodiscard]] static std::optional<ObjectPath> destroyed_object(const Destruction& _d, const Subst& _subst) {
        const std::vector<const clang::FieldDecl*>& steps = _d.object_.steps_;
        if (_d.objectExpr_) {
          std::optional<ObjectPath> out = object_path(_d.objectExpr_, _subst);
          if (out) out->steps_.insert(out->steps_.end(), steps.begin(), steps.end());
          return out;
        }
        if (_d.object_.isThis_)
          for (const auto& [key, path] : _subst)
            if (key == _d.object_.root_) {
              ObjectPath out = path;
              out.steps_.insert(out.steps_.end(), steps.begin(), steps.end());
              return out;
            }
        return _d.object_;
      }  // destroyed_object

      // the functions and the constructors of the project headers that the bodies call
      void add_header_functions() {
        size_t added = 0;
        for (int32_t b = 0; b < int32_t(model_.bodies_.size()); ++b) {
          std::vector<const clang::FunctionDecl*> callees;  // a copy: new bodies change data_
          for (const clang::CallExpr* c : data_[b].calls_) callees.push_back(called_function(c));
          for (const Construction& c : data_[b].constructs_) callees.push_back(c.ctor_);
          for (const Destruction& d : data_[b].dtors_)
            if (d.dtor_) callees.push_back(d.dtor_);
          for (const clang::FunctionDecl* fn : callees) {
            if (const clang::FunctionDecl* p = fn->getTemplateInstantiationPattern()) fn = p;
            const clang::FunctionDecl* def = nullptr;
            if (!fn->isDefined(def) || !def || def->isImplicit() || !def->doesThisDeclarationHaveABody() ||
                bodyOf_.contains(def->getCanonicalDecl()))
              continue;
            if (!is_project_function(def)) continue;
            if (added >= threads_max_headers) {
              model_.isTruncated_ = true;
              return;
            }
            add_function(def);
            ++added;
          }
        }
      }  // add_header_functions

      // the body of a called function, or -1 if it is not a part of the analysis
      [[nodiscard]] int32_t resolve(const clang::FunctionDecl* _fn) const {
        if (!_fn) return -1;
        if (const clang::FunctionDecl* p = _fn->getTemplateInstantiationPattern()) _fn = p;
        const auto it = bodyOf_.find(_fn->getCanonicalDecl());
        return it == bodyOf_.end() ? -1 : it->second;
      }  // resolve

      // true for a function in a project header: not the main file, not std and not a system header, and in a folder
      // of the project. the answer for each file stays in a map
      [[nodiscard]] bool is_project_function(const clang::FunctionDecl* _fn) {
        const clang::SourceLocation at = sm_.getFileLoc(_fn->getLocation());
        if (sm_.isInMainFile(at) || sm_.isInSystemHeader(at) || is_in_std(_fn)) return false;
        const auto [it, isNew] = projectFiles_.try_emplace(sm_.getFileID(at), false);
        if (isNew) it->second = std::string_view(call_place(*_fn, sm_, opts_.roots_)) == "project";
        return it->second;
      }  // is_project_function

      //----------------------------------
      // Threads

      [[nodiscard]] static std::vector<const clang::Expr*> arguments_of(const clang::Expr* _e) {
        std::vector<const clang::Expr*> out;
        if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_e)) out.assign(c->arg_begin(), c->arg_end());
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(_e)) out.assign(c->arg_begin(), c->arg_end());
        return out;
      }  // arguments_of

      int32_t add_thread(const clang::Expr* _at, const int32_t _body, const int32_t _runs, std::string _via,
                         std::string _name) {
        ThreadsStart s;
        s.at_   = _at;
        s.body_ = _body;
        s.runs_ = _runs;
        s.via_  = std::move(_via);
        s.name_ = std::move(_name);
        if (_at && _body >= 0) s.handle_ = handle_of(_at, _body);
        if (s.handle_) s.handleText_ = object_text(*s.handle_, s.handle_->steps_.size());
        model_.threads_.push_back(std::move(s));
        return int32_t(model_.threads_.size()) - 1;
      }  // add_thread

      // the starts: a lambda that a thread start gets, a function that a thread start gets, and QThread::run
      void find_threads() {
        for (int32_t b = 0; b < int32_t(model_.bodies_.size()); ++b) {
          const ThreadsBody body = model_.bodies_[b];  // a copy: a function start can add a body
          if (body.lambda_ && body.outer_ >= 0) {
            const clang::Expr* call = call_of_lambda(body.lambda_, parents(b));
            std::string via         = start_name(call, memberOpts_);
            if (!via.empty()) threadOfLambda_[b] = add_thread(call, body.outer_, b, std::move(via), "lambda");
          }
          for (const clang::Expr* e : std::vector(data_[b].starts_)) {
            for (const clang::Expr* a : arguments_of(e)) {
              // a variable with a lambda, as in auto worker = [&](int i) { ... }; threads.emplace_back(worker, 1)
              if (const int32_t lb = lambda_of_variable(a); lb >= 0) {
                if (!threadOfLambda_.contains(lb))
                  threadOfLambda_[lb] = add_thread(e, b, lb, start_name(e, memberOpts_), "lambda");
                break;
              }
              const clang::FunctionDecl* fn = function_argument(a);
              if (!fn) continue;
              int32_t runs = resolve(fn);
              if (const clang::FunctionDecl* def = nullptr; runs < 0 && fn->isDefined(def) && def &&
                                                            def->doesThisDeclarationHaveABody() &&
                                                            is_project_function(def))
                runs = add_function(def);
              const int32_t t = add_thread(e, b, runs, start_name(e, memberOpts_), fn->getNameAsString());
              data_[b].functionStarts_.push_back(t);
              break;
            }
          }
          if (!body.lambda_ && is_qthread_run(body.fn_)) add_thread(nullptr, -1, b, "QThread::run", "run");
        }
      }  // find_threads

      // the body of the lambda in a local variable that an argument names, or -1
      [[nodiscard]] int32_t lambda_of_variable(const clang::Expr* _arg) const {
        const auto* ref = llvm::dyn_cast_or_null<clang::DeclRefExpr>(object_expr(_arg));
        const auto* v   = ref ? llvm::dyn_cast<clang::VarDecl>(ref->getDecl()) : nullptr;
        if (!v || !v->isLocalVarDecl() || !v->getInit()) return -1;
        const clang::Expr* init = object_expr(v->getInit());
        while (const auto* c = llvm::dyn_cast_or_null<clang::CXXConstructExpr>(init)) {
          if (c->getNumArgs() != 1) return -1;
          init = object_expr(c->getArg(0));  // a conversion, for example to std::function
        }
        const auto* lambda = llvm::dyn_cast_or_null<clang::LambdaExpr>(init);
        const auto it      = lambda ? lambdaBody_.find(lambda) : lambdaBody_.end();
        return it == lambdaBody_.end() ? -1 : it->second;
      }  // lambda_of_variable

      // the object that gets the value of an expression: a variable, the target of an assignment, a member in the
      // initializers of a constructor, or an element of a container
      [[nodiscard]] std::optional<ObjectPath> receiver_of(const clang::Expr* _e, const int32_t _body,
                                                          const Subst& _subst) const {
        const clang::ParentMap& pm = parents(_body);
        const clang::Stmt* child   = _e;
        const clang::Stmt* p       = pm.getParent(child);
        for (; p; child = p, p = pm.getParent(p)) {
          if (llvm::isa<clang::ImplicitCastExpr, clang::MaterializeTemporaryExpr, clang::CXXBindTemporaryExpr,
                        clang::ParenExpr, clang::ExprWithCleanups, clang::CXXFunctionalCastExpr, clang::CXXNewExpr>(p))
            continue;
          if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(p); c && c->getNumArgs() == 1) continue;
          break;
        }
        if (!p) {
          // an initializer of a constructor, for example thread_([this]() { run(); })
          const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(model_.bodies_[model_.bodies_[_body].root_].fn_);
          if (!ctor) return std::nullopt;
          for (const clang::CXXCtorInitializer* init : ctor->inits()) {
            if (init->getInit() != child || !init->getMember()) continue;
            const clang::CXXRecordDecl* rd = ctor->getParent()->getCanonicalDecl();
            ObjectPath out{rd, true, {}};
            for (const auto& [key, path] : _subst)
              if (key == rd) out = path;
            out.steps_.push_back(init->getMember());
            return out;
          }
          return std::nullopt;
        }
        if (const auto* ds = llvm::dyn_cast<clang::DeclStmt>(p))
          for (const clang::Decl* d : ds->decls())
            if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getInit() == child)
              return ObjectPath{v, false, {}};
        if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p); b && b->isAssignmentOp() && b->getRHS() == child)
          return object_path(b->getLHS(), _subst);
        if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(p);
            op && op->getOperator() == clang::OO_Equal && op->getNumArgs() == 2 && op->getArg(1) == child)
          return object_path(op->getArg(0), _subst);
        if (const auto* m = llvm::dyn_cast<clang::CXXMemberCallExpr>(p);
            m && has_name(m->getMethodDecl(), {"push_back", "emplace_back", "insert", "emplace", "push"}))
          if (auto out = object_path(m->getImplicitObjectArgument(), _subst)) {
            out->steps_.push_back(nullptr);
            return out;
          }
        return std::nullopt;
      }  // receiver_of

      // the variable or the member that keeps the thread or the future of a start. for a container of threads, the
      // container
      [[nodiscard]] std::optional<ObjectPath> handle_of(const clang::Expr* _at, const int32_t _body) const {
        if (const auto* m = llvm::dyn_cast<clang::CXXMemberCallExpr>(_at);
            m && has_name(m->getMethodDecl(), {"emplace_back", "emplace", "push_back"}))
          return object_path(m->getImplicitObjectArgument(), {});
        std::optional<ObjectPath> out = receiver_of(_at, _body, {});
        if (out && !out->steps_.empty() && !out->steps_.back()) out->steps_.pop_back();
        return out;
      }  // handle_of

      // the calls of join(), get() and wait() on the handles of the threads, and the calls of functions that join the
      // handle of an argument or of their object in each run. a start and a join in two different functions match in
      // the terms of a caller of both: a parameter and this get the objects of the calls
      void find_joins() {
        const int32_t n = int32_t(model_.bodies_.size());
        bodyJoins_.assign(n, {});
        std::vector<std::vector<ThreadsJoin>>& joins = bodyJoins_;  // the joins of each body
        for (int32_t b = 0; b < n; ++b) {
          const clang::ParentMap& pm = parents(b);
          for (const clang::CallExpr* c : data_[b].calls_) {
            const auto* m = llvm::dyn_cast<clang::CXXMemberCallExpr>(c);
            if (!m || !has_name(m->getMethodDecl(), {"join", "get", "wait"})) continue;
            const clang::Expr* object      = m->getImplicitObjectArgument();
            std::optional<ObjectPath> path = object_path(object, {});
            const clang::Stmt* at          = c;

            // a loop over a container of threads: for (std::thread& t : threads_) t.join()
            if (const auto* ref = llvm::dyn_cast_or_null<clang::DeclRefExpr>(object_expr(object)))
              if (const clang::CXXForRangeStmt* loop = range_loop_of(ref->getDecl(), c, pm))
                if (auto range = object_path(loop->getRangeInit(), {})) {
                  path = std::move(range);
                  at   = loop;
                }
            if (!path) continue;

            // an element of a container of threads, for example threads_[i].join() in a loop
            if (!path->steps_.empty() && !path->steps_.back()) {
              path->steps_.pop_back();
              if (const clang::Stmt* loop = loop_around(c, pm)) at = loop;
            }
            joins[b].push_back(ThreadsJoin{at, c, b, m->getMethodDecl()->getNameAsString(), std::move(*path)});
          }

          // the destructor of std::jthread joins. the destructor of the future of std::async waits, other futures do
          // not wait
          for (const Destruction& d : data_[b].dtors_) {
            if (d.dtor_) continue;
            std::optional<ObjectPath> path = destroyed_object(d, {});
            if (!path) continue;
            if (d.kind_ == "~future" && llvm::none_of(model_.threads_, [&](const ThreadsStart& _s) -> bool {
                  return _s.via_ == "std::async" && _s.handle_ && *_s.handle_ == *path;
                }))
              continue;
            joins[b].push_back(ThreadsJoin{d.at_, d.isAtEnd_ ? nullptr : llvm::dyn_cast<clang::Expr>(d.at_), b, d.kind_,
                                           std::move(*path), d.isAtEnd_});
          }
        }

        // the joins of each function in each of its runs. a call of such a function joins in the caller, and so does
        // a destructor
        std::vector<std::vector<const ThreadsJoin*>> lasting(n);
        std::vector<int8_t> state(n, 0);  // 0 not done, 1 in work, 2 done
        const auto add_lasting = [&](const auto& _self, const int32_t _b, const int32_t _depth) -> void {
          state[_b] = 1;
          for (const clang::CallExpr* c : data_[_b].calls_) {
            const int32_t g = resolve(called_function(c));
            if (g < 0 || model_.bodies_[g].lambda_) continue;
            if (state[g] == 0 && _depth < threads_max_depth) _self(_self, g, _depth + 1);
            if (state[g] != 2) continue;  // a cycle of calls
            const Subst subst = bind(c, g, {});
            for (const ThreadsJoin* j : lasting[g])
              if (auto handle = rebased(j->handle_, subst))
                joins[_b].push_back(ThreadsJoin{c, c, _b, j->kind_, std::move(*handle)});
          }
          for (const Destruction& d : data_[_b].dtors_) {
            const int32_t g = resolve(d.dtor_);
            if (g < 0) continue;
            if (state[g] == 0 && _depth < threads_max_depth) _self(_self, g, _depth + 1);
            const std::optional<ObjectPath> object = destroyed_object(d, {});
            if (state[g] != 2 || !object) continue;
            const Subst subst{{d.dtor_->getParent()->getCanonicalDecl(), *object}};
            const clang::Expr* call = d.isAtEnd_ ? nullptr : llvm::dyn_cast<clang::Expr>(d.at_);
            bool isKept             = false;
            for (const ThreadsJoin* j : lasting[g]) {
              if (auto handle = rebased(j->handle_, subst))
                joins[_b].push_back(ThreadsJoin{d.at_, call, _b, d.kind_, std::move(*handle), d.isAtEnd_});

              // the object keeps the thread, for example a std::thread that the constructor moves into a member
              if (j->handle_.isThis_ && !isKept) {
                joins[_b].push_back(ThreadsJoin{d.at_, call, _b, d.kind_, *object, d.isAtEnd_});
                isKept = true;
              }
            }
          }
          const clang::ParentMap& pm = parents(_b);
          for (const ThreadsJoin& j : joins[_b])
            if (is_join_unconditional(j.at_, body_stmt(_b), j.handle_, pm)) lasting[_b].push_back(&j);
          state[_b] = 2;
        };
        for (int32_t b = 0; b < n; ++b)
          if (state[b] == 0) add_lasting(add_lasting, b, 0);

        // the handles of the threads in the terms of each function: a start, and a call of a function with a start
        handles_.assign(n, {});
        std::fill(state.begin(), state.end(), int8_t(0));
        const auto add_handles = [&](const auto& _self, const int32_t _b, const int32_t _depth) -> void {
          state[_b] = 1;
          for (int32_t t = 0; t < int32_t(model_.threads_.size()); ++t)
            if (const ThreadsStart& s = model_.threads_[t]; s.body_ == _b && s.at_ && s.handle_)
              handles_[_b].push_back({*s.handle_, t, s.at_});
          const auto add_from = [&](const int32_t _g, const clang::Stmt* _at, const Subst& _subst) {
            for (const ThreadHandle& h : handles_[_g])
              if (auto path = rebased(h.path_, _subst)) handles_[_b].push_back({std::move(*path), h.thread_, _at});
          };
          for (const clang::CallExpr* c : data_[_b].calls_) {
            const int32_t g = resolve(called_function(c));
            if (g < 0 || model_.bodies_[g].lambda_) continue;
            if (state[g] == 0 && _depth < threads_max_depth) _self(_self, g, _depth + 1);
            if (state[g] == 2) add_from(g, c, bind(c, g, {}));
          }
          for (const Construction& c : data_[_b].constructs_) {
            const int32_t g = resolve(c.ctor_);
            if (g < 0) continue;
            if (state[g] == 0 && _depth < threads_max_depth) _self(_self, g, _depth + 1);
            if (state[g] == 2) add_from(g, c.at_, bind_construct(c, g, _b, {}));
          }
          state[_b] = 2;
        };
        for (int32_t b = 0; b < n; ++b)
          if (state[b] == 0) add_handles(add_handles, b, 0);

        // a join of the handle of a start, in the terms of the start or of a caller
        for (int32_t b = 0; b < n; ++b)
          for (const ThreadsJoin& j : joins[b])
            for (int32_t t = 0; t < int32_t(model_.threads_.size()); ++t) {
              ThreadsStart& s    = model_.threads_[t];
              const bool isMatch = (s.handle_ && *s.handle_ == j.handle_) ||
                                   llvm::any_of(handles_[b], [&](const ThreadHandle& _h) -> bool {
                                     return _h.thread_ == t && _h.path_ == j.handle_;
                                   });
              const bool isKnown = llvm::any_of(
                  s.joins_, [&](const ThreadsJoin& _o) -> bool { return _o.at_ == j.at_ && _o.body_ == j.body_; });
              if (isMatch && !isKnown) s.joins_.push_back(j);
            }
      }  // find_joins

      void set_thread_kind(const int32_t _t) {
        ThreadsStart& s = model_.threads_[_t];
        if (!s.at_ || s.body_ < 0) return;
        const clang::ParentMap& pm = parents(s.body_);
        const bool isCtor          = is_constructor(s.body_);

        // a join after the start that runs in each run of the block. a destructor at the end of a block around the
        // start runs after it in each run
        for (const ThreadsJoin& j : s.joins_) {
          if (j.body_ != s.body_) continue;
          if (j.isAtEnd_ && llvm::is_contained(parents_up(s.at_, pm), j.at_)) {
            s.isJoined_ = true;
            continue;
          }
          const auto prec = precedes(s.at_, j.at_, pm);
          if (prec && is_join_unconditional(j.at_, prec->cb_, j.handle_, pm)) s.isJoined_ = true;
        }

        // a local std::jthread joins at the end of its block, and the future of std::async waits at the end of its
        // block
        if (!s.isJoined_ && s.handle_ && !s.handle_->isThis_ && s.handle_->steps_.empty())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(s.handle_->root_);
              v && v->isLocalVarDecl() && !v->isStaticLocal() &&
              (thread_type_name(v->getType()) == "std::jthread" || s.via_ == "std::async"))
            s.isJoined_ = true;

        // a start in a loop, or a start with no handle in a function that can run again
        s.isRepeated_ = is_repeated_start(s.at_, pm, memberOpts_) || (!s.handle_ && !isCtor);
      }  // set_thread_kind

      void find_captures() {
        for (const auto& [b, t] : threadOfLambda_) {
          ThreadsCapture capture{t, {}};
          for (const clang::LambdaCapture& c : model_.bodies_[b].lambda_->captures()) {
            if (!c.capturesVariable() || c.getCaptureKind() != clang::LCK_ByRef) continue;
            const auto* v = llvm::dyn_cast<clang::VarDecl>(c.getCapturedVar());
            if (!v || v->hasGlobalStorage()) continue;
            captured_.insert(v);
            capture.vars_.push_back(v);
          }
          if (!capture.vars_.empty() && !model_.threads_[t].isJoined_) model_.captures_.push_back(std::move(capture));
        }
        std::ranges::sort(model_.captures_, {}, &ThreadsCapture::thread_);
      }  // find_captures

      [[nodiscard]] static bool is_member_operator(const clang::CallExpr* _c, const clang::FunctionDecl* _fn) {
        return llvm::isa<clang::CXXOperatorCallExpr>(_c) && llvm::isa<clang::CXXMethodDecl>(_fn);
      }  // is_member_operator

      // the arguments that a body of the analysis gets by reference or by pointer. the walk follows the call, so the
      // argument is not an access of its own
      void find_bound() {
        const auto bind_args = [&](const clang::FunctionDecl* _def, const std::vector<const clang::Expr*>& _args,
                                   const uint32_t _first) {
          for (uint32_t i = 0; i < _def->getNumParams() && i + _first < _args.size(); ++i) {
            const clang::QualType t = _def->getParamDecl(i)->getType();
            if (!t->isReferenceType() && !t->isPointerType()) continue;
            const clang::Expr* arg = object_expr(_args[i + _first]);
            bound_.insert(arg);
            if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(arg); u && u->getOpcode() == clang::UO_AddrOf)
              bound_.insert(object_expr(u->getSubExpr()));
          }
        };
        for (int32_t b = 0; b < int32_t(model_.bodies_.size()); ++b) {
          for (const clang::CallExpr* c : data_[b].calls_) {
            const int32_t g = resolve(called_function(c));
            if (g < 0) continue;
            const bool isMemberOp = is_member_operator(c, model_.bodies_[g].fn_);
            bind_args(model_.bodies_[g].fn_, arguments_of(c), isMemberOp ? 1 : 0);

            // the object of a member function of the analysis: the walk follows the call with this
            if (const auto* mc = llvm::dyn_cast<clang::CXXMemberCallExpr>(c))
              bound_.insert(object_expr(mc->getImplicitObjectArgument()));
            else if (isMemberOp && c->getNumArgs() > 0)
              bound_.insert(object_expr(c->getArg(0)));
          }
          for (const Construction& c : data_[b].constructs_)
            if (const int32_t g = resolve(c.ctor_); g >= 0) bind_args(model_.bodies_[g].fn_, arguments_of(c.at_), 0);
        }

        // the objects that a thread of a function gets
        for (const ThreadsStart& s : model_.threads_) {
          if (!s.at_ || s.runs_ < 0) continue;
          for (const auto& given : start_arguments(s)) {
            const clang::Expr* arg = object_expr(given.second);
            bound_.insert(arg);
            if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(arg); u && u->getOpcode() == clang::UO_AddrOf)
              bound_.insert(object_expr(u->getSubExpr()));
          }
        }
      }  // find_bound

      // the local objects that a thread uses through a call. the call gives the object to a parameter or to this of a
      // function, and the function gives it to a thread in some run, for example df_go(task) with
      // void df_go(Task& _t) { std::thread([&_t]() { ... }); }. a function gives a parameter or this to a thread if a
      // thread lambda captures it, if a thread of a function gets it, or if a call gives it to such a function
      void find_shared() {
        const int32_t n = int32_t(model_.bodies_.size());
        std::vector<std::vector<int32_t>> bodiesOf(n);  // a function -> the function and its lambdas
        for (int32_t b = 0; b < n; ++b) bodiesOf[model_.bodies_[b].root_].push_back(b);
        std::vector<std::vector<const clang::Decl*>> given(n);  // a function -> its parameters and this for threads

        // a parameter by reference or by pointer, this, or a local object of the function _f
        const auto add = [&](const int32_t _f, const ObjectPath& _p) {
          const clang::Decl* root = _p.root_;
          if (_p.isThis_) {
            if (!llvm::is_contained(given[_f], root)) given[_f].push_back(root);
            return;
          }
          if (const auto* p = llvm::dyn_cast_or_null<clang::ParmVarDecl>(root)) {
            const auto* fn          = llvm::dyn_cast<clang::FunctionDecl>(p->getDeclContext());
            const clang::QualType t = p->getType();
            if (fn && fn->getCanonicalDecl() == model_.bodies_[_f].fn_->getCanonicalDecl() &&
                (t->isReferenceType() || t->isPointerType()) && !llvm::is_contained(given[_f], root))
              given[_f].push_back(root);
            return;
          }
          const auto* v = llvm::dyn_cast_or_null<clang::VarDecl>(root);
          if (v && v->hasLocalStorage() && !v->getType()->isReferenceType() && !v->getType()->isPointerType())
            shared_.insert(v);
        };

        // the captures of the thread lambdas: a capture by reference, this, and a copy of a pointer. a local reference
        // is the object of its initializer
        for (const auto& lambda : threadOfLambda_) {
          const ThreadsBody& body = model_.bodies_[lambda.first];
          const auto* md          = llvm::dyn_cast<clang::CXXMethodDecl>(model_.bodies_[body.root_].fn_);
          for (const clang::LambdaCapture& c : body.lambda_->captures()) {
            if (c.capturesThis()) {
              if (c.getCaptureKind() == clang::LCK_This && md && md->isInstance())
                add(body.root_, ObjectPath{md->getParent()->getCanonicalDecl(), true, {}});
              continue;
            }
            const auto* v = c.capturesVariable() ? llvm::dyn_cast<clang::VarDecl>(c.getCapturedVar()) : nullptr;
            if (!v || (c.getCaptureKind() != clang::LCK_ByRef && !v->getType()->isPointerType())) continue;
            ObjectPath p{v, false, {}};
            if (v->getType()->isReferenceType() && v->isLocalVarDecl() && v->getInit())
              if (auto init = object_path(v->getInit(), {})) p = std::move(*init);
            add(body.root_, p);
          }
        }

        // the threads of functions
        for (int32_t b = 0; b < n; ++b)
          for (const int32_t t : data_[b].functionStarts_) {
            if (model_.threads_[t].runs_ < 0) continue;
            for (const auto& bound : bind_start(model_.threads_[t], {})) add(model_.bodies_[b].root_, bound.second);
          }

        // the calls
        std::vector<int8_t> state(n, 0);  // 0 not done, 1 in work, 2 done
        const auto add_calls = [&](const auto& _self, const int32_t _f, const int32_t _depth) -> void {
          state[_f]       = 1;
          const auto pass = [&](const int32_t _g, const Subst& _subst) {
            if (state[_g] == 0 && _depth < threads_max_depth) _self(_self, _g, _depth + 1);
            for (const auto& [key, path] : _subst)
              if (llvm::is_contained(given[_g], key)) add(_f, path);
          };
          for (const int32_t b : bodiesOf[_f]) {
            for (const clang::CallExpr* c : data_[b].calls_)
              if (const int32_t g = resolve(called_function(c)); g >= 0 && g != _f && !model_.bodies_[g].lambda_)
                pass(g, bind(c, g, {}));
            for (const Construction& c : data_[b].constructs_)
              if (const int32_t g = resolve(c.ctor_); g >= 0 && g != _f) pass(g, bind_construct(c, g, b, {}));
          }
          state[_f] = 2;
        };
        for (int32_t f = 0; f < n; ++f)
          if (model_.bodies_[f].root_ == f && state[f] == 0) add_calls(add_calls, f, 0);
      }  // find_shared

      //----------------------------------
      // Walk

      // the objects of the parameters that a function gets by reference or by pointer. a copy is a new object
      static void bind_params(const clang::FunctionDecl* _def, const std::vector<const clang::Expr*>& _args,
                              const uint32_t _first, const Subst& _subst, Subst& _out) {
        for (uint32_t i = 0; i < _def->getNumParams() && i + _first < _args.size(); ++i) {
          const clang::ParmVarDecl* p = _def->getParamDecl(i);
          if (!p->getType()->isReferenceType() && !p->getType()->isPointerType()) continue;
          if (auto path = object_path(_args[i + _first], _subst)) _out.emplace_back(p, std::move(*path));
        }
      }  // bind_params

      // the objects of the parameters and of this for a construction: this is the object that gets the new object
      [[nodiscard]] Subst bind_construct(const Construction& _c, const int32_t _g, const int32_t _b,
                                         const Subst& _subst) const {
        Subst out;
        const clang::FunctionDecl* def = model_.bodies_[_g].fn_;
        bind_params(def, arguments_of(_c.at_), 0, _subst, out);
        if (auto path = receiver_of(_c.at_, _b, _subst))
          out.emplace_back(llvm::cast<clang::CXXMethodDecl>(def)->getParent()->getCanonicalDecl(), std::move(*path));
        return out;
      }  // bind_construct

      // the objects of the parameters and of this for a call of a body of the analysis
      [[nodiscard]] Subst bind(const clang::CallExpr* _c, const int32_t _g, const Subst& _subst) const {
        Subst out;
        const clang::FunctionDecl* def = model_.bodies_[_g].fn_;
        const bool isMemberOp          = is_member_operator(_c, def);
        bind_params(def, arguments_of(_c), isMemberOp ? 1 : 0, _subst, out);
        if (const auto* md = llvm::dyn_cast<clang::CXXMethodDecl>(def); md && md->isInstance()) {
          const clang::Expr* object = nullptr;
          if (const auto* mc = llvm::dyn_cast<clang::CXXMemberCallExpr>(_c))
            object = mc->getImplicitObjectArgument();
          else if (isMemberOp)
            object = _c->getArg(0);
          if (object)
            if (auto path = object_path(object, _subst)) out.emplace_back(md->getParent()->getCanonicalDecl(), *path);
        }
        return out;
      }  // bind

      // the expressions of the objects that a thread of a function gets: this of a member function, for example
      // std::thread(&Worker::run, this), and the parameters by reference or by pointer. a thread start copies its
      // arguments, so only a pointer, a smart pointer, std::ref or std::cref gives an object
      [[nodiscard]] std::vector<std::pair<const clang::Decl*, const clang::Expr*>> start_arguments(
          const ThreadsStart& _s) const {
        std::vector<std::pair<const clang::Decl*, const clang::Expr*>> out;
        const clang::FunctionDecl* def             = model_.bodies_[_s.runs_].fn_;
        const std::vector<const clang::Expr*> args = arguments_of(_s.at_);
        const auto ref_argument                    = [](const clang::Expr* _e) -> const clang::Expr* {
          const auto* call              = llvm::dyn_cast_or_null<clang::CallExpr>(object_expr(_e));
          const clang::FunctionDecl* fn = call ? call->getDirectCallee() : nullptr;
          return fn && is_in_std(fn) && has_name(fn, {"ref", "cref"}) && call->getNumArgs() == 1 ? call->getArg(0)
                                                                                                                    : nullptr;
        };
        for (size_t i = 0; i < args.size(); ++i) {
          if (!function_argument(args[i])) continue;
          size_t next = i + 1;
          if (const auto* md = llvm::dyn_cast<clang::CXXMethodDecl>(def);
              md && md->isInstance() && next < args.size()) {
            const clang::Expr* object = ref_argument(args[next]);
            if (!object) {
              const clang::QualType t        = object_expr(args[next])->getType();
              const clang::CXXRecordDecl* rd = record_of(t);
              if (t->isPointerType() || (rd && is_in_std(rd) && has_name(rd, {"unique_ptr", "shared_ptr"})))
                object = args[next];
            }
            if (object) out.emplace_back(md->getParent()->getCanonicalDecl(), object);
            ++next;
          }
          for (uint32_t k = 0; k < def->getNumParams() && next + k < args.size(); ++k) {
            const clang::ParmVarDecl* p = def->getParamDecl(k);
            if (p->getType()->isReferenceType()) {
              if (const clang::Expr* object = ref_argument(args[next + k])) out.emplace_back(p, object);
            } else if (p->getType()->isPointerType()) {
              out.emplace_back(p, args[next + k]);
            }
          }
          break;
        }
        return out;
      }  // start_arguments

      // the objects of this and of the parameters for a thread that runs a function
      [[nodiscard]] Subst bind_start(const ThreadsStart& _s, const Subst& _subst) const {
        Subst out;
        for (const auto& [key, object] : start_arguments(_s))
          if (auto path = object_path(object, _subst)) out.emplace_back(key, std::move(*path));
        return out;
      }  // bind_start

      // true if a call goes back into a body on the way to it. a lambda that its own function calls through a variable
      // is not a recursion
      [[nodiscard]] bool is_on_way(const int32_t _b, const int32_t _g, const Ctx& _ctx) const {
        if (_g == _b || std::ranges::any_of(_ctx.via_, [&](const ThreadsVia& _v) { return _v.body_ == _g; }))
          return true;
        if (model_.bodies_[_g].lambda_) return false;
        if (model_.bodies_[_b].root_ == _g) return true;
        return std::ranges::any_of(_ctx.via_,
                                   [&](const ThreadsVia& _v) { return model_.bodies_[_v.body_].root_ == _g; });
      }  // is_on_way

      // the key of a visit. the texts of the conditions are not a part of it, only if there are conditions
      [[nodiscard]] std::string ctx_key(const int32_t _b, const Ctx& _ctx) const {
        std::string out = std::to_string(_b) + ':' + std::to_string(_ctx.thread_);
        for (const auto& [d, p] : _ctx.subst_)
          out += '|' + std::to_string(reinterpret_cast<uintptr_t>(d)) + '=' + object_key(p, p.steps_.size());
        out += '#';
        for (const std::string& l : _ctx.locks_) out += l + ',';
        for (const std::vector<int32_t>* list :
             {&_ctx.order_.after_, &_ctx.order_.before_, &_ctx.order_.empty_, &_ctx.order_.ready_}) {
          out += '#';
          for (const int32_t t : *list) out += std::to_string(t) + ',';
        }
        out += _ctx.guards_.empty() ? "#0" : "#1";
        return out;
      }  // ctx_key

      [[nodiscard]] static std::vector<ThreadsVia> with(std::vector<ThreadsVia> _via, const ThreadsVia _step) {
        _via.push_back(_step);
        return _via;
      }  // with

      void walk() {
        std::vector<bool> isCalled(model_.bodies_.size(), false);
        std::vector<bool> isRun(model_.bodies_.size(), false);
        for (int32_t b = 0; b < int32_t(model_.bodies_.size()); ++b) {
          for (const clang::CallExpr* c : data_[b].calls_)
            if (const int32_t g = resolve(called_function(c)); g >= 0 && g != model_.bodies_[b].root_)
              isCalled[g] = true;
          for (const Construction& c : data_[b].constructs_)
            if (const int32_t g = resolve(c.ctor_); g >= 0 && g != model_.bodies_[b].root_) isCalled[g] = true;
          for (const Destruction& d : data_[b].dtors_)
            if (const int32_t g = resolve(d.dtor_); g >= 0 && g != model_.bodies_[b].root_) isCalled[g] = true;
        }
        for (const ThreadsStart& s : model_.threads_)
          if (s.runs_ >= 0) isRun[s.runs_] = true;

        // the threads of QThread::run
        for (int32_t t = 0; t < int32_t(model_.threads_.size()); ++t)
          if (!model_.threads_[t].at_ && model_.threads_[t].runs_ >= 0) {
            Ctx ctx;
            ctx.thread_ = t;
            visit(model_.threads_[t].runs_, ctx, 0);
          }

        // the functions of the main file that no other function calls run on the caller thread. then the functions in
        // a cycle of calls
        const auto is_root = [&](const int32_t _b) {
          const ThreadsBody& body = model_.bodies_[_b];
          return !body.lambda_ && !isRun[_b] && sm_.isInMainFile(sm_.getExpansionLoc(body.fn_->getLocation()));
        };
        for (int32_t b = 0; b < int32_t(model_.bodies_.size()); ++b)
          if (is_root(b) && !isCalled[b]) visit(b, Ctx{}, 0);
        for (int32_t b = 0; b < int32_t(model_.bodies_.size()); ++b)
          if (is_root(b) && model_.bodies_[b].threads_.empty()) visit(b, Ctx{}, 0);
      }  // walk

      void visit(const int32_t _b, const Ctx& _ctx, const int32_t _depth) {
        if (visits_ >= threads_max_visits || rawCount_ >= threads_max_accesses) {
          model_.isTruncated_ = true;
          return;
        }
        if (!seen_.insert(ctx_key(_b, _ctx)).second) return;
        ++visits_;
        if (!llvm::is_contained(model_.bodies_[_b].threads_, _ctx.thread_))
          model_.bodies_[_b].threads_.push_back(_ctx.thread_);
        const int32_t index = int32_t(ctxs_.size());
        ctxs_.push_back(_ctx);
        for (const clang::Expr* e : data_[_b].objects_) record(_b, e, index);

        // the lambdas in the body: a new thread, or code of the same thread
        for (const int32_t l : data_[_b].lambdas_) {
          const clang::LambdaExpr* lambda = model_.bodies_[l].lambda_;
          Ctx next;
          if (const auto t = threadOfLambda_.find(l); t != threadOfLambda_.end()) {
            const ThreadsStart& s = model_.threads_[t->second];
            next.thread_          = t->second;
            next.subst_           = _ctx.subst_;
            next.order_           = lasting(merged(_ctx.order_, order_at(s.body_ >= 0 ? s.body_ : _b, s.at_)));
            next.via_             = with(_ctx.via_, ThreadsVia{s.at_, s.body_ >= 0 ? s.body_ : _b});
          } else {
            next        = _ctx;
            next.order_ = merged(_ctx.order_, order_at(_b, lambda));
            if (is_synchronous(lambda, parents(_b))) {
              next.locks_ = merged(_ctx.locks_, lock_keys(_b, lambda, _ctx.subst_));
            } else {
              next.locks_.clear();
              next.order_ = lasting(next.order_);
            }
            if (_ctx.thread_ < 0) next.guards_ = merged_guards(guards_at(_b, lambda, _ctx.subst_), _ctx.guards_);
          }
          visit(l, next, _depth);
        }

        // the called functions
        for (const clang::CallExpr* c : data_[_b].calls_) {
          const int32_t g = resolve(called_function(c));
          if (g < 0 || _depth >= threads_max_depth || is_on_way(_b, g, _ctx)) continue;
          Ctx next;
          next.thread_ = _ctx.thread_;
          next.subst_  = bind(c, g, _ctx.subst_);
          next.locks_  = merged(_ctx.locks_, lock_keys(_b, c, _ctx.subst_));
          next.order_  = merged(_ctx.order_, order_at(_b, c));
          if (_ctx.thread_ < 0) next.guards_ = merged_guards(guards_at(_b, c, _ctx.subst_), _ctx.guards_);
          next.via_ = with(_ctx.via_, ThreadsVia{c, _b});
          visit(g, next, _depth + 1);
        }

        // the constructors
        for (const Construction& c : data_[_b].constructs_) {
          const int32_t g = resolve(c.ctor_);
          if (g < 0 || _depth >= threads_max_depth || is_on_way(_b, g, _ctx)) continue;
          Ctx next;
          next.thread_ = _ctx.thread_;
          next.subst_  = bind_construct(c, g, _b, _ctx.subst_);
          next.locks_  = merged(_ctx.locks_, lock_keys(_b, c.at_, _ctx.subst_));
          next.order_  = merged(_ctx.order_, order_at(_b, c.at_));
          if (_ctx.thread_ < 0) next.guards_ = merged_guards(guards_at(_b, c.at_, _ctx.subst_), _ctx.guards_);
          next.via_ = with(_ctx.via_, ThreadsVia{c.at_, _b});
          visit(g, next, _depth + 1);
        }

        // the destructors of the user. a lock guard that comes before a local object in its block still holds the lock
        // in the destructor of the object
        for (const Destruction& d : data_[_b].dtors_) {
          const int32_t g = resolve(d.dtor_);
          if (g < 0 || _depth >= threads_max_depth || is_on_way(_b, g, _ctx)) continue;
          std::optional<ObjectPath> object = destroyed_object(d, _ctx.subst_);
          if (!object) continue;
          Ctx next;
          next.thread_ = _ctx.thread_;
          next.subst_  = {{d.dtor_->getParent()->getCanonicalDecl(), std::move(*object)}};
          next.locks_  = merged(_ctx.locks_, lock_keys(_b, d.place_, _ctx.subst_));
          next.order_  = merged(_ctx.order_, order_at(_b, d.at_));
          if (_ctx.thread_ < 0) next.guards_ = merged_guards(guards_at(_b, d.at_, _ctx.subst_), _ctx.guards_);
          next.via_ = with(_ctx.via_, ThreadsVia{d.place_, _b});
          visit(g, next, _depth + 1);
        }

        // the threads that run a function of the analysis
        for (const int32_t t : data_[_b].functionStarts_) {
          const ThreadsStart& s = model_.threads_[t];
          if (s.runs_ < 0 || _depth >= threads_max_depth) continue;
          Ctx next;
          next.thread_ = t;
          next.subst_  = bind_start(s, _ctx.subst_);
          next.order_  = lasting(merged(_ctx.order_, order_at(_b, s.at_)));
          next.via_    = with(_ctx.via_, ThreadsVia{s.at_, _b});
          visit(s.runs_, next, _depth + 1);
        }
      }  // visit

      // keeps an access for the selection of the items
      void record(const int32_t _b, const clang::Expr* _e, const int32_t _ctx) {
        if (bound_.contains(_e)) return;
        const Ctx& ctx                 = ctxs_[_ctx];
        std::optional<ObjectPath> path = object_path(_e, ctx.subst_);
        if (!path || !path->root_ || (path->isThis_ && path->steps_.empty())) return;
        const auto* var = llvm::dyn_cast<clang::VarDecl>(path->root_);
        if (const auto* b = llvm::dyn_cast<clang::BindingDecl>(path->root_))
          var = llvm::dyn_cast_or_null<clang::VarDecl>(b->getDecomposedDecl());

        // each thread has its own object of a thread_local variable
        if (var && var->getStorageDuration() == clang::SD_Thread) return;

        // a local object or a parameter by value is a new object in each call. a thread can use it only through a
        // capture by reference, or through a call that gives it to a thread
        const bool isShared = var && (captured_.contains(var) || shared_.contains(var));
        if (var && !var->hasGlobalStorage() && !isShared && !var->getType()->isReferenceType() &&
            !var->getType()->isPointerType())
          return;

        // a local pointer or reference to an object that the engine cannot name: the item is the data member of its
        // class, for example TimeSummary::stat_cached, because two pointers can point to the same object
        const std::string text = object_text(*path, path->steps_.size());
        bool isAnyObject       = false;
        if (var && var->isLocalVarDecl() && !var->isStaticLocal() && !isShared && !path->steps_.empty() &&
            path->steps_[0]) {
          path->root_   = path->steps_[0]->getParent()->getCanonicalDecl();
          path->isThis_ = false;
          isAnyObject   = true;
          var           = nullptr;

          // a pointer in the path goes to one more object that the engine cannot name, for example node->parent
          for (size_t i = path->steps_.size(); i-- > 1;) {
            const clang::FieldDecl* f = path->steps_[i - 1];
            if (!f || !f->getType()->isPointerType()) continue;
            const clang::CXXRecordDecl* rd = user_class_of(f->getType(), sm_);
            if (!rd || !path->steps_[i]) continue;
            path->root_ = rd->getCanonicalDecl();
            path->steps_.erase(path->steps_.begin(), path->steps_.begin() + std::ptrdiff_t(i));
            break;
          }
        }
        const size_t n = item_steps(*path, sm_);

        std::string kind;
        if (var && var->hasGlobalStorage())
          kind = var->isStaticLocal() || var->isStaticDataMember() ? "static" : "global";
        else if (n > 0)
          kind = "member";
        else if (isShared)
          kind = "local";
        else if (var && (var->getType()->isReferenceType() || var->getType()->isPointerType()))
          kind = "whole";  // the whole object of a reference: a call that gets it can change all of its members
        else
          return;

        const clang::ValueDecl* decl = n > 0 ? static_cast<const clang::ValueDecl*>(path->steps_[n - 1])
                                             : llvm::dyn_cast<clang::ValueDecl>(path->root_);
        if (!decl) return;
        const clang::QualType type = decl->getType().getNonReferenceType();
        // a mutex or a condition variable protects data. it is not the data
        if (is_sync_type(type) || is_sync_type(_e->getType().getNonReferenceType())) return;
        if (kind != "whole" && type.isConstQualified()) return;
        if (var && n == 0 && var->isConstexpr()) return;

        const std::string key  = object_key(*path, n);
        const auto [it, isNew] = itemIndex_.try_emplace(key, items_.size());
        if (isNew) {
          RawItem raw;
          raw.item_.key_   = key;
          raw.item_.root_  = object_key(*path, 0);
          ObjectPath inner = *path;
          inner.isThis_    = true;  // no root in the text
          raw.item_.label_ =
              isAnyObject ? llvm::cast<clang::NamedDecl>(path->root_)->getNameAsString() + "::" + object_text(inner, n)
                          : object_text(*path, n);
          raw.item_.kind_ = kind;
          raw.item_.decl_ = decl;
          items_.push_back(std::move(raw));
        }
        RawAccess a;
        a.expr_     = _e;
        a.body_     = _b;
        a.ctx_      = _ctx;
        a.path_     = text;
        a.isWhole_  = kind == "whole";
        a.isAtomic_ = is_atomic_type(_e->getType().getNonReferenceType());
        for (size_t i = n; i < path->steps_.size(); ++i)
          a.sub_.push_back(path->steps_[i] ? path->steps_[i]->getNameAsString() : "[]");
        items_[it->second].raw_.push_back(std::move(a));
        ++rawCount_;
      }  // record

      //----------------------------------
      // Facts at a position

      // the lock keys at a position: the object paths of the mutexes, or their texts
      [[nodiscard]] std::vector<std::string> lock_keys(const int32_t _b, const clang::Stmt* _at,
                                                       const Subst& _subst) const {
        std::vector<std::string> out;
        for (const clang::Expr* m : mutexes_at(_at, parents(_b))) {
          std::string text;
          if (auto p = object_path(m, _subst)) text = object_text(*p, p->steps_.size());
          if (text.empty()) text = short_text(ctx_, m->getSourceRange());
          if (text.starts_with("&")) text.erase(0, 1);
          out.push_back(std::move(text));
        }
        std::ranges::sort(out);
        out.erase(std::unique(out.begin(), out.end()), out.end());
        return out;
      }  // lock_keys

      // the threads that a position of a body is in sequence with: joins and starts in the same body, and the checks
      // of their handles around the position
      [[nodiscard]] const ThreadsOrder& order_at(const int32_t _b, const clang::Stmt* _at) {
        if (const auto it = orders_.find(_at); it != orders_.end()) return it->second;
        ThreadsOrder out;
        const clang::ParentMap& pm = parents(_b);
        const bool isCtor          = is_constructor(_b);
        for (int32_t t = 0; t < int32_t(model_.threads_.size()); ++t) {
          const ThreadsStart& s = model_.threads_[t];

          // after a join in the same body, with no new start between them. a call of a function with a start is also
          // a start
          for (const ThreadsJoin& j : s.joins_) {
            if (j.body_ != _b) continue;
            const auto prec = precedes(j.at_, _at, pm);
            if (!prec || !is_join_unconditional(j.at_, prec->ca_, j.handle_, pm)) continue;
            const bool isRestarted = llvm::any_of(handles_[_b], [&](const ThreadHandle& _h) -> bool {
              return _h.thread_ == t && is_join_before(j, _h.at_) && is_before(_h.at_, _at);
            });
            if (!isRestarted) {
              out.after_.push_back(t);
              break;
            }
          }

          // before the start, if no thread of an earlier run of the function can still run
          if (s.at_ && s.body_ == _b && (s.isJoined_ || isCtor))
            if (const auto prec = precedes(_at, s.at_, pm); prec && !is_in_loop(prec->lca_, pm))
              out.before_.push_back(t);
        }
        add_handle_facts(_b, _at, out);
        for (std::vector<int32_t>* list : {&out.after_, &out.before_, &out.empty_, &out.ready_}) {
          std::ranges::sort(*list);
          list->erase(std::unique(list->begin(), list->end()), list->end());
        }
        return orders_.emplace(_at, std::move(out)).first->second;
      }  // order_at

      // the joins before a position of a body that match a thread only in the terms of the root of the walk, for
      // example a join of thread_ in ~Task() for a thread that start(Task& _t) starts. the context gives the objects of
      // the parameters and of this, in the terms of the root
      void add_context_joins(const int32_t _b, const clang::Stmt* _at, const Ctx& _ctx, ThreadsOrder& _out) const {
        if (_ctx.subst_.empty()) return;
        const int32_t root         = _ctx.via_.empty() ? _b : _ctx.via_.front().body_;
        const clang::ParentMap& pm = parents(_b);
        for (const ThreadsJoin& j : bodyJoins_[_b]) {
          const auto prec = precedes(j.at_, _at, pm);
          if (!prec || !is_join_unconditional(j.at_, prec->ca_, j.handle_, pm)) continue;
          const std::optional<ObjectPath> handle = rebased(j.handle_, _ctx.subst_);
          if (!handle) continue;
          for (const ThreadHandle& h : handles_[root]) {
            if (!(h.path_ == *handle) || llvm::is_contained(_out.after_, h.thread_)) continue;

            // a new start of the thread between the join and the position: the order ends
            const bool isRestarted = llvm::any_of(handles_[_b], [&](const ThreadHandle& _x) -> bool {
              return _x.thread_ == h.thread_ && is_join_before(j, _x.at_) && is_before(_x.at_, _at);
            });
            if (!isRestarted) _out.after_.push_back(h.thread_);
          }
        }
        std::ranges::sort(_out.after_);
        _out.after_.erase(std::unique(_out.after_.begin(), _out.after_.end()), _out.after_.end());
      }  // add_context_joins

      // the threads whose handle is the object. with a body, also the handles in the terms of the body, for example
      // the handle of a start in a called function
      [[nodiscard]] std::vector<int32_t> threads_of_handle(const ObjectPath& _p, const int32_t _b = -1) const {
        std::vector<int32_t> out;
        for (int32_t t = 0; t < int32_t(model_.threads_.size()); ++t)
          if (model_.threads_[t].handle_ && *model_.threads_[t].handle_ == _p) out.push_back(t);
        if (_b >= 0 && _b < int32_t(handles_.size()))
          for (const ThreadHandle& h : handles_[_b])
            if (h.path_ == _p && !llvm::is_contained(out, h.thread_)) out.push_back(h.thread_);
        return out;
      }  // threads_of_handle

      // the checks of handles in the conditions around a position: an empty handle, and a ready future
      void add_handle_facts(const int32_t _b, const clang::Stmt* _at, ThreadsOrder& _out) const {
        const clang::ParentMap& pm = parents(_b);
        const clang::Stmt* stop    = body_stmt(_b);
        for (const clang::Stmt *c = _at, *p = pm.getParent(c); p && c != stop; c = p, p = pm.getParent(p)) {
          if (llvm::isa<clang::LambdaExpr>(p)) break;
          std::vector<const clang::Expr*> conds;
          bool isElse = false;
          if (const auto* s = llvm::dyn_cast<clang::IfStmt>(p)) {
            if (c == s->getThen()) add_conjuncts(s->getCond(), conds);
            if (c == s->getElse()) {
              conds.push_back(s->getCond());
              isElse = true;
            }
          } else if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p);
                     b && b->getOpcode() == clang::BO_LAnd && c == b->getRHS()) {
            add_conjuncts(b->getLHS(), conds);
          } else if (const auto* co = llvm::dyn_cast<clang::ConditionalOperator>(p); co && c == co->getTrueExpr()) {
            add_conjuncts(co->getCond(), conds);
          }

          for (const clang::Expr* e : conds) {
            auto [kind, path] = handle_check(e);
            if (kind == HandleCheck::NONE || !path) continue;
            if (isElse) kind = kind == HandleCheck::SET ? HandleCheck::EMPTY : HandleCheck::NONE;
            for (const int32_t t : threads_of_handle(*path, _b)) {
              if (kind == HandleCheck::READY) _out.ready_.push_back(t);
              if (kind != HandleCheck::EMPTY) continue;

              // a start in the branch before the position runs a new thread. a call of a function with a start is
              // also a start
              const bool isStarted = llvm::any_of(handles_[_b], [&](const ThreadHandle& _h) -> bool {
                return _h.thread_ == t && is_before(_h.at_, _at) && llvm::is_contained(parents_up(_h.at_, pm), c);
              });
              if (!isStarted) _out.empty_.push_back(t);
            }
          }
        }
      }  // add_handle_facts

      // true if the condition checks the handle of a thread. such a check is a part of the order, not a condition
      [[nodiscard]] bool is_handle_condition(const clang::Expr* _e, const int32_t _b) const {
        const auto [kind, path] = handle_check(_e);
        return kind != HandleCheck::NONE && path && !threads_of_handle(*path, _b).empty();
      }  // is_handle_condition

      // the keys of the items that an expression reads
      void add_keys(const clang::Stmt* _s, const Subst& _subst, std::vector<std::string>& _out) const {
        if (!_s) return;
        if (const auto* e = llvm::dyn_cast<clang::Expr>(_s);
            e && llvm::isa<clang::MemberExpr, clang::DeclRefExpr>(object_expr(e)))
          if (auto p = object_path(e, _subst)) _out.push_back(object_key(*p, item_steps(*p, sm_)));
        for (const clang::Stmt* child : _s->children()) add_keys(child, _subst, _out);
      }  // add_keys

      void add_guard(const clang::Expr* _e, const int32_t _b, const bool _isNegated, const Subst& _subst,
                     std::vector<ThreadsGuard>& _out) const {
        if (!_e || is_handle_condition(_e, _b)) return;
        ThreadsGuard g{short_text(ctx_, _e->getSourceRange()), _isNegated, {}};
        add_keys(_e, _subst, g.keys_);
        if (!g.text_.empty() && !llvm::is_contained(_out, g)) _out.push_back(std::move(g));
      }  // add_guard

      // the conditions around a position of a body, the innermost first. the loops are not conditions here: a loop
      // keeps a thread at work, but it does not keep two threads apart
      [[nodiscard]] std::vector<ThreadsGuard> guards_at(const int32_t _b, const clang::Stmt* _at,
                                                        const Subst& _subst) const {
        std::vector<ThreadsGuard> out;
        const clang::ParentMap& pm = parents(_b);
        const clang::Stmt* stop    = body_stmt(_b);
        for (const clang::Stmt *c = _at, *p = pm.getParent(c); p && c != stop && out.size() < threads_max_guards;
             c = p, p = pm.getParent(p)) {
          if (llvm::isa<clang::LambdaExpr>(p)) break;
          std::vector<const clang::Expr*> conds;
          if (const auto* s = llvm::dyn_cast<clang::IfStmt>(p)) {
            if (c == s->getThen()) add_conjuncts(s->getCond(), conds);
            if (c == s->getElse()) add_guard(s->getCond(), _b, true, _subst, out);
          } else if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p);
                     b && b->isLogicalOp() && c == b->getRHS()) {
            if (b->getOpcode() == clang::BO_LAnd)
              add_conjuncts(b->getLHS(), conds);
            else
              add_guard(b->getLHS(), _b, true, _subst, out);
          } else if (const auto* co = llvm::dyn_cast<clang::ConditionalOperator>(p)) {
            if (c == co->getTrueExpr()) add_conjuncts(co->getCond(), conds);
            if (c == co->getFalseExpr()) add_guard(co->getCond(), _b, true, _subst, out);
          } else if (const auto* cs = llvm::dyn_cast<clang::CompoundStmt>(p)) {
            const auto* sw = llvm::dyn_cast_or_null<clang::SwitchStmt>(pm.getParent(cs));
            if (sw && sw->getBody() == cs && sw->getCond()) {
              // the last case label before the statement
              const clang::SwitchCase* label = nullptr;
              for (const clang::Stmt* s : cs->body()) {
                if (const auto* sc = llvm::dyn_cast<clang::SwitchCase>(s)) label = sc;
                if (s == c) break;
              }
              if (const auto* cl = llvm::dyn_cast_or_null<clang::CaseStmt>(label)) {
                ThreadsGuard g{short_text(ctx_, sw->getCond()->getSourceRange()) +
                                   " == " + short_text(ctx_, cl->getLHS()->getSourceRange()),
                               false,
                               {}};
                add_keys(sw->getCond(), _subst, g.keys_);
                out.push_back(std::move(g));
              }
            }
          }
          for (const clang::Expr* e : conds) add_guard(e, _b, false, _subst, out);
        }
        return out;
      }  // guards_at

      // a condition that reads the item before it checks the handle of a thread, as in x && !future. the swapped
      // condition checks the handle first
      void set_swap(const int32_t _b, const clang::Expr* _e, ThreadsAccess& _a) const {
        const clang::ParentMap& pm = parents(_b);
        for (const clang::Stmt *c = _e, *p = pm.getParent(c); p && llvm::isa<clang::Expr>(p);
             c = p, p = pm.getParent(p)) {
          const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p);
          if (!b || b->getOpcode() != clang::BO_LAnd || c != b->getLHS()) continue;
          std::vector<const clang::Expr*> conds;
          add_conjuncts(b->getRHS(), conds);
          for (const clang::Expr* x : conds) {
            const auto [kind, path] = handle_check(x);
            if (kind != HandleCheck::EMPTY || !path) continue;
            const std::vector<int32_t> threads = threads_of_handle(*path, _b);
            if (threads.empty()) continue;
            _a.swapThread_ = threads.front();
            _a.swapFrom_   = short_text(ctx_, b->getSourceRange());
            _a.swapTo_     = short_text(ctx_, b->getRHS()->getSourceRange()) + " && " +
                         short_text(ctx_, b->getLHS()->getSourceRange());
            return;
          }
        }
      }  // set_swap

      void set_role(ThreadsAccess& _a) {
        const auto [it, isNew] = roles_.try_emplace(_a.expr_);
        if (isNew) it->second = access_role(_a.expr_, parents(_a.body_));
        _a.role_       = it->second.first;
        _a.isAlsoRead_ = it->second.second;
      }  // set_role

      //----------------------------------
      // Selection

      // completes an access: its role, its locks, its order, its conditions and its calls
      [[nodiscard]] ThreadsAccess complete(const RawAccess& _r, const std::string& _key) {
        const Ctx& ctx = ctxs_[_r.ctx_];
        ThreadsAccess a;
        a.expr_                  = _r.expr_;
        a.body_                  = _r.body_;
        a.thread_                = ctx.thread_;
        a.isWhole_               = _r.isWhole_;
        a.isAtomic_              = _r.isAtomic_;
        a.path_                  = _r.path_;
        a.sub_                   = _r.sub_;
        a.locks_                 = merged(ctx.locks_, lock_keys(_r.body_, _r.expr_, ctx.subst_));
        a.order_                 = merged(ctx.order_, order_at(_r.body_, _r.expr_));
        add_context_joins(_r.body_, _r.expr_, ctx, a.order_);
        // a condition that reads the item, or an object that contains it, is a part of the access. it does not keep
        // two threads apart
        const auto is_about_item = [&](const ThreadsGuard& _g) {
          return std::ranges::any_of(_g.keys_, [&](const std::string& _k) {
            return _k == _key || (_key.size() > _k.size() && _key.starts_with(_k) && _key[_k.size()] == '/');
          });
        };
        if (ctx.thread_ < 0)
          for (const ThreadsGuard& g : merged_guards(guards_at(_r.body_, _r.expr_, ctx.subst_), ctx.guards_))
            if (!is_about_item(g)) a.guards_.push_back(g);
        a.via_ = ctx.via_;
        set_swap(_r.body_, _r.expr_, a);
        set_role(a);
        return a;
      }  // complete

      [[nodiscard]] static std::string access_key(const ThreadsAccess& _a) {
        std::string out = std::to_string(reinterpret_cast<uintptr_t>(_a.expr_)) + ':' + std::to_string(_a.thread_);
        for (const std::string& l : _a.locks_) out += ',' + l;
        for (const std::vector<int32_t>* list :
             {&_a.order_.after_, &_a.order_.before_, &_a.order_.empty_, &_a.order_.ready_}) {
          out += '#';
          for (const int32_t t : *list) out += std::to_string(t) + ',';
        }
        for (const ThreadsGuard& g : _a.guards_) out += (g.isNegated_ ? "#!" : "#") + g.text_;
        return out;
      }  // access_key

      // keeps the items that more than one thread uses, or a thread of a repeated start. a static or global variable of
      // one thread also stays: it is safe now, but a second thread would make a race. an access of an object also
      // belongs to the items in the object: a call that gets the whole object can change them
      void finish() {
        // a pointer or a smart pointer is an object of its own: a write of it does not change the object that it points
        // to. a reference is the object
        const auto is_pointer = [](const clang::ValueDecl* _d) {
          const clang::QualType t        = _d ? _d->getType().getNonReferenceType() : clang::QualType();
          const clang::CXXRecordDecl* rd = t.isNull() ? nullptr : record_of(t);
          return !t.isNull() &&
                 (t->isPointerType() || (rd && is_in_std(rd) && has_name(rd, {"unique_ptr", "shared_ptr"})));
        };
        std::vector<size_t> own(items_.size());
        for (size_t i = 0; i < items_.size(); ++i) own[i] = items_[i].raw_.size();
        for (size_t i = 0; i < items_.size(); ++i) {
          const std::string key = items_[i].item_.key_;
          for (size_t pos = key.find('/'); pos != std::string::npos; pos = key.find('/', pos + 1)) {
            const auto it = itemIndex_.find(key.substr(0, pos));
            if (it == itemIndex_.end() || is_pointer(items_[it->second].item_.decl_)) continue;
            const std::vector<RawAccess>& outer = items_[it->second].raw_;
            std::vector<RawAccess> whole(outer.begin(), outer.begin() + std::ptrdiff_t(own[it->second]));
            for (RawAccess& r : whole) r.isWhole_ = true;
            items_[i].raw_.insert(items_[i].raw_.end(), whole.begin(), whole.end());
          }
        }

        for (size_t i = 0; i < items_.size(); ++i) {
          RawItem& raw = items_[i];
          if (raw.item_.kind_ == "whole") continue;
          std::vector<int32_t> threads;
          for (const RawAccess& r : raw.raw_)
            if (!llvm::is_contained(threads, ctxs_[r.ctx_].thread_)) threads.push_back(ctxs_[r.ctx_].thread_);
          const bool isRepeated = std::ranges::any_of(
              threads, [&](const int32_t _t) { return _t >= 0 && model_.threads_[_t].isRepeated_; });
          const bool isStatic = raw.item_.kind_ == "static" || raw.item_.kind_ == "global";
          if (threads.size() < 2 && !isRepeated && !isStatic) continue;

          std::unordered_set<std::string> seen;
          for (const RawAccess& r : raw.raw_) {
            ThreadsAccess a = complete(r, raw.item_.key_);
            if (seen.insert(access_key(a)).second) raw.item_.accesses_.push_back(std::move(a));
          }
          std::ranges::stable_sort(raw.item_.accesses_, [&](const ThreadsAccess& _x, const ThreadsAccess& _y) {
            return is_before(_x.expr_, _y.expr_);
          });
          model_.items_.push_back(std::move(raw.item_));
        }
      }  // finish
    };  // ThreadsAnalysis
  }  // namespace Detail

  [[nodiscard]] inline ThreadsModel build_threads(clang::ASTUnit& _ast, const ThreadsOptions& _opts) {
    using Clock = std::chrono::steady_clock;
    const Detail::LockCacheScope lockCache;
    ThreadsModel out;
    Clock::time_point start                           = Clock::now();
    const std::vector<const clang::FunctionDecl*> fns = main_file_functions(_ast);
    out.functionsMs_ = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
    {
      Detail::ThreadsAnalysis analysis(_ast.getASTContext(), _opts, out);
      analysis.run(fns);
      start = Clock::now();
    }
    out.cleanupMs_ = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
    return out;
  }  // build_threads

  // gives each access of a member trace its runs from the threads analysis of the translation unit: the threads that
  // run it, the locks on the way to it, and the threads that it is in sequence with. the walk of the analysis follows
  // each call, so a function that more than one thread calls gets a run for each thread. a thread of the analysis
  // joins the thread of the trace with the same start, or it becomes a new thread of the trace
  inline void add_member_runs(MemberModel& _member, const ThreadsModel& _threads) {
    std::vector<int32_t> thread_of(_threads.threads_.size(), -1);
    for (size_t t = 0; t < _threads.threads_.size(); ++t) {
      const ThreadsStart& s  = _threads.threads_[t];
      const clang::Decl* run = !s.at_ && s.runs_ >= 0 ? _threads.bodies_[s.runs_].fn_ : nullptr;  // QThread::run
      auto it                = std::ranges::find_if(_member.threads_, [&](const ThreadStart& _m) {
        if (s.at_) return _m.at_ == s.at_;
        return _m.decl_ && run && _m.decl_->getCanonicalDecl() == run->getCanonicalDecl();
      });
      if (it == _member.threads_.end()) {
        _member.threads_.push_back(ThreadStart{s.at_, run, s.via_, s.isRepeated_});
        it = std::prev(_member.threads_.end());
      }
      thread_of[t] = int32_t(it - _member.threads_.begin());
    }
    const auto trace_thread = [&](const int32_t _t) -> int32_t {
      return _t >= 0 && _t < int32_t(thread_of.size()) ? thread_of[_t] : -1;
    };

    // the accesses of the analysis by the place of their name
    std::unordered_map<clang::SourceLocation::UIntTy, std::vector<const ThreadsAccess*>> at;
    for (const ThreadsItem& item : _threads.items_)
      for (const ThreadsAccess& a : item.accesses_)
        if (!a.isWhole_) at[Detail::name_loc(a.expr_).getRawEncoding()].push_back(&a);

    for (MemberRef& r : _member.refs_) {
      const auto it = r.expr_ ? at.find(r.loc_.getRawEncoding()) : at.end();
      if (it == at.end()) continue;
      for (const ThreadsAccess* a : it->second) {
        MemberRun run;
        run.thread_ = trace_thread(a->thread_);
        run.locks_  = a->locks_;
        for (const std::vector<int32_t>* list :
             {&a->order_.after_, &a->order_.before_, &a->order_.empty_, &a->order_.ready_})
          for (const int32_t t : *list)
            if (const int32_t m = trace_thread(t); m >= 0 && !llvm::is_contained(run.ordered_, m))
              run.ordered_.push_back(m);
        std::ranges::sort(run.ordered_);
        const bool isKnown = std::ranges::any_of(r.runs_, [&](const MemberRun& _x) {
          return _x.thread_ == run.thread_ && _x.locks_ == run.locks_ && _x.ordered_ == run.ordered_;
        });
        if (!isKnown) r.runs_.push_back(std::move(run));
      }
    }
  }  // add_member_runs

  //----------------------------------
  // Json

  [[nodiscard]] inline JsonObject threads_to_json(const ThreadsModel& _model, clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const auto line_of             = [&](const clang::SourceLocation _loc) {
      return int64_t(sm.getExpansionLineNumber(sm.getFileLoc(_loc)));
    };
    const auto place = [&](const clang::SourceLocation _loc) {
      const clang::SourceLocation at = sm.getFileLoc(_loc);
      return JsonObject{{"file", Detail::file_of(sm, at)},
                        {"line", int64_t(sm.getExpansionLineNumber(at))},
                        {"col", int64_t(sm.getExpansionColumnNumber(at))}};
    };
    const auto ints = [](const std::vector<int32_t>& _list) {
      JsonArray out;
      for (const int32_t i : _list) out.push_back(int64_t(i));
      return out;
    };
    const auto strings = [](const std::vector<std::string>& _list) {
      JsonArray out;
      for (const std::string& s : _list) out.push_back(s);
      return out;
    };

    // the bodies that the json uses: the bodies of the threads, and the bodies of the accesses and of their calls
    std::vector<int32_t> index(_model.bodies_.size(), -1);
    JsonArray bodies;
    const auto body_ref = [&](const int32_t _b) -> int64_t {
      if (_b < 0) return -1;
      if (index[_b] < 0) {
        index[_b]                        = int32_t(bodies.size());
        const ThreadsBody& b             = _model.bodies_[_b];
        const clang::SourceRange range   = b.lambda_ ? b.lambda_->getSourceRange() : b.fn_->getSourceRange();
        const clang::SourceLocation name = sm.getFileLoc(b.lambda_ ? b.lambda_->getBeginLoc() : b.fn_->getLocation());
        const char* kind                 = "function";
        if (b.lambda_)
          kind = "lambda";
        else if (llvm::isa<clang::CXXConstructorDecl>(b.fn_))
          kind = "constructor";
        else if (llvm::isa<clang::CXXDestructorDecl>(b.fn_))
          kind = "destructor";
        else if (llvm::isa<clang::CXXMethodDecl>(b.fn_))
          kind = "method";
        bodies.push_back(JsonObject{{"name", b.lambda_ ? std::string("lambda") : b.fn_->getNameAsString()},
                                    {"qualifiedName", b.lambda_ ? std::string() : b.fn_->getQualifiedNameAsString()},
                                    {"kind", kind},
                                    {"file", Detail::file_of(sm, name)},
                                    {"line", int64_t(sm.getExpansionLineNumber(name))},
                                    {"first", line_of(range.getBegin())},
                                    {"last", line_of(range.getEnd())},
                                    {"threads", ints(b.threads_)}});
      }
      return index[_b];
    };
    for (int32_t b = 0; b < int32_t(_model.bodies_.size()); ++b)
      if (std::ranges::any_of(_model.bodies_[b].threads_, [](const int32_t _t) { return _t >= 0; })) body_ref(b);

    JsonArray threads;
    for (const ThreadsStart& s : _model.threads_) {
      JsonObject o{{"via", s.via_},
                   {"name", s.name_},
                   {"handle", s.handleText_},
                   {"isRepeated", s.isRepeated_},
                   {"isJoined", s.isJoined_},
                   {"fn", body_ref(s.body_ >= 0 ? _model.bodies_[s.body_].root_ : -1)},
                   {"runs", body_ref(s.runs_)}};
      if (s.at_)
        o["at"] = place(s.at_->getBeginLoc());
      else if (s.runs_ >= 0)
        o["at"] = place(_model.bodies_[s.runs_].fn_->getLocation());
      JsonArray joins;
      for (const ThreadsJoin& j : s.joins_) {
        // a destructor at the end of a block: the closing brace
        JsonObject jo = place(j.call_ ? j.call_->getExprLoc() : j.at_->getEndLoc());
        jo["kind"]    = j.kind_;
        jo["fn"]      = body_ref(_model.bodies_[j.body_].root_);
        joins.push_back(std::move(jo));
      }
      o["joins"] = std::move(joins);
      threads.push_back(std::move(o));
    }

    JsonArray items;
    for (const ThreadsItem& item : _model.items_) {
      JsonArray refs;
      for (const ThreadsAccess& a : item.accesses_) {
        JsonObject o = Detail::place_to_json(Detail::name_loc(a.expr_), _ctx);
        o["role"]    = Detail::role_name(a.role_);
        if (a.isAlsoRead_) o["alsoRead"] = true;
        if (a.isWhole_) o["whole"] = true;
        if (a.isAtomic_) o["atomic"] = true;
        o["thread"] = int64_t(a.thread_);
        o["fn"]     = body_ref(a.body_);
        o["path"]   = a.path_;
        o["sub"]    = strings(a.sub_);
        o["locks"]  = strings(a.locks_);
        JsonObject order;
        if (!a.order_.after_.empty()) order["after"] = ints(a.order_.after_);
        if (!a.order_.before_.empty()) order["before"] = ints(a.order_.before_);
        if (!a.order_.empty_.empty()) order["empty"] = ints(a.order_.empty_);
        if (!a.order_.ready_.empty()) order["ready"] = ints(a.order_.ready_);
        o["order"] = std::move(order);
        JsonArray guards;
        for (const ThreadsGuard& g : a.guards_)
          guards.push_back(JsonObject{{"text", g.text_}, {"isNegated", g.isNegated_}});
        o["guards"] = std::move(guards);
        JsonArray via;
        for (const ThreadsVia& v : a.via_) {
          JsonObject vo = place(v.at_->getBeginLoc());
          vo["fn"]      = body_ref(v.body_);
          via.push_back(std::move(vo));
        }
        o["via"] = std::move(via);
        if (a.swapThread_ >= 0)
          o["swap"] = JsonObject{{"thread", int64_t(a.swapThread_)}, {"from", a.swapFrom_}, {"to", a.swapTo_}};
        refs.push_back(std::move(o));
      }

      const clang::PrintingPolicy policy(_ctx.getLangOpts());
      const clang::QualType type = item.decl_->getType();
      JsonObject o{{"key", item.key_},
                   {"label", item.label_},
                   {"kind", item.kind_},
                   {"type", type.getAsString(policy)},
                   {"isAtomic", Detail::is_atomic_type(type.getNonReferenceType())},
                   {"refs", std::move(refs)}};
      if (!sm.isInSystemHeader(item.decl_->getLocation()))
        o["decl"] = Detail::place_to_json(item.decl_->getLocation(), _ctx);
      items.push_back(std::move(o));
    }

    JsonArray captures;
    for (const ThreadsCapture& c : _model.captures_) {
      const ThreadsStart& s = _model.threads_[c.thread_];
      JsonArray vars;
      for (const clang::VarDecl* v : c.vars_) {
        JsonObject vo = place(v->getLocation());
        vo["name"]    = v->getNameAsString();
        vo["kind"]    = v->getType()->isReferenceType() || v->getType()->isPointerType() ? "reference" : "object";
        vars.push_back(std::move(vo));
      }
      captures.push_back(JsonObject{{"thread", int64_t(c.thread_)},
                                    {"fn", body_ref(s.body_ >= 0 ? _model.bodies_[s.body_].root_ : -1)},
                                    {"vars", std::move(vars)}});
    }

    JsonObject stats{{"bodies", int64_t(_model.bodies_.size())},
                     {"visits", int64_t(_model.visits_)},
                     {"accesses", int64_t(_model.rawAccesses_)},
                     {"scanMs", _model.scanMs_},
                     {"prepareMs", _model.prepareMs_},
                     {"functionsMs", _model.functionsMs_},
                     {"cleanupMs", _model.cleanupMs_},
                     {"walkMs", _model.walkMs_},
                     {"finishMs", _model.finishMs_}};
    return JsonObject{{"threads", std::move(threads)},      {"items", std::move(items)},
                      {"captures", std::move(captures)},    {"functions", std::move(bodies)},
                      {"isTruncated", _model.isTruncated_}, {"stats", std::move(stats)}};
  }  // threads_to_json

}  // namespace DataFlow
