#pragma once

#include <dataflow/flow.hpp>

/*
  Logic analysis of one function, for the Logic Map:
    > blocks: the blocks of the cfg, with their successors and the lines of their statements
    > decisions: if, loop, switch and conditional operator, with the successor and the lines of each branch
    > chains: else-if chains that compare one value with constants
    > events: calls of the event functions with a string argument that is not empty: a string literal, or a constant
      that a string literal initializes. with no string argument, an enum constant gives the name
    > nullable: pointers, std::unique_ptr, std::shared_ptr and std::optional from the nullable functions, with their
      dereferences and their null checks. a call of a check function with the variable is also a null check
    > effects: the changes of data that lives after the call: data members, global and static variables, the objects
      of reference and pointer parameters, and in a lambda the variables that it captures by reference
  A lambda in a function has its own cfg. With a position in a lambda, the request analyzes the lambda.
  The extension evaluates the paths. A new choice needs no request to the engine.
*/

namespace DataFlow {

  enum class DecisionKind { IF, LOOP, DO, SWITCH, TERNARY };

  struct LineRange {
    uint32_t first_ = 0;
    uint32_t last_  = 0;
  };  // LineRange

  struct LogicBlock {
    std::vector<int32_t> succs_;  // -1 for an edge that the cfg marks as unreachable
    std::vector<LineRange> lines_;
  };  // LogicBlock

  struct Branch {
    std::string label_;
    int32_t succ_ = -1;  // the index in the successors of the decision block
    std::optional<LineRange> lines_;
  };  // Branch

  struct Decision {
    DecisionKind kind_       = DecisionKind::IF;
    const clang::Stmt* stmt_ = nullptr;
    int32_t block_           = -1;
    std::vector<int32_t> cond_blocks_;  // the blocks of && and || in the condition
    std::string text_;
    clang::SourceLocation loc_;
    std::vector<Branch> branches_;
    int32_t parent_ = -1;  // the decision that contains this decision
    std::string parent_branch_;
  };  // Decision

  struct ChainItem {
    int32_t decision_ = -1;
    std::string value_;
  };  // ChainItem

  struct Chain {
    std::string subject_;
    std::vector<ChainItem> items_;
    bool hasElse_ = false;
  };  // Chain

  // a range on one line. len counts utf-8 bytes
  struct Mark {
    int32_t block_ = -1;
    clang::SourceLocation loc_;
    uint32_t len_ = 0;
  };  // Mark

  struct EventCall {
    Mark at_;
    std::string function_;
    std::string label_;
  };  // EventCall

  struct NullCheck {
    int32_t block_ = -1;
    int32_t succ_  = -1;  // the successor where the pointer is not null
  };  // NullCheck

  // one assignment from a nullable function, with all dereferences and null checks of the pointer
  struct NullableVar {
    const clang::ValueDecl* decl_ = nullptr;
    std::string source_;
    Mark source_at_;
    std::vector<Mark> derefs_;
    std::vector<NullCheck> checks_;
  };  // NullableVar

  // a return statement. the mark is the keyword. a "return;" has no value
  struct ReturnPoint {
    Mark at_;
    std::string value_;
  };  // ReturnPoint

  // a change of data that lives after the call of the function. the mark is the changed expression
  struct Effect {
    Mark at_;
    std::string target_;  // the text of the changed expression, for example new_readings or charge.is_dirty
    std::string action_;  // "=", "+=", "++", or the name of the called member function, for example push_back
    std::string kind_;    // "member", "global", "parameter" or "capture"
  };  // Effect

  struct LogicOptions {
    std::vector<std::string> event_functions_;
    std::vector<std::string> nullable_functions_;
    std::vector<std::string> check_functions_;  // a call with the variable is a null check, for example is_valid(p)
  };  // LogicOptions

  struct LogicModel {
    int32_t entry_ = -1;
    int32_t exit_  = -1;
    std::vector<LogicBlock> blocks_;
    std::vector<Decision> decisions_;
    std::vector<Chain> chains_;
    std::vector<EventCall> events_;
    std::vector<NullableVar> nullable_;
    std::vector<ReturnPoint> returns_;
    std::vector<Effect> effects_;
  };  // LogicModel

  namespace Detail {
    [[nodiscard]] inline LineRange lines_of(const clang::SourceRange _range, const clang::SourceManager& _sm) {
      const clang::CharSourceRange r = _sm.getExpansionRange(_range);
      return {_sm.getExpansionLineNumber(r.getBegin()), _sm.getExpansionLineNumber(r.getEnd())};
    }  // lines_of

    // sorts the ranges and joins the ranges that overlap or touch
    inline void merge_lines(std::vector<LineRange>& _ranges) {
      std::sort(_ranges.begin(), _ranges.end(),
                [](const LineRange& _a, const LineRange& _b) -> bool { return _a.first_ < _b.first_; });
      std::vector<LineRange> out;
      for (const LineRange& r : _ranges) {
        if (!out.empty() && r.first_ <= out.back().last_ + 1)
          out.back().last_ = std::max(out.back().last_, r.last_);
        else
          out.push_back(r);
      }
      _ranges = std::move(out);
    }  // merge_lines

    // the source text on one line. white space becomes one space, and a text longer than _max ends with "..."
    [[nodiscard]] inline std::string short_text(const clang::ASTContext& _ctx, const clang::SourceRange _range,
                                                const size_t _max = 80) {
      std::string out;
      for (const char c : source_text(_ctx, _range)) {
        const bool isSpace = c == ' ' || c == '\t' || c == '\n' || c == '\r';
        if (isSpace && (out.empty() || out.back() == ' ')) continue;
        out.push_back(isSpace ? ' ' : c);
      }
      while (!out.empty() && out.back() == ' ') out.pop_back();
      if (out.size() > _max) out = out.substr(0, _max - 3) + "...";
      return out;
    }  // short_text

    // the called function of an expression, through implicit nodes
    [[nodiscard]] inline const clang::FunctionDecl* callee_of(const clang::Expr* _e) {
      const auto* call = _e ? llvm::dyn_cast<clang::CallExpr>(_e->IgnoreImplicit()->IgnoreParenImpCasts()) : nullptr;
      return call ? call->getDirectCallee() : nullptr;
    }  // callee_of

    // the string literal of an argument, also through the constructor of std::string or std::string_view, and through a
    // constant that a string literal initializes, for example constexpr const char* kDetected = "detected". _isConstant
    // tells if the literal came through a constant
    [[nodiscard]] inline const clang::StringLiteral* string_literal_of(const clang::Expr* _e,
                                                                       bool* _isConstant = nullptr) {
      if (_isConstant) *_isConstant = false;
      for (int32_t i = 0; _e && i < 8; ++i) {
        _e = _e->IgnoreImplicit()->IgnoreParenCasts();
        if (const auto* s = llvm::dyn_cast<clang::StringLiteral>(_e)) return s;
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(_e)) {
          if (c->getNumArgs() == 0) return nullptr;
          _e = c->getArg(0);
          continue;
        }
        const clang::ValueDecl* d = nullptr;
        if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_e))
          d = r->getDecl();
        else if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(_e))
          d = m->getMemberDecl();
        const auto* v = llvm::dyn_cast_or_null<clang::VarDecl>(d);
        if (!v || (!v->isConstexpr() && !v->getType().isConstQualified())) return nullptr;
        _e = v->getAnyInitializer();
        if (_isConstant) *_isConstant = true;
      }
      return nullptr;
    }  // string_literal_of

    // a type that can be null: a pointer, std::unique_ptr, std::shared_ptr or std::optional
    [[nodiscard]] inline bool is_nullable_type(const clang::QualType _t) {
      const clang::QualType t = _t.getNonReferenceType().getCanonicalType();
      if (t->isPointerType()) return true;
      const auto* rd = t->getAsCXXRecordDecl();
      return rd && rd->isInStdNamespace() && rd->getIdentifier() &&
             llvm::is_contained({"unique_ptr", "shared_ptr", "optional"}, rd->getName());
    }  // is_nullable_type

    // true for nullptr, NULL, 0 and std::nullopt
    [[nodiscard]] inline bool is_null_value(const clang::Expr* _e, clang::ASTContext& _ctx) {
      if (_e->isNullPointerConstant(_ctx, clang::Expr::NPC_ValueDependentIsNotNull) != clang::Expr::NPCK_NotNull)
        return true;
      const auto* rd = _e->IgnoreParenImpCasts()->getType()->getAsCXXRecordDecl();
      return rd && rd->isInStdNamespace() && rd->getIdentifier() && rd->getName() == "nullopt_t";
    }  // is_null_value

    // an operator that gives the object of a pointer or of a class like a pointer: *, -> and []
    [[nodiscard]] inline bool is_access_operator(const clang::OverloadedOperatorKind _op) {
      return _op == clang::OO_Star || _op == clang::OO_Arrow || _op == clang::OO_Subscript;
    }  // is_access_operator

    // a member function that gives an element or an iterator of its object, for example at() or find(). a call of it
    // changes the object only if the code writes through the result
    [[nodiscard]] inline bool is_accessor(const clang::FunctionDecl* _fn) {
      if (!_fn) return false;
      if (is_access_operator(_fn->getOverloadedOperator())) return true;
      return _fn->getIdentifier() &&
             llvm::is_contained({"at", "find", "front", "back", "data", "begin", "end", "rbegin", "rend", "lower_bound",
                                 "upper_bound", "equal_range", "value", "get"},
                                _fn->getName());
    }  // is_accessor

    // a change of an expression: the changed expression, and the statement that changes it
    struct Change {
      const clang::Expr* target_ = nullptr;
      const clang::Stmt* change_ = nullptr;
    };  // Change

    // the direct change of an expression: an assignment, ++ or --, or a call of a non-const member function. a call of
    // an accessor changes the object only if the code writes through its result. then the result is the changed
    // expression, for example v[i] in v[i] = 0
    [[nodiscard]] inline std::optional<Change> effect_change(const clang::Expr* _e, const clang::ParentMap& _pm) {
      const clang::Stmt* m = direct_change(_e, _pm);
      if (!m) return std::nullopt;
      const auto* call = llvm::dyn_cast<clang::CallExpr>(m);
      if (!call || !is_accessor(call->getDirectCallee())) return Change{_e, m};
      if (const clang::Stmt* outer = direct_change(call, _pm)) return Change{call, outer};
      return std::nullopt;
    }  // effect_change

    // the object that a local variable gives access to: the initializer of a local reference, for example data in
    // auto& d = data; the initializer of a local pointer that the code writes through, with no &; and the container of
    // an iterator from an accessor, for example data in auto it = data.begin(). _isPointee tells if the code writes
    // through the variable, and gets the same information for the result
    [[nodiscard]] inline const clang::Expr* alias_target(const clang::VarDecl& _v, bool& _isPointee) {
      const clang::Expr* init = _v.getInit();
      if (!init || !_v.hasLocalStorage()) return nullptr;
      init                    = init->IgnoreImplicit()->IgnoreParenImpCasts();
      const clang::QualType t = _v.getType();
      if (t->isLValueReferenceType()) return t.getNonReferenceType().isConstQualified() ? nullptr : init;
      if (t->isPointerType()) {
        if (!_isPointee) return nullptr;
        if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(init); u && u->getOpcode() == clang::UO_AddrOf) {
          _isPointee = false;
          return u->getSubExpr();
        }
        return init;
      }
      if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(init); c && c->getNumArgs() == 1)
        init = c->getArg(0)->IgnoreImplicit()->IgnoreParenImpCasts();
      const auto* call = llvm::dyn_cast<clang::CXXMemberCallExpr>(init);
      if (!call || !is_accessor(call->getMethodDecl())) return nullptr;
      const auto* m = llvm::dyn_cast<clang::MemberExpr>(call->getCallee()->IgnoreParenImpCasts());
      if (!m) return nullptr;
      _isPointee = _isPointee || m->isArrow();
      return m->getBase();
    }  // alias_target

    // the kind of the data of a changed expression if the data lives after the call of the function: "member" for a
    // data member of this, "global" for a global or static variable, "parameter" for the object of a reference or
    // pointer parameter, and "capture" for a variable that the lambda _lambda captures by reference. null for a local
    // variable and for a parameter by value
    [[nodiscard]] inline const char* lasting_kind(const clang::Expr* _e, const clang::CXXRecordDecl* _lambda) {
      bool isPointee = false;  // the expression is the object that a pointer points to
      for (int32_t i = 0; _e && i < 32; ++i) {
        _e = _e->IgnoreParenImpCasts();
        if (llvm::isa<clang::CXXThisExpr>(_e)) return "member";
        if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(_e)) {
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(m->getMemberDecl()); v && v->hasGlobalStorage())
            return "global";
          isPointee = isPointee || m->isArrow();
          _e        = m->getBase();
        } else if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(_e)) {
          isPointee = isPointee || a->getBase()->getType()->isPointerType();
          _e        = a->getBase();
        } else if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(_e); u && u->getOpcode() == clang::UO_Deref) {
          isPointee = true;
          _e        = u->getSubExpr();
        } else if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_e);
                   op && is_access_operator(op->getOperator()) && op->getNumArgs() > 0) {
          _e = op->getArg(0);
        } else if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_e)) {
          const auto* v = llvm::dyn_cast<clang::VarDecl>(r->getDecl());
          if (!v) return nullptr;
          if (v->hasGlobalStorage()) return "global";
          if (const auto* p = llvm::dyn_cast<clang::ParmVarDecl>(v)) {
            const clang::QualType t = p->getType();
            if (t->isLValueReferenceType() && !t.getNonReferenceType().isConstQualified()) return "parameter";
            return isPointee && t->isPointerType() ? "parameter" : nullptr;
          }
          if (!r->refersToEnclosingVariableOrCapture()) {
            if (const clang::Expr* init = alias_target(*v, isPointee)) {
              _e = init;
              continue;
            }
          }
          if (!_lambda || !r->refersToEnclosingVariableOrCapture()) return nullptr;
          llvm::DenseMap<const clang::ValueDecl*, clang::FieldDecl*> captures;
          clang::FieldDecl* self = nullptr;
          _lambda->getCaptureFields(captures, self);
          const clang::FieldDecl* f = captures.lookup(v);
          return f && f->getType()->isReferenceType() ? "capture" : nullptr;
        } else {
          return nullptr;
        }
      }
      return nullptr;
    }  // lasting_kind

    // the name of the change for the path: the operator, or the name of the called member function
    [[nodiscard]] inline std::string action_of(const clang::Stmt* _change) {
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(_change)) return b->getOpcodeStr().str();
      if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(_change))
        return clang::UnaryOperator::getOpcodeStr(u->getOpcode()).str();
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_change))
        return clang::getOperatorSpelling(op->getOperator());
      const auto* call = llvm::dyn_cast<clang::CallExpr>(_change);
      const auto* fn   = call ? call->getDirectCallee() : nullptr;
      return fn ? fn->getNameAsString() : std::string("call");
    }  // action_of

    // the lambdas of a function body in the sequence of the source, also the lambdas in lambdas
    [[nodiscard]] inline std::vector<const clang::LambdaExpr*> lambdas_of(const clang::FunctionDecl& _fn) {
      std::vector<const clang::LambdaExpr*> out;
      std::vector<const clang::Stmt*> todo{_fn.getBody()};
      while (!todo.empty()) {
        const clang::Stmt* s = todo.back();
        todo.pop_back();
        if (!s) continue;
        if (const auto* l = llvm::dyn_cast<clang::LambdaExpr>(s)) out.push_back(l);
        for (const clang::Stmt* c : s->children()) todo.push_back(c);
      }
      const clang::SourceManager& sm = _fn.getASTContext().getSourceManager();
      std::ranges::sort(out, [&](const clang::LambdaExpr* _a, const clang::LambdaExpr* _b) {
        return sm.isBeforeInTranslationUnit(_a->getBeginLoc(), _b->getBeginLoc());
      });
      return out;
    }  // lambdas_of

    // the index of the innermost lambda whose body contains a position. -1 if no lambda contains it. _line and _col
    // start at 1
    [[nodiscard]] inline int32_t lambda_at(const std::vector<const clang::LambdaExpr*>& _lambdas,
                                           const clang::SourceManager& _sm, const uint32_t _line, const uint32_t _col) {
      const auto key = [&](const clang::SourceLocation _loc) -> uint64_t {
        const clang::SourceLocation exp = _sm.getExpansionLoc(_loc);
        return (uint64_t(_sm.getExpansionLineNumber(exp)) << 32) | _sm.getExpansionColumnNumber(exp);
      };
      const uint64_t pos = (uint64_t(_line) << 32) | _col;
      int32_t out        = -1;
      uint64_t best      = UINT64_MAX;
      for (int32_t i = 0; i < int32_t(_lambdas.size()); ++i) {
        const clang::Stmt* body = _lambdas[i]->getBody();
        if (!body) continue;
        const uint64_t begin = key(body->getBeginLoc());
        const uint64_t end   = key(body->getEndLoc());
        if (pos < begin || pos > end || end - begin >= best) continue;
        best = end - begin;
        out  = i;
      }
      return out;
    }  // lambda_at

    // the mark of a range in a block
    [[nodiscard]] inline Mark mark_of(const clang::SourceRange _range, const int32_t _block,
                                      const clang::ASTContext& _ctx) {
      const Span s = span_of(_range, _ctx);
      return Mark{_block, s.loc_, s.len_};
    }  // mark_of

    // the condition of a decision statement, or null for other statements
    [[nodiscard]] inline const clang::Stmt* condition_of(const clang::Stmt* _s) {
      if (const auto* s = llvm::dyn_cast<clang::IfStmt>(_s)) return s->getCond();
      if (const auto* s = llvm::dyn_cast<clang::WhileStmt>(_s)) return s->getCond();
      if (const auto* s = llvm::dyn_cast<clang::DoStmt>(_s)) return s->getCond();
      if (const auto* s = llvm::dyn_cast<clang::ForStmt>(_s)) return s->getCond();
      if (const auto* s = llvm::dyn_cast<clang::CXXForRangeStmt>(_s)) return s->getCond();
      if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(_s)) return s->getCond();
      if (const auto* s = llvm::dyn_cast<clang::AbstractConditionalOperator>(_s)) return s->getCond();
      return nullptr;
    }  // condition_of

    // the text of the condition. a condition variable gives its declaration
    [[nodiscard]] inline std::string condition_text(const clang::Stmt* _s, const clang::ASTContext& _ctx,
                                                    const size_t _max = 80) {
      const clang::VarDecl* var = nullptr;
      if (const auto* s = llvm::dyn_cast<clang::IfStmt>(_s)) var = s->getConditionVariable();
      if (const auto* s = llvm::dyn_cast<clang::WhileStmt>(_s)) var = s->getConditionVariable();
      if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(_s)) var = s->getConditionVariable();
      if (var) return short_text(_ctx, var->getSourceRange(), _max);
      if (const auto* s = llvm::dyn_cast<clang::CXXForRangeStmt>(_s))
        return short_text(_ctx, {s->getLoopVariable()->getBeginLoc(), s->getRangeInit()->getEndLoc()}, _max);
      const clang::Stmt* cond = condition_of(_s);
      return cond ? short_text(_ctx, cond->getSourceRange(), _max) : std::string();
    }  // condition_text

    // the decision that contains the statement in its condition, with a walk up through the expressions
    [[nodiscard]] inline int32_t decision_of_condition(const clang::Stmt* _s, const clang::ParentMap& _pm,
                                                       const std::unordered_map<const clang::Stmt*, int32_t>& _index) {
      const clang::Stmt* child = _s;
      for (const clang::Stmt* p = _pm.getParent(child); p; child = p, p = _pm.getParent(p)) {
        if (const auto it = _index.find(p); it != _index.end() && condition_of(p) == child) return it->second;
        if (!llvm::isa<clang::Expr>(p)) return -1;
      }
      return -1;
    }  // decision_of_condition

    // for "subject == constant": the text of the subject and the text of the constant
    [[nodiscard]] inline std::optional<std::pair<std::string, std::string>> compare_with_constant(
        const clang::Expr* _cond, const clang::ASTContext& _ctx) {
      const clang::Expr* e   = _cond->IgnoreParenImpCasts();
      const clang::Expr* lhs = nullptr;
      const clang::Expr* rhs = nullptr;
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(e); b && b->getOpcode() == clang::BO_EQ) {
        lhs = b->getLHS();
        rhs = b->getRHS();
      } else if (const auto* o = llvm::dyn_cast<clang::CXXOperatorCallExpr>(e);
                 o && o->getOperator() == clang::OO_EqualEqual && o->getNumArgs() == 2) {
        lhs = o->getArg(0);
        rhs = o->getArg(1);
      } else if (const auto* r = llvm::dyn_cast<clang::CXXRewrittenBinaryOperator>(e)) {
        const auto form = r->getDecomposedForm();
        if (form.Opcode == clang::BO_EQ) {
          lhs = form.LHS;
          rhs = form.RHS;
        }
      }
      if (!lhs || !rhs) return std::nullopt;

      const auto is_constant = [&](const clang::Expr* _e) -> bool {
        return !_e->isValueDependent() && _e->isEvaluatable(_ctx);
      };
      if (is_constant(lhs) == is_constant(rhs)) return std::nullopt;
      if (is_constant(lhs)) std::swap(lhs, rhs);
      return std::pair{short_text(_ctx, lhs->getSourceRange()), short_text(_ctx, rhs->getSourceRange())};
    }  // compare_with_constant

    // the branches of a decision statement. empty for a statement that is not a decision
    [[nodiscard]] inline std::vector<Branch> branches_of(const clang::Stmt* _t, const clang::CFGBlock& _b,
                                                         const clang::ASTContext& _ctx, DecisionKind& _kind) {
      const clang::SourceManager& sm = _ctx.getSourceManager();
      const auto lines_of_stmt       = [&](const clang::Stmt* _s) -> std::optional<LineRange> {
        if (!_s) return std::nullopt;
        return lines_of(_s->getSourceRange(), sm);
      };

      if (const auto* s = llvm::dyn_cast<clang::IfStmt>(_t)) {
        _kind = DecisionKind::IF;
        return {{"yes", 0, lines_of_stmt(s->getThen())}, {"no", 1, lines_of_stmt(s->getElse())}};
      }
      if (llvm::isa<clang::WhileStmt, clang::ForStmt, clang::CXXForRangeStmt>(_t)) {
        _kind                   = DecisionKind::LOOP;
        const clang::Stmt* body = nullptr;
        if (const auto* s = llvm::dyn_cast<clang::WhileStmt>(_t)) body = s->getBody();
        if (const auto* s = llvm::dyn_cast<clang::ForStmt>(_t)) body = s->getBody();
        if (const auto* s = llvm::dyn_cast<clang::CXXForRangeStmt>(_t)) body = s->getBody();
        return {{"enter", 0, lines_of_stmt(body)}, {"skip", 1, std::nullopt}};
      }
      if (llvm::isa<clang::DoStmt>(_t)) {
        _kind = DecisionKind::DO;
        return {{"repeat", 0, std::nullopt}, {"once", 1, std::nullopt}};
      }
      if (const auto* s = llvm::dyn_cast<clang::AbstractConditionalOperator>(_t)) {
        _kind = DecisionKind::TERNARY;
        return {{"yes", 0, lines_of_stmt(s->getTrueExpr())}, {"no", 1, lines_of_stmt(s->getFalseExpr())}};
      }

      // switch: one branch for each case label. its lines go to the line before the next label
      const auto* s = llvm::dyn_cast<clang::SwitchStmt>(_t);
      if (!s || !s->getBody()) return {};
      _kind = DecisionKind::SWITCH;
      std::vector<const clang::SwitchCase*> labels;
      for (const clang::SwitchCase* c = s->getSwitchCaseList(); c; c = c->getNextSwitchCase()) labels.push_back(c);
      std::sort(labels.begin(), labels.end(), [&](const clang::SwitchCase* _a, const clang::SwitchCase* _c) -> bool {
        return sm.isBeforeInTranslationUnit(_a->getBeginLoc(), _c->getBeginLoc());
      });
      const uint32_t body_end = lines_of(s->getBody()->getSourceRange(), sm).last_;

      std::vector<Branch> out;
      int32_t i = 0;
      for (const clang::CFGBlock::AdjacentBlock& adj : _b.succs()) {
        const clang::CFGBlock* succ = adj.getReachableBlock();
        const clang::Stmt* label    = succ ? succ->getLabel() : nullptr;
        const auto it               = std::find(labels.begin(), labels.end(), label);
        if (it == labels.end()) {
          out.push_back({"no case", i++, std::nullopt});
          continue;
        }
        const uint32_t first = lines_of((*it)->getSourceRange(), sm).first_;
        const uint32_t last =
            it + 1 == labels.end() ? body_end - 1 : lines_of((*(it + 1))->getSourceRange(), sm).first_ - 1;
        const auto* c = llvm::dyn_cast<clang::CaseStmt>(*it);
        out.push_back({c ? short_text(_ctx, c->getLHS()->getSourceRange()) : "default", i++,
                       LineRange{first, std::max(first, last)}});
      }
      return out;
    }  // branches_of

    // the branch of a decision that contains the child statement. empty if the child is the condition
    [[nodiscard]] inline std::string branch_of_child(const Decision& _d, const clang::Stmt* _child,
                                                     const clang::Stmt* _inner, const clang::SourceManager& _sm) {
      const clang::Stmt* p = _d.stmt_;
      if (const auto* s = llvm::dyn_cast<clang::IfStmt>(p)) {
        if (_child == s->getThen()) return "yes";
        if (_child == s->getElse()) return "no";
        return {};
      }
      if (const auto* s = llvm::dyn_cast<clang::AbstractConditionalOperator>(p)) {
        if (_child == s->getTrueExpr()) return "yes";
        if (_child == s->getFalseExpr()) return "no";
        return {};
      }
      if (const auto* s = llvm::dyn_cast<clang::WhileStmt>(p)) return _child == s->getBody() ? "enter" : "";
      if (const auto* s = llvm::dyn_cast<clang::ForStmt>(p)) return _child == s->getBody() ? "enter" : "";
      if (const auto* s = llvm::dyn_cast<clang::CXXForRangeStmt>(p)) return _child == s->getBody() ? "enter" : "";
      if (const auto* s = llvm::dyn_cast<clang::DoStmt>(p)) return _child == s->getBody() ? "body" : "";

      // switch: the last case label before the inner statement
      const auto* s = llvm::dyn_cast<clang::SwitchStmt>(p);
      if (!s || _child != s->getBody()) return {};
      std::string out;
      const clang::SwitchCase* best = nullptr;
      for (const clang::SwitchCase* c = s->getSwitchCaseList(); c; c = c->getNextSwitchCase()) {
        if (_sm.isBeforeInTranslationUnit(_inner->getBeginLoc(), c->getBeginLoc())) continue;
        if (best && _sm.isBeforeInTranslationUnit(c->getBeginLoc(), best->getBeginLoc())) continue;
        best = c;
      }
      for (const Branch& b : _d.branches_)
        if (best && b.lines_ &&
            b.lines_->first_ == _sm.getExpansionLineNumber(_sm.getExpansionLoc(best->getBeginLoc())))
          out = b.label_;
      return out;
    }  // branch_of_child
  }  // namespace Detail

  [[nodiscard]] inline LogicModel build_logic(const clang::FunctionDecl& _fn, clang::ASTContext& _ctx,
                                              const LogicOptions& _opts) {
    LogicModel out;
    clang::CFG::BuildOptions build;
    build.setAllAlwaysAdd();  // each expression is an element, so each call has a block
    const std::unique_ptr<clang::CFG> cfg = build_cfg(&_fn, _fn.getBody(), _ctx, build);
    if (!cfg) return out;
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const clang::ParentMap pm(_fn.getBody());
    const auto* method                 = llvm::dyn_cast<clang::CXXMethodDecl>(&_fn);
    const clang::CXXRecordDecl* lambda = method && method->getParent()->isLambda() ? method->getParent() : nullptr;
    std::unordered_set<const clang::Stmt*> changes;  // the change statements of the effects

    // blocks and the lines of their statements
    out.entry_ = int32_t(cfg->getEntry().getBlockID());
    out.exit_  = int32_t(cfg->getExit().getBlockID());
    out.blocks_.resize(cfg->getNumBlockIDs());
    for (const clang::CFGBlock* b : *cfg) {
      LogicBlock& lb = out.blocks_[b->getBlockID()];
      for (const clang::CFGBlock::AdjacentBlock& adj : b->succs()) {
        const clang::CFGBlock* r = adj.getReachableBlock();
        lb.succs_.push_back(r ? int32_t(r->getBlockID()) : -1);
      }
      for (const clang::CFGElement& el : *b) {
        const auto s = el.getAs<clang::CFGStmt>();
        if (!s || !sm.isInMainFile(sm.getExpansionLoc(s->getStmt()->getBeginLoc()))) continue;
        lb.lines_.push_back(Detail::lines_of(s->getStmt()->getSourceRange(), sm));
      }

      // a jump such as break or continue is not an element. its line belongs to the block
      if (const clang::Stmt* t = b->getTerminatorStmt();
          t && llvm::isa<clang::BreakStmt, clang::ContinueStmt, clang::GotoStmt>(t))
        lb.lines_.push_back(Detail::lines_of(t->getSourceRange(), sm));
      Detail::merge_lines(lb.lines_);
    }

    // decisions, in the sequence of the source
    for (const clang::CFGBlock* b : *cfg) {
      const clang::Stmt* t = b->getTerminatorStmt();
      if (!t || b->succ_size() < 2 || llvm::isa<clang::BinaryOperator>(t)) continue;
      const auto& succs = out.blocks_[b->getBlockID()].succs_;
      if (std::find(succs.begin(), succs.end(), -1) != succs.end()) continue;  // a condition that is constant

      Decision d;
      d.branches_ = Detail::branches_of(t, *b, _ctx, d.kind_);
      if (d.branches_.empty() || !Detail::condition_of(t)) continue;
      d.stmt_  = t;
      d.block_ = int32_t(b->getBlockID());
      d.text_  = Detail::condition_text(t, _ctx);
      d.loc_   = Detail::condition_of(t)->getBeginLoc();
      if (const auto* r = llvm::dyn_cast<clang::CXXForRangeStmt>(t)) d.loc_ = r->getLoopVariable()->getBeginLoc();
      out.decisions_.push_back(std::move(d));
    }
    std::sort(out.decisions_.begin(), out.decisions_.end(), [&](const Decision& _a, const Decision& _b) -> bool {
      return sm.isBeforeInTranslationUnit(_a.loc_, _b.loc_);
    });
    std::unordered_map<const clang::Stmt*, int32_t> index;
    for (int32_t i = 0; i < int32_t(out.decisions_.size()); ++i) index[out.decisions_[i].stmt_] = i;

    // a conditional operator in the condition of a decision is a part of that decision, not a decision
    std::erase_if(out.decisions_, [&](const Decision& _d) -> bool {
      return _d.kind_ == DecisionKind::TERNARY && Detail::decision_of_condition(_d.stmt_, pm, index) >= 0;
    });
    index.clear();
    for (int32_t i = 0; i < int32_t(out.decisions_.size()); ++i) index[out.decisions_[i].stmt_] = i;

    // the blocks of && and || in a condition, and of a conditional operator in a condition
    for (const clang::CFGBlock* b : *cfg) {
      const clang::Stmt* t = b->getTerminatorStmt();
      if (!t || index.contains(t) || !llvm::isa<clang::BinaryOperator, clang::AbstractConditionalOperator>(t)) continue;
      if (const int32_t d = Detail::decision_of_condition(t, pm, index); d >= 0)
        out.decisions_[d].cond_blocks_.push_back(int32_t(b->getBlockID()));
    }

    // the decision that contains each decision, and the branch
    for (Decision& d : out.decisions_) {
      const clang::Stmt* child = d.stmt_;
      for (const clang::Stmt* p = pm.getParent(child); p; child = p, p = pm.getParent(p)) {
        if (llvm::isa<clang::LambdaExpr>(p)) break;
        const auto it = index.find(p);
        if (it == index.end()) continue;
        const std::string branch = Detail::branch_of_child(out.decisions_[it->second], child, d.stmt_, sm);
        if (branch.empty()) continue;
        d.parent_        = it->second;
        d.parent_branch_ = branch;
        break;
      }
    }

    // else-if chains that compare one value with constants. a chain starts at an if that is not an else
    for (const Decision& d : out.decisions_) {
      const auto* first = llvm::dyn_cast<clang::IfStmt>(d.stmt_);
      if (!first) continue;
      if (const auto* p = llvm::dyn_cast_or_null<clang::IfStmt>(pm.getParent(first)); p && p->getElse() == first)
        continue;

      Chain c;
      const clang::IfStmt* last = nullptr;
      for (const clang::IfStmt* s = first; s; s = llvm::dyn_cast_or_null<clang::IfStmt>(s->getElse())) {
        const auto cmp = s->getConditionVariable() ? std::nullopt : Detail::compare_with_constant(s->getCond(), _ctx);
        const auto it  = index.find(s);
        if (!cmp || it == index.end() || (!c.items_.empty() && cmp->first != c.subject_)) break;
        c.subject_ = cmp->first;
        c.items_.push_back({it->second, cmp->second});
        last = s;
      }
      if (c.items_.size() < 2) continue;
      c.hasElse_ = last->getElse() != nullptr;
      out.chains_.push_back(std::move(c));
    }

    // events, return statements, nullable pointers and their dereferences
    std::unordered_map<const clang::ValueDecl*, std::vector<int32_t>> nullable_of;
    for (const clang::CFGBlock* b : *cfg) {
      const int32_t block = int32_t(b->getBlockID());
      for (const clang::CFGElement& el : *b) {
        const auto cs = el.getAs<clang::CFGStmt>();
        if (!cs) continue;
        const clang::Stmt* s = cs->getStmt();

        // a call of an event function. the label is the first string argument that is not empty. the mark is the
        // literal, or the argument if the literal comes from a constant. with no string argument, the first enum
        // constant gives the label
        if (const auto* call = llvm::dyn_cast<clang::CallExpr>(s);
            call && Detail::name_in(call->getDirectCallee(), _opts.event_functions_)) {
          const std::string name = call->getDirectCallee()->getNameAsString();
          const size_t before    = out.events_.size();
          for (const clang::Expr* arg : call->arguments()) {
            bool isConstant                 = false;
            const clang::StringLiteral* lit = Detail::string_literal_of(arg, &isConstant);
            if (!lit || lit->getCharByteWidth() != 1 || lit->getLength() == 0) continue;
            const clang::SourceRange at = isConstant ? arg->getSourceRange() : lit->getSourceRange();
            out.events_.push_back({Detail::mark_of(at, block, _ctx), name, lit->getString().str()});
            break;
          }
          for (const clang::Expr* arg : call->arguments()) {
            if (out.events_.size() > before) break;
            const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(arg->IgnoreParenImpCasts());
            if (const auto* e = r ? llvm::dyn_cast<clang::EnumConstantDecl>(r->getDecl()) : nullptr)
              out.events_.push_back({Detail::mark_of(arg->getSourceRange(), block, _ctx), name, e->getNameAsString()});
          }
        }

        // a return statement or a co_return statement, with the short text of its value
        const auto add_return = [&](const clang::SourceLocation _keyword, const clang::Expr* _value) -> void {
          out.returns_.push_back({Detail::mark_of({_keyword, _keyword}, block, _ctx),
                                  _value ? Detail::short_text(_ctx, _value->getSourceRange()) : std::string()});
        };
        if (const auto* ret = llvm::dyn_cast<clang::ReturnStmt>(s)) add_return(ret->getReturnLoc(), ret->getRetValue());
        if (const auto* ret = llvm::dyn_cast<clang::CoreturnStmt>(s))
          add_return(ret->getKeywordLoc(), ret->getOperand());

        // a variable that can be null and gets the result of a nullable function: a pointer, std::unique_ptr,
        // std::shared_ptr or std::optional
        const auto add_source = [&](const clang::ValueDecl* _var, const clang::Expr* _value,
                                    const clang::SourceRange _at) -> void {
          const clang::FunctionDecl* fn = Detail::callee_of(_value);
          if (!Detail::is_nullable_type(_var->getType()) || !Detail::name_in(fn, _opts.nullable_functions_)) return;
          nullable_of[_var].push_back(int32_t(out.nullable_.size()));
          out.nullable_.push_back({_var, fn->getNameAsString(), Detail::mark_of(_at, block, _ctx), {}, {}});
        };
        if (const auto* ds = llvm::dyn_cast<clang::DeclStmt>(s)) {
          for (const clang::Decl* decl : ds->decls())
            if (const auto* v = llvm::dyn_cast<clang::VarDecl>(decl); v && v->hasInit())
              add_source(v, v->getInit(), {v->getLocation(), v->getLocation()});
        }
        if (const auto* a = llvm::dyn_cast<clang::BinaryOperator>(s); a && a->getOpcode() == clang::BO_Assign) {
          if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(a->getLHS()->IgnoreParenImpCasts()))
            add_source(ref->getDecl(), a->getRHS(), ref->getSourceRange());
        }
        if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(s);
            op && op->getOperator() == clang::OO_Equal && op->getNumArgs() == 2) {
          if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(op->getArg(0)->IgnoreParenImpCasts()))
            add_source(ref->getDecl(), op->getArg(1), ref->getSourceRange());
        }
      }
    }
    for (const clang::CFGBlock* b : *cfg) {
      const int32_t block = int32_t(b->getBlockID());
      for (const clang::CFGElement& el : *b) {
        const auto cs = el.getAs<clang::CFGStmt>();
        if (!cs) continue;
        const clang::Stmt* s = cs->getStmt();

        // a change of data that lives after the call. each change statement gives one effect
        if (llvm::isa<clang::MemberExpr, clang::DeclRefExpr, clang::ArraySubscriptExpr, clang::UnaryOperator,
                      clang::CXXOperatorCallExpr>(s)) {
          const auto change = Detail::effect_change(llvm::cast<clang::Expr>(s), pm);
          const char* kind  = change ? Detail::lasting_kind(change->target_, lambda) : nullptr;
          if (kind && changes.insert(change->change_).second)
            out.effects_.push_back({Detail::mark_of(change->target_->getSourceRange(), block, _ctx),
                                    Detail::short_text(_ctx, change->target_->getSourceRange()),
                                    Detail::action_of(change->change_), kind});
        }

        // a dereference: *p, p->x and p[i], also with the operators of a smart pointer or of std::optional
        const clang::Expr* base = nullptr;
        if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(s); u && u->getOpcode() == clang::UO_Deref)
          base = u->getSubExpr();
        else if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(s); m && m->isArrow())
          base = m->getBase();
        else if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(s))
          base = a->getBase();
        else if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(s);
                 op && Detail::is_access_operator(op->getOperator()) && op->getNumArgs() > 0)
          base = op->getArg(0);
        const auto* ref = base ? llvm::dyn_cast<clang::DeclRefExpr>(base->IgnoreParenImpCasts()) : nullptr;
        const auto it   = ref ? nullable_of.find(ref->getDecl()) : nullable_of.end();
        if (it == nullable_of.end()) continue;
        for (const int32_t n : it->second)
          out.nullable_[n].derefs_.push_back(Detail::mark_of(s->getSourceRange(), block, _ctx));
      }

      // a null check as the condition of the block: "p", "!p", "p != nullptr" or "p == nullptr", the same forms for a
      // smart pointer and for std::optional with std::nullopt, "o.has_value()", and a call of a check function with p
      if (b->succ_size() != 2) continue;
      const clang::Expr* cond = llvm::isa_and_nonnull<clang::BinaryOperator>(b->getTerminatorStmt())
                                    ? llvm::dyn_cast_or_null<clang::Expr>(b->getTerminatorCondition())
                                    : b->getLastCondition();
      if (!cond) continue;
      int32_t not_null     = 0;  // the successor where the pointer is not null
      const clang::Expr* e = cond->IgnoreParenImpCasts();
      while (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(e)) {
        if (u->getOpcode() != clang::UO_LNot) break;
        not_null = 1 - not_null;
        e        = u->getSubExpr()->IgnoreParenImpCasts();
      }
      const clang::Expr* lhs = nullptr;
      const clang::Expr* rhs = nullptr;
      bool isEqual           = false;
      if (const auto* bo = llvm::dyn_cast<clang::BinaryOperator>(e);
          bo && (bo->getOpcode() == clang::BO_EQ || bo->getOpcode() == clang::BO_NE)) {
        lhs     = bo->getLHS();
        rhs     = bo->getRHS();
        isEqual = bo->getOpcode() == clang::BO_EQ;
      } else if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(e);
                 op && op->getNumArgs() == 2 &&
                 (op->getOperator() == clang::OO_EqualEqual || op->getOperator() == clang::OO_ExclaimEqual)) {
        lhs     = op->getArg(0);
        rhs     = op->getArg(1);
        isEqual = op->getOperator() == clang::OO_EqualEqual;
      } else if (const auto* rw = llvm::dyn_cast<clang::CXXRewrittenBinaryOperator>(e)) {
        const auto form = rw->getDecomposedForm();
        if (form.Opcode == clang::BO_EQ || form.Opcode == clang::BO_NE) {
          lhs     = form.LHS;
          rhs     = form.RHS;
          isEqual = form.Opcode == clang::BO_EQ;
        }
      }
      if (lhs && rhs) {
        const bool isLeftNull = Detail::is_null_value(lhs, _ctx), isRightNull = Detail::is_null_value(rhs, _ctx);
        if (!isLeftNull && !isRightNull) continue;
        e = (isRightNull ? lhs : rhs)->IgnoreParenImpCasts();
        if (isEqual) not_null = 1 - not_null;
      }
      if (const auto* mc = llvm::dyn_cast<clang::CXXMemberCallExpr>(e)) {
        const clang::CXXMethodDecl* md = mc->getMethodDecl();
        if (md && (llvm::isa<clang::CXXConversionDecl>(md) || (md->getIdentifier() && md->getName() == "has_value")))
          e = mc->getImplicitObjectArgument()->IgnoreParenImpCasts();
      }
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(e);
          call && Detail::name_in(call->getDirectCallee(), _opts.check_functions_)) {
        for (const clang::Expr* arg : call->arguments())
          if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(arg->IgnoreParenImpCasts());
              r && nullable_of.contains(r->getDecl())) {
            e = r;
            break;
          }
      }
      const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(e);
      const auto it   = ref ? nullable_of.find(ref->getDecl()) : nullable_of.end();
      if (it == nullable_of.end()) continue;
      for (const int32_t n : it->second) out.nullable_[n].checks_.push_back({block, not_null});
    }

    // the events, the nullable variables and the effects in the sequence of the source. the cfg gives its blocks in a
    // different sequence
    const auto is_before = [&](const auto& _a, const auto& _b) {
      return sm.isBeforeInTranslationUnit(_a.at_.loc_, _b.at_.loc_);
    };
    std::ranges::stable_sort(out.events_, is_before);
    std::ranges::stable_sort(out.effects_, is_before);
    std::ranges::stable_sort(out.nullable_, [&](const NullableVar& _a, const NullableVar& _b) {
      return sm.isBeforeInTranslationUnit(_a.source_at_.loc_, _b.source_at_.loc_);
    });
    for (NullableVar& n : out.nullable_)
      std::ranges::stable_sort(
          n.derefs_, [&](const Mark& _a, const Mark& _b) { return sm.isBeforeInTranslationUnit(_a.loc_, _b.loc_); });
    return out;
  }  // build_logic

  //----------------------------------
  // Json

  namespace Detail {
    [[nodiscard]] inline const char* kind_name(const DecisionKind _kind) {
      switch (_kind) {
        case DecisionKind::IF:
          return "if";
        case DecisionKind::LOOP:
          return "loop";
        case DecisionKind::DO:
          return "do";
        case DecisionKind::SWITCH:
          return "switch";
        case DecisionKind::TERNARY:
          return "ternary";
      }
      return "if";
    }  // kind_name
  }  // namespace Detail

  // lines start at 1. columns are utf-8 bytes and start at 1
  [[nodiscard]] inline JsonObject logic_to_json(const LogicModel& _model, const clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const auto add_pos             = [&](JsonObject& _o, const clang::SourceLocation _loc) -> void {
      const clang::SourceLocation at = sm.getFileLoc(_loc);
      _o["line"]                     = int64_t(sm.getExpansionLineNumber(at));
      _o["col"]                      = int64_t(sm.getExpansionColumnNumber(at));
    };
    const auto mark = [&](const Mark& _m) -> JsonObject {
      JsonObject o{{"block", int64_t(_m.block_)}, {"len", int64_t(_m.len_)}};
      add_pos(o, _m.loc_);
      return o;
    };

    JsonArray blocks;
    for (const LogicBlock& b : _model.blocks_) {
      JsonArray succs, lines;
      for (const int32_t s : b.succs_) succs.push_back(int64_t(s));
      for (const LineRange& r : b.lines_) lines.push_back(JsonArray{int64_t(r.first_), int64_t(r.last_)});
      blocks.push_back(JsonObject{{"succs", std::move(succs)}, {"lines", std::move(lines)}});
    }

    JsonArray decisions;
    for (const Decision& d : _model.decisions_) {
      JsonArray branches, cond_blocks;
      for (const Branch& br : d.branches_) {
        JsonObject o{{"label", br.label_}, {"succ", int64_t(br.succ_)}};
        if (br.lines_) {
          o["first"] = int64_t(br.lines_->first_);
          o["last"]  = int64_t(br.lines_->last_);
        }
        branches.push_back(std::move(o));
      }
      for (const int32_t b : d.cond_blocks_) cond_blocks.push_back(int64_t(b));
      JsonObject o{{"kind", Detail::kind_name(d.kind_)},   {"block", int64_t(d.block_)},
                   {"condBlocks", std::move(cond_blocks)}, {"text", d.text_},
                   {"branches", std::move(branches)},      {"parent", int64_t(d.parent_)}};
      if (d.parent_ >= 0) o["parentBranch"] = d.parent_branch_;
      add_pos(o, d.loc_);
      decisions.push_back(std::move(o));
    }

    JsonArray chains;
    for (const Chain& c : _model.chains_) {
      JsonArray items;
      for (const ChainItem& i : c.items_)
        items.push_back(JsonObject{{"decision", int64_t(i.decision_)}, {"value", i.value_}});
      chains.push_back(JsonObject{{"subject", c.subject_}, {"items", std::move(items)}, {"hasElse", c.hasElse_}});
    }

    JsonArray events;
    for (const EventCall& e : _model.events_) {
      JsonObject o  = mark(e.at_);
      o["function"] = e.function_;
      o["label"]    = e.label_;
      events.push_back(std::move(o));
    }

    JsonArray nullable;
    for (const NullableVar& n : _model.nullable_) {
      JsonArray derefs, checks;
      for (const Mark& m : n.derefs_) derefs.push_back(mark(m));
      for (const NullCheck& c : n.checks_)
        checks.push_back(JsonObject{{"block", int64_t(c.block_)}, {"succ", int64_t(c.succ_)}});
      nullable.push_back(JsonObject{{"var", n.decl_->getNameAsString()},
                                    {"source", n.source_},
                                    {"at", mark(n.source_at_)},
                                    {"derefs", std::move(derefs)},
                                    {"checks", std::move(checks)}});
    }

    JsonArray returns;
    for (const ReturnPoint& r : _model.returns_) {
      JsonObject o = mark(r.at_);
      o["value"]   = r.value_;
      returns.push_back(std::move(o));
    }

    JsonArray effects;
    for (const Effect& e : _model.effects_) {
      JsonObject o = mark(e.at_);
      o["target"]  = e.target_;
      o["action"]  = e.action_;
      o["kind"]    = e.kind_;
      effects.push_back(std::move(o));
    }

    return JsonObject{
        {"entry", int64_t(_model.entry_)},   {"exit", int64_t(_model.exit_)}, {"blocks", std::move(blocks)},
        {"decisions", std::move(decisions)}, {"chains", std::move(chains)},   {"events", std::move(events)},
        {"nullable", std::move(nullable)},   {"returns", std::move(returns)}, {"effects", std::move(effects)}};
  }  // logic_to_json

}  // namespace DataFlow
