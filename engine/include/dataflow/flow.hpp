#pragma once

#include <dataflow/templates.hpp>

/*
  Flow analysis of one function, for the Flow Lens:
    > variables: the parameters, local variables, static locals and structured bindings of the function
    > refs: each declaration and each use of a variable, with a role
    > edges: reaching definitions. an edge goes from a definition to each use that it can reach
  A write replaces the old value. A possible write adds a definition, and the old definitions can still reach
  later uses. Calls with a non-const reference, member calls and writes to a member are possible writes.
  The cfg of a function does not contain the bodies of its lambdas. A reference in a lambda body takes effect at the
  lambda expression: a use gets the definitions that reach the lambda, and a write there is a possible write, because
  the lambda can run later or not at all.
*/

namespace DataFlow {

  enum class Role { DEF, WRITE, MAY_WRITE, CHECK, READ };

  struct FlowOptions {
    std::vector<std::string> read_functions_;  // functions that only read their arguments and their object
  };  // FlowOptions

  struct FlowVar {
    const clang::ValueDecl* decl_ = nullptr;
    int32_t decl_ref_             = -1;  // the ref of the declaration
  };  // FlowVar

  struct FlowRef {
    const clang::Expr* expr_ = nullptr;  // null for a declaration
    const clang::Stmt* at_   = nullptr;  // the statement where a write takes effect
    clang::SourceLocation loc_;
    int32_t var_     = -1;
    Role role_       = Role::READ;
    bool isAlsoRead_ = false;  // x += 1 reads x before it writes x
    std::string finding_;
  };  // FlowRef

  struct FlowModel {
    std::vector<FlowVar> vars_;
    std::vector<FlowRef> refs_;
    std::vector<std::pair<int32_t, int32_t>> edges_;  // definition ref, use ref
    bool hasCfg_ = true;                              // false if clang made no cfg. then the model has no edges
  };  // FlowModel

  namespace Detail {
    // true for a variable of the function. a variable of a lambda or a local class in it is not one
    [[nodiscard]] inline bool is_flow_var(const clang::ValueDecl* _d, const clang::FunctionDecl& _fn) {
      if (!_d || !_d->getIdentifier() || _d->isImplicit()) return false;
      if (!llvm::isa<clang::VarDecl>(_d) && !llvm::isa<clang::BindingDecl>(_d)) return false;
      if (llvm::isa<clang::DecompositionDecl>(_d)) return false;  // its bindings are the variables
      return _d->getParentFunctionOrMethod() == (const clang::DeclContext*)&_fn;
    }  // is_flow_var

    // collects the variables and their references. the operands of sizeof, alignof, decltype, noexcept, a requires
    // expression, an unevaluated typeid and a static_assert do not run, so they give no references
    class RefCollector : public clang::RecursiveASTVisitor<RefCollector> {
      using Base = clang::RecursiveASTVisitor<RefCollector>;
      const clang::FunctionDecl& fn_;
      FlowModel& model_;
      std::unordered_map<const clang::ValueDecl*, int32_t> index_;

     public:
      RefCollector(const clang::FunctionDecl& _fn, FlowModel& _model) : fn_(_fn), model_(_model) {}

      // sizeof of a variable length array runs its size expression
      bool TraverseUnaryExprOrTypeTraitExpr(clang::UnaryExprOrTypeTraitExpr* _e) {
        if (!_e->getTypeOfArgument()->isVariableArrayType()) return true;
        return Base::TraverseUnaryExprOrTypeTraitExpr(_e);
      }

      bool TraverseCXXTypeidExpr(clang::CXXTypeidExpr* _e) {
        return !_e->isPotentiallyEvaluated() || Base::TraverseCXXTypeidExpr(_e);
      }

      bool TraverseCXXNoexceptExpr(clang::CXXNoexceptExpr*) { return true; }
      bool TraverseRequiresExpr(clang::RequiresExpr*) { return true; }
      bool TraverseStaticAssertDecl(clang::StaticAssertDecl*) { return true; }
      bool TraverseDecltypeTypeLoc(clang::DecltypeTypeLoc, bool) { return true; }
      bool TraverseDecltypeType(clang::DecltypeType*, bool) { return true; }
      bool TraverseTypeOfExprTypeLoc(clang::TypeOfExprTypeLoc, bool) { return true; }
      bool TraverseTypeOfExprType(clang::TypeOfExprType*, bool) { return true; }

      bool VisitVarDecl(clang::VarDecl* _d) {
        add_declaration(_d);
        return true;
      }

      bool VisitBindingDecl(clang::BindingDecl* _d) {
        add_declaration(_d);
        return true;
      }

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        const auto it = index_.find(_e->getDecl());
        if (it == index_.end()) return true;
        FlowRef ref;
        ref.expr_ = _e;
        ref.loc_  = _e->getLocation();
        ref.var_  = it->second;
        model_.refs_.push_back(ref);
        return true;
      }  // VisitDeclRefExpr

     private:
      void add_declaration(const clang::ValueDecl* _d) {
        if (!is_flow_var(_d, fn_) || index_.contains(_d)) return;
        const int32_t var = int32_t(model_.vars_.size());
        index_[_d]        = var;
        model_.vars_.push_back(FlowVar{_d, int32_t(model_.refs_.size())});

        FlowRef ref;
        ref.loc_  = _d->getLocation();
        ref.var_  = var;
        ref.role_ = Role::DEF;
        model_.refs_.push_back(ref);
      }  // add_declaration

    };  // RefCollector

    // removes the variables that macros of other files declare and use, for example catchAssertionHandler of catch2.
    // a variable stays if a reference has its spelling in the main file: the user wrote it. so a variable from a macro
    // stays if the code of the user also uses it
    inline void drop_macro_vars(FlowModel& _model, const clang::SourceManager& _sm) {
      std::vector<bool> isKept(_model.vars_.size(), false);
      for (const FlowRef& r : _model.refs_)
        if (r.loc_.isValid() && _sm.isWrittenInMainFile(_sm.getSpellingLoc(r.loc_))) isKept[r.var_] = true;
      if (std::ranges::all_of(isKept, std::identity{})) return;

      // the new index of each kept variable, then the refs of the kept variables
      std::vector<int32_t> var_index(_model.vars_.size(), -1);
      std::vector<FlowVar> vars;
      for (size_t v = 0; v < _model.vars_.size(); ++v) {
        if (!isKept[v]) continue;
        var_index[v] = int32_t(vars.size());
        vars.push_back(_model.vars_[v]);
      }
      std::vector<FlowRef> refs;
      for (size_t i = 0; i < _model.refs_.size(); ++i) {
        FlowRef r = _model.refs_[i];
        if (var_index[r.var_] < 0) continue;
        if (int32_t(i) == _model.vars_[r.var_].decl_ref_) vars[var_index[r.var_]].decl_ref_ = int32_t(refs.size());
        r.var_ = var_index[r.var_];
        refs.push_back(std::move(r));
      }
      _model.vars_ = std::move(vars);
      _model.refs_ = std::move(refs);
    }  // drop_macro_vars

    [[nodiscard]] inline const clang::Expr* strip(const clang::Expr* _e) {
      return _e ? _e->IgnoreParenImpCasts() : nullptr;
    }

    // for a write to the whole variable: true if the write also reads the old value, as in x += 1 or ++x.
    // nullopt for all other changes, for example a call or a write to a member
    [[nodiscard]] inline std::optional<bool> assign_kind(const clang::Stmt* _m, const clang::Expr* _ref) {
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(_m)) {
        if (!b->isAssignmentOp() || strip(b->getLHS()) != _ref) return std::nullopt;
        return b->isCompoundAssignmentOp();
      }
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(_m)) {
        if (!u->isIncrementDecrementOp() || strip(u->getSubExpr()) != _ref) return std::nullopt;
        return true;
      }
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_m)) {
        if (op->getNumArgs() == 0 || strip(op->getArg(0)) != _ref) return std::nullopt;
        switch (op->getOperator()) {
          case clang::OO_Equal:
            return false;
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
            return true;
          default:
            return std::nullopt;
        }
      }
      return std::nullopt;
    }  // assign_kind

    // true for a call of a function that only reads its arguments and its object: the format functions of std, fmt
    // and spdlog, and the functions of _reads. these functions take forwarding references, and the analyzer of clang
    // reports them as writes. _reads comes from the setting dataflow.flow.readFunctions
    [[nodiscard]] inline bool is_read_only_call(const clang::Stmt* _m, const std::vector<std::string>& _reads) {
      static const std::vector<std::string> known = {
          "fmt::format",          "fmt::format_to",       "fmt::format_to_n",      "fmt::formatted_size",
          "fmt::print",           "fmt::println",         "fmt::vformat",          "spdlog::trace",
          "spdlog::debug",        "spdlog::info",         "spdlog::warn",          "spdlog::error",
          "spdlog::critical",     "spdlog::log",          "spdlog::logger::trace", "spdlog::logger::debug",
          "spdlog::logger::info", "spdlog::logger::warn", "spdlog::logger::error", "spdlog::logger::critical",
          "spdlog::logger::log"};
      const auto* call              = llvm::dyn_cast_or_null<clang::CallExpr>(_m);
      const clang::FunctionDecl* fn = call ? call->getDirectCallee() : nullptr;
      if (!fn || !fn->getIdentifier()) return false;
      if (name_in(fn, _reads) || name_in(fn, known)) return true;
      if (!fn->isInStdNamespace()) return false;
      return llvm::is_contained({"format", "format_to", "format_to_n", "formatted_size", "print", "println",
                                 "make_format_args", "make_wformat_args"},
                                fn->getName());
    }  // is_read_only_call

    // the statement that changes _e, or with _pointee the object that _e points to. null if no statement changes it
    [[nodiscard]] inline const clang::Stmt* find_change(clang::ExprMutationAnalyzer& _mutation, const clang::Expr* _e,
                                                        const bool _pointee,
                                                        const std::vector<std::string>& _reads = {}) {
      const clang::Stmt* m = _pointee ? _mutation.findPointeeMutation(_e) : _mutation.findMutation(_e);
      return is_read_only_call(m, _reads) || is_template_read(m, _e) ? nullptr : m;
    }  // find_change

    // true for a call of an accessor on the reference when the code only reads through the result.
    // the analyzer of clang reports each call of a non-const member function as a write
    [[nodiscard]] inline bool is_read_through_accessor(const clang::Stmt* _m, const clang::Expr* _ref,
                                                       clang::ExprMutationAnalyzer& _mutation,
                                                       const std::vector<std::string>& _reads = {}) {
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_m)) {
        if (op->getNumArgs() == 0 || strip(op->getArg(0)) != _ref) return false;
        switch (op->getOperator()) {
          case clang::OO_Arrow:
            return !find_change(_mutation, op, true, _reads);
          case clang::OO_Star:
          case clang::OO_Subscript:
            return !find_change(_mutation, op, false, _reads);
          default:
            return false;
        }
      }
      if (const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(_m)) {
        const clang::CXXMethodDecl* method = call->getMethodDecl();
        if (strip(call->getImplicitObjectArgument()) != _ref || !method || !method->getIdentifier()) return false;

        // begin() and end() are not here: an iterator leaves the function, so a write through it is not visible
        if (!llvm::is_contained({"value", "get", "front", "back", "at", "data"}, method->getName())) return false;
        return !find_change(_mutation, call, call->getType()->isPointerType(), _reads);
      }

      // in a template: front(), back(), at() or value() on an object of a dependent type
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(_m)) {
        const clang::CXXDependentScopeMemberExpr* d = dependent_accessor(call);
        return d && strip(d->getBase()) == _ref && !find_change(_mutation, call, false, _reads);
      }
      return false;
    }  // is_read_through_accessor

    // true for a variable of a const type, also a reference to const. the code cannot change it after its
    // declaration. in a template, the analyzer reports an operand of a dependent operator as a possible change
    [[nodiscard]] inline bool is_const_type(const clang::QualType _t) {
      return !_t.isNull() && _t.getNonReferenceType().isConstQualified();
    }  // is_const_type

    // true for a reference that only gives its value. an lvalue-to-rvalue conversion reads the variable, so the
    // reference needs no query of the mutation analyzer. each query searches the full body, and most references are
    // such reads
    [[nodiscard]] inline bool is_plain_read(const clang::Expr* _ref, const clang::ParentMap& _pm) {
      const clang::Stmt* p = _pm.getParent(_ref);
      while (llvm::isa_and_nonnull<clang::ParenExpr>(p)) p = _pm.getParent(p);
      const auto* cast = llvm::dyn_cast_or_null<clang::ImplicitCastExpr>(p);
      return cast && cast->getCastKind() == clang::CK_LValueToRValue;
    }  // is_plain_read

    // true for a reference that a call only reads: an argument of a parameter by value or by a reference to const, and
    // the object of a const member function. the reference needs no query of the mutation analyzer. a dependent call,
    // a variadic argument and a different parameter need the query
    [[nodiscard]] inline bool is_read_by_call(const clang::Expr* _ref, const clang::ParentMap& _pm) {
      const clang::Stmt* child = _ref;
      const clang::Stmt* p     = _pm.getParent(child);
      for (; p; child = p, p = _pm.getParent(p)) {
        const auto* cast = llvm::dyn_cast<clang::ImplicitCastExpr>(p);
        const bool isKept =
            llvm::isa<clang::ParenExpr>(p) ||
            (cast && llvm::is_contained({clang::CK_NoOp, clang::CK_DerivedToBase, clang::CK_UncheckedDerivedToBase},
                                        cast->getCastKind()));
        if (!isKept) break;
      }
      if (!p) return false;

      // the object of a call of a const member function. a call through this-> does not change this, which is a pointer
      if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(p); m && m->getBase() == child) {
        const auto* md    = llvm::dyn_cast<clang::CXXMethodDecl>(m->getMemberDecl());
        const auto* call  = llvm::dyn_cast_or_null<clang::CXXMemberCallExpr>(_pm.getParent(m));
        const bool isThis = m->isArrow() && llvm::isa<clang::CXXThisExpr>(_ref->IgnoreParenImpCasts());
        return md && call && call->getCallee()->IgnoreParens() == m && (isThis || (!m->isArrow() && md->isConst()));
      }

      // an argument of a call or of a construction
      const clang::FunctionDecl* fn = nullptr;
      std::vector<const clang::Expr*> args;
      uint32_t first = 0;
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(p)) {
        fn = call->getDirectCallee();
        args.assign(call->arg_begin(), call->arg_end());
        const auto* md = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(fn);
        if (llvm::isa<clang::CXXOperatorCallExpr>(call) && md && md->isInstance()) {
          if (!args.empty() && args.front() == child) return md->isConst();  // the object of a member operator
          first = 1;
        }
      } else if (const auto* ce = llvm::dyn_cast<clang::CXXConstructExpr>(p)) {
        fn = ce->getConstructor();
        args.assign(ce->arg_begin(), ce->arg_end());
      }
      if (!fn) return false;
      for (uint32_t i = first; i < args.size(); ++i) {
        if (args[i] != child) continue;
        if (i - first >= fn->getNumParams()) return false;
        const clang::QualType t = fn->getParamDecl(i - first)->getType();
        return !t->isReferenceType() || (t->isLValueReferenceType() && t.getNonReferenceType().isConstQualified());
      }
      return false;
    }  // is_read_by_call

    // the statement that changes a reference directly: an assignment to it, ++ or --, or a call of a non-const member
    // function on it. the mutation analyzer gives the same statement first. null for the other references, which need
    // the query
    [[nodiscard]] inline const clang::Stmt* direct_change(const clang::Expr* _ref, const clang::ParentMap& _pm) {
      const clang::Stmt* child = _ref;
      const clang::Stmt* p     = _pm.getParent(child);
      for (; p; child = p, p = _pm.getParent(p)) {
        const auto* cast = llvm::dyn_cast<clang::ImplicitCastExpr>(p);
        const bool isKept =
            llvm::isa<clang::ParenExpr>(p) ||
            (cast && llvm::is_contained({clang::CK_NoOp, clang::CK_DerivedToBase, clang::CK_UncheckedDerivedToBase},
                                        cast->getCastKind()));
        if (!isKept) break;
      }
      if (const auto* b = llvm::dyn_cast_or_null<clang::BinaryOperator>(p); b && b->isAssignmentOp())
        return b->getLHS() == child ? b : nullptr;
      if (const auto* u = llvm::dyn_cast_or_null<clang::UnaryOperator>(p); u && u->isIncrementDecrementOp()) return u;
      if (const auto* m = llvm::dyn_cast_or_null<clang::MemberExpr>(p); m && m->getBase() == child && !m->isArrow()) {
        const auto* md   = llvm::dyn_cast<clang::CXXMethodDecl>(m->getMemberDecl());
        const auto* call = llvm::dyn_cast_or_null<clang::CXXMemberCallExpr>(_pm.getParent(m));
        return md && !md->isConst() && call && call->getCallee()->IgnoreParens() == m ? call : nullptr;
      }
      if (const auto* op = llvm::dyn_cast_or_null<clang::CXXOperatorCallExpr>(p);
          op && op->getNumArgs() > 0 && op->getArg(0) == child) {
        const auto* md = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(op->getDirectCallee());
        return md && md->isInstance() && !md->isConst() ? op : nullptr;
      }
      return nullptr;
    }  // direct_change

    // find_change for a reference, with the answers that need no query first: a read, a read of a call and a direct
    // change. one answer can differ: the analyzer of clang takes a reference that a conversion copies into an argument
    // of a parameter && as a change, for example the pointer _e in v.push_back(_e) with a vector of pointers to base
    [[nodiscard]] inline const clang::Stmt* change_of(clang::ExprMutationAnalyzer& _mutation, const clang::Expr* _ref,
                                                      const clang::ParentMap& _pm,
                                                      const std::vector<std::string>& _reads = {}) {
      if (is_plain_read(_ref, _pm) || is_read_by_call(_ref, _pm)) return nullptr;
      if (const clang::Stmt* m = direct_change(_ref, _pm))
        return is_read_only_call(m, _reads) || is_template_read(m, _ref) ? nullptr : m;
      return find_change(_mutation, _ref, false, _reads);
    }  // change_of

    // the outermost lambda in the function body that has the statement in its body, or null. the cfg of the function
    // contains this lambda expression, but not its body
    [[nodiscard]] inline const clang::LambdaExpr* lambda_around(const clang::Stmt* _s, const clang::ParentMap& _pm) {
      const clang::LambdaExpr* out = nullptr;
      const clang::Stmt* child     = _s;
      for (const clang::Stmt* p = _pm.getParent(child); p; child = p, p = _pm.getParent(p))
        if (const auto* l = llvm::dyn_cast<clang::LambdaExpr>(p); l && l->getBody() == child) out = l;
      return out;
    }  // lambda_around

    // true if the function returns a copy of the reference. the variable ends there, so a move is a read
    [[nodiscard]] inline bool is_returned(const clang::Expr* _ref, const clang::ParentMap& _pm) {
      const clang::Stmt* p = _pm.getParent(_ref);
      while (p && llvm::isa<clang::Expr>(p)) p = _pm.getParent(p);
      const auto* ret          = llvm::dyn_cast_or_null<clang::ReturnStmt>(p);
      const clang::Expr* value = ret ? ret->getRetValue() : nullptr;
      return value && value->isPRValue() && value->IgnoreUnlessSpelledInSource() == _ref;
    }  // is_returned

    // true if the reference is in the condition of an if, a loop, a switch or a conditional operator
    [[nodiscard]] inline bool is_in_condition(const clang::Stmt* _ref, const clang::ParentMap& _pm) {
      const clang::Stmt* child = _ref;
      for (const clang::Stmt* p = _pm.getParent(child); p; child = p, p = _pm.getParent(p)) {
        if (const auto* s = llvm::dyn_cast<clang::IfStmt>(p)) return s->getCond() == child;
        if (const auto* s = llvm::dyn_cast<clang::WhileStmt>(p)) return s->getCond() == child;
        if (const auto* s = llvm::dyn_cast<clang::DoStmt>(p)) return s->getCond() == child;
        if (const auto* s = llvm::dyn_cast<clang::ForStmt>(p)) return s->getCond() == child;
        if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(p)) return s->getCond() == child;
        if (const auto* s = llvm::dyn_cast<clang::ConditionalOperator>(p)) return s->getCond() == child;
        if (llvm::isa<clang::CompoundStmt>(p)) return false;
      }
      return false;
    }  // is_in_condition

    // calls _f for each variable that a declaration statement of the cfg defines
    template <class F>
    void for_each_declared(const clang::DeclStmt& _ds, F&& _f) {
      for (const clang::Decl* d : _ds.decls()) {
        if (const auto* dd = llvm::dyn_cast<clang::DecompositionDecl>(d))
          for (const clang::BindingDecl* b : dd->bindings()) _f(b);
        else if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d))
          _f(v);
      }
    }  // for_each_declared
  }  // namespace Detail

  // sets the role of each reference. the mutation analyzer of clang finds the changes
  inline void set_roles(FlowModel& _model, const clang::FunctionDecl& _fn, clang::ASTContext& _ctx,
                        const FlowOptions& _opts) {
    clang::Stmt* body = _fn.getBody();
    clang::ExprMutationAnalyzer mutation(*body, _ctx);
    const clang::ParentMap pm(body);

    for (FlowRef& r : _model.refs_) {
      if (!r.expr_) continue;  // a declaration
      if (Detail::is_plain_read(r.expr_, pm) || Detail::is_const_type(_model.vars_[r.var_].decl_->getType())) {
        r.role_ = Detail::is_in_condition(r.expr_, pm) ? Role::CHECK : Role::READ;
        continue;
      }
      const clang::Stmt* m  = Detail::find_change(mutation, r.expr_, false, _opts.read_functions_);
      const auto also_reads = m ? Detail::assign_kind(m, r.expr_) : std::nullopt;

      // a write to the whole variable
      if (also_reads) {
        r.at_         = m;
        r.role_       = Role::WRITE;
        r.isAlsoRead_ = *also_reads;
      }

      // a possible write: a call, a write to a member, or a non-const reference
      else if (m && !Detail::is_read_through_accessor(m, r.expr_, mutation, _opts.read_functions_) &&
               !Detail::is_returned(r.expr_, pm)) {
        r.at_   = m;
        r.role_ = Role::MAY_WRITE;
      }

      // a read. in a condition, a check
      else {
        r.role_ = Detail::is_in_condition(r.expr_, pm) ? Role::CHECK : Role::READ;
      }
    }
  }  // set_roles

  // reaching definitions over the cfg. adds an edge from each definition to each use that it reaches
  inline void add_reaching_edges(FlowModel& _model, const clang::FunctionDecl& _fn, clang::ASTContext& _ctx) {
    clang::CFG::BuildOptions opts;
    opts.setAllAlwaysAdd();  // each expression is an element, in the sequence of the evaluation
    const std::unique_ptr<clang::CFG> cfg = build_cfg(&_fn, _fn.getBody(), _ctx, opts);
    if (!cfg) {
      _model.hasCfg_ = false;
      return;
    }
    const clang::ParentMap pm(_fn.getBody());

    // the definitions: declarations, writes and possible writes
    std::vector<int32_t> defs;  // definition -> ref
    std::vector<std::vector<int32_t>> var_defs(_model.vars_.size());
    std::unordered_map<int32_t, int32_t> def_of_ref;
    std::unordered_map<const clang::ValueDecl*, int32_t> var_of_decl;
    for (int32_t v = 0; v < int32_t(_model.vars_.size()); ++v) var_of_decl[_model.vars_[v].decl_] = v;
    for (int32_t i = 0; i < int32_t(_model.refs_.size()); ++i) {
      const Role role = _model.refs_[i].role_;
      if (role != Role::DEF && role != Role::WRITE && role != Role::MAY_WRITE) continue;
      def_of_ref[i] = int32_t(defs.size());
      var_defs[_model.refs_[i].var_].push_back(int32_t(defs.size()));
      defs.push_back(i);
    }

    // the uses and the definitions at each statement
    struct Event {
      int32_t ref_ = -1;
      bool isUse_  = false;
      bool isDef_  = false;
      bool isKill_ = false;
    };  // Event
    std::unordered_map<const clang::Stmt*, std::vector<Event>> events;
    for (int32_t i = 0; i < int32_t(_model.refs_.size()); ++i) {
      const FlowRef& r = _model.refs_[i];
      if (!r.expr_) continue;  // a declaration: the cfg has its declaration statement

      // a reference in a lambda body takes effect at the lambda. a write there does not replace the old value
      const clang::LambdaExpr* lambda = Detail::lambda_around(r.expr_, pm);
      if (r.role_ == Role::READ || r.role_ == Role::CHECK)
        events[lambda ? lambda : r.expr_].push_back({i, true, false, false});
      else if (r.role_ == Role::WRITE || r.role_ == Role::MAY_WRITE)
        events[lambda ? lambda : r.at_].push_back(
            {i, r.isAlsoRead_ || r.role_ == Role::MAY_WRITE, true, r.role_ == Role::WRITE && !lambda});
    }

    const size_t n       = defs.size();
    const auto apply_def = [&](llvm::BitVector& _set, const int32_t _ref, const bool _kill) -> void {
      const auto it = def_of_ref.find(_ref);
      if (it == def_of_ref.end()) return;
      if (_kill)
        for (const int32_t d : var_defs[_model.refs_[_ref].var_]) _set.reset(d);
      _set.set(it->second);
    };
    const auto record_use = [&](const llvm::BitVector& _set, const int32_t _ref) -> void {
      for (const int32_t d : var_defs[_model.refs_[_ref].var_])
        if (_set.test(d) && defs[d] != _ref) _model.edges_.emplace_back(defs[d], _ref);
    };
    const auto transfer = [&](const clang::CFGBlock& _b, llvm::BitVector _set, const bool _record) -> llvm::BitVector {
      for (const clang::CFGElement& el : _b) {
        const auto s = el.getAs<clang::CFGStmt>();
        if (!s) continue;
        const clang::Stmt* stmt = s->getStmt();

        // a declaration defines its variables
        if (const auto* ds = llvm::dyn_cast<clang::DeclStmt>(stmt))
          Detail::for_each_declared(*ds, [&](const clang::ValueDecl* _d) {
            if (const auto it = var_of_decl.find(_d); it != var_of_decl.end())
              apply_def(_set, _model.vars_[it->second].decl_ref_, true);
          });

        const auto it = events.find(stmt);
        if (it == events.end()) continue;
        for (const Event& ev : it->second) {
          if (ev.isUse_ && _record) record_use(_set, ev.ref_);
          if (ev.isDef_) apply_def(_set, ev.ref_, ev.isKill_);
        }
      }
      return _set;
    };

    // the parameters have a definition at the entry
    llvm::BitVector entry(n);
    for (const FlowVar& v : _model.vars_) {
      if (!llvm::isa<clang::ParmVarDecl>(v.decl_)) continue;
      if (const auto it = def_of_ref.find(v.decl_ref_); it != def_of_ref.end()) entry.set(it->second);
    }

    // iterate until no set changes. then record the edges with the final sets
    std::vector<llvm::BitVector> in(cfg->getNumBlockIDs(), llvm::BitVector(n));
    std::vector<llvm::BitVector> out(cfg->getNumBlockIDs(), llvm::BitVector(n));
    for (bool changed = true; changed;) {
      changed = false;
      for (const clang::CFGBlock* b : *cfg) {
        llvm::BitVector set = b == &cfg->getEntry() ? entry : llvm::BitVector(n);
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
    for (const clang::CFGBlock* b : *cfg) transfer(*b, in[b->getBlockID()], true);
  }  // add_reaching_edges

  // marks the references that the unchecked optional access model of clang reports
  inline void add_optional_findings(FlowModel& _model, const clang::FunctionDecl& _fn, clang::ASTContext& _ctx) {
    using namespace clang::dataflow;

    UncheckedOptionalAccessDiagnoser diagnoser;
    auto res = diagnoseFunction<UncheckedOptionalAccessModel, UncheckedOptionalAccessDiagnostic>(_fn, _ctx, diagnoser);
    if (!res) {
      llvm::consumeError(res.takeError());
      return;
    }
    const clang::SourceManager& sm = _ctx.getSourceManager();
    for (const UncheckedOptionalAccessDiagnostic& d : *res) {
      const clang::SourceLocation at = sm.getExpansionLoc(d.Range.getBegin());
      for (FlowRef& r : _model.refs_)
        if (r.expr_ && sm.getExpansionLoc(r.expr_->getBeginLoc()) == at) r.finding_ = "unchecked optional access";
    }
  }  // add_optional_findings

  [[nodiscard]] inline FlowModel build_flow(const clang::FunctionDecl& _fn, clang::ASTContext& _ctx,
                                            const FlowOptions& _opts) {
    FlowModel out;
    Detail::RefCollector collector(_fn, out);
    collector.TraverseDecl((clang::FunctionDecl*)&_fn);
    Detail::drop_macro_vars(out, _ctx.getSourceManager());
    if (!_fn.getBody()) return out;

    // the mutation analyzer and the optional model need the parents of the nodes of this function only
    const TraversalScope scope(_ctx, {&_fn});
    set_roles(out, _fn, _ctx, _opts);
    add_reaching_edges(out, _fn, _ctx);
    add_optional_findings(out, _fn, _ctx);
    return out;
  }  // build_flow

  //----------------------------------
  // Json

  namespace Detail {
    [[nodiscard]] inline const char* role_name(const Role _role) {
      switch (_role) {
        case Role::DEF:
          return "def";
        case Role::WRITE:
          return "write";
        case Role::MAY_WRITE:
          return "mayWrite";
        case Role::CHECK:
          return "check";
        case Role::READ:
          return "read";
      }
      return "read";
    }  // role_name

    [[nodiscard]] inline std::string storage_of(const clang::ValueDecl* _d) {
      if (llvm::isa<clang::BindingDecl>(_d)) return "structured binding";
      const auto* v           = llvm::cast<clang::VarDecl>(_d);
      const clang::QualType t = v->getType();
      if (llvm::isa<clang::ParmVarDecl>(v)) {
        if (t->isReferenceType())
          return t.getNonReferenceType().isConstQualified() ? "parameter, const reference" : "parameter, reference";
        if (t->isPointerType()) return "parameter, pointer";
        return "parameter, by value";
      }
      if (v->isStaticLocal()) return "static local";
      return "local";
    }  // storage_of
  }  // namespace Detail

  [[nodiscard]] inline JsonObject flow_to_json(const FlowModel& _model, clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const clang::PrintingPolicy policy(_ctx.getLangOpts());

    JsonArray vars;
    for (const FlowVar& v : _model.vars_)
      vars.push_back(JsonObject{{"name", v.decl_->getNameAsString()},
                                {"type", v.decl_->getType().getAsString(policy)},
                                {"storage", Detail::storage_of(v.decl_)},
                                {"declRef", int64_t(v.decl_ref_)}});

    // columns are utf-8 bytes and start at 1. len is the length of the name in bytes.
    // a name in a macro argument gets the position of the argument in the source
    JsonArray refs;
    for (const FlowRef& r : _model.refs_) {
      const clang::SourceLocation at = sm.getFileLoc(r.loc_);
      JsonObject o{{"var", int64_t(r.var_)},
                   {"role", Detail::role_name(r.role_)},
                   {"line", int64_t(sm.getExpansionLineNumber(at))},
                   {"col", int64_t(sm.getExpansionColumnNumber(at))},
                   {"len", int64_t(clang::Lexer::MeasureTokenLength(at, sm, _ctx.getLangOpts()))}};
      if (r.isAlsoRead_) o["alsoRead"] = true;
      if (!r.finding_.empty()) o["finding"] = r.finding_;
      refs.push_back(std::move(o));
    }

    JsonArray edges;
    for (const auto& [from, to] : _model.edges_) edges.push_back(JsonArray{int64_t(from), int64_t(to)});

    return JsonObject{{"variables", std::move(vars)},
                      {"refs", std::move(refs)},
                      {"edges", std::move(edges)},
                      {"hasCfg", _model.hasCfg_}};
  }  // flow_to_json

}  // namespace DataFlow
