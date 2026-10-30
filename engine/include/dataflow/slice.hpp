#pragma once

#include <dataflow/flow.hpp>
#include <dataflow/logic.hpp>

/*
  The forward slice of a change, for Change Ripple
    > a body is a function or the call operator of a lambda. each body has its own cfg
    > a unit is one statement of a body: an expression statement, a declaration, a return or a condition
    > a value is a variable or this, with a path of up to 3 fields, for example home_battery_ctl.charging_future
    > data dependence: a unit that reads a value depends on the writes of the value that reach it
    > control dependence: a unit depends on the decisions that decide if it runs
  The slice starts at the units on the changed lines, or at a call. At the return of a lambda, it continues at the
  lambda in the enclosing body. A write to a field of a persistent object, for example of this or of a reference
  parameter, also reaches the reads of the field in a later call. These steps are estimated.
  The exits are the points where the effect leaves the body: the return value, writes to persistent objects, call
  arguments, captures and async calls.
*/

namespace DataFlow {

  // how a unit joins the slice
  enum class StepKind { SEED, DATA, CONTROL, MEMBER, ASYNC, LAMBDA };

  // exact: a dependence in the body. call: through the call hierarchy. estimated: through state or an async call
  enum class Confidence { EXACT, CALL, ESTIMATED };

  enum class ExitKind { RETURN, MEMBER, GLOBAL, REFERENCE, ARGUMENT, CAPTURE, ASYNC, CALL };

  struct SliceStep {
    const clang::Stmt* unit_ = nullptr;
    StepKind kind_           = StepKind::SEED;
    Confidence confidence_   = Confidence::EXACT;
    int32_t distance_        = 0;
    int32_t from_            = -1;  // the step of the same body that this step depends on, or -1
    std::string via_;               // the value, the condition or the function of the dependence
  };  // SliceStep

  struct SliceExit {
    ExitKind kind_         = ExitKind::RETURN;
    const clang::Stmt* at_ = nullptr;
    int32_t step_          = -1;
    std::string text_;
    bool isFollowed_ = false;
  };  // SliceExit

  struct BodySlice {
    const clang::FunctionDecl* fn_   = nullptr;  // the function, or the call operator of the lambda
    const clang::LambdaExpr* lambda_ = nullptr;
    std::vector<uint32_t> seed_lines_;
    std::vector<SliceStep> steps_;
    std::vector<SliceExit> exits_;
  };  // BodySlice

  struct SliceOptions {
    std::vector<std::string> async_functions_;
    Confidence confidence_    = Confidence::EXACT;  // the confidence of the seeds
    int32_t max_member_steps_ = 1;                  // jumps to the reads of a field in a later call, on one chain
  };  // SliceOptions

  // the start of a slice: the changed lines of the file, or the call with the called name at a position
  struct SliceSeed {
    std::vector<uint32_t> lines_;
    std::vector<std::pair<uint32_t, std::string>> deleted_;  // the line after each deleted block, and the old text
    std::optional<std::pair<uint32_t, uint32_t>> call_;      // line and column, from 1
  };  // SliceSeed

  struct SliceModel {
    std::vector<BodySlice> bodies_;
    std::vector<uint32_t> outside_;  // changed lines outside of all functions
    std::vector<uint32_t> quiet_;    // changed lines in a function with no statement, for example a comment
    bool isCallFound_ = true;
  };  // SliceModel

  namespace Detail {
    // a value: a variable, or this if root_ is null, with a path of fields
    struct ValueKey {
      const clang::ValueDecl* root_ = nullptr;
      std::vector<const clang::FieldDecl*> fields_;

      bool operator==(const ValueKey&) const = default;
    };  // ValueKey

    struct ValueKeyHash {
      [[nodiscard]] size_t operator()(const ValueKey& _k) const noexcept {
        size_t out = std::hash<const void*>()(_k.root_);
        for (const clang::FieldDecl* f : _k.fields_) out = out * 31 + std::hash<const void*>()(f);
        return out;
      }
    };  // ValueKeyHash

    // true if _a has the root of _b, and the path of _a is a prefix of the path of _b
    [[nodiscard]] inline bool is_prefix(const ValueKey& _a, const ValueKey& _b) {
      return _a.root_ == _b.root_ && _a.fields_.size() <= _b.fields_.size() &&
             std::equal(_a.fields_.begin(), _a.fields_.end(), _b.fields_.begin());
    }  // is_prefix

    [[nodiscard]] inline std::string value_text(const ValueKey& _k) {
      std::string out = _k.root_ ? _k.root_->getNameAsString() : std::string();
      for (const clang::FieldDecl* f : _k.fields_) {
        if (!out.empty()) out += '.';
        out += f->getNameAsString();
      }
      return out.empty() ? "this" : out;
    }  // value_text

    // where the root of a value lives. all storages except LOCAL and PARAM_VALUE outlive a call of the body
    enum class Storage { LOCAL, PARAM_VALUE, PARAM_REF, PARAM_PTR, ALIAS, THIS, GLOBAL, OUTER };

    [[nodiscard]] inline bool is_persistent(const Storage _s) {
      return _s != Storage::LOCAL && _s != Storage::PARAM_VALUE;
    }

    struct SliceValue {
      ValueKey key_;
      Storage storage_ = Storage::LOCAL;
      std::string text_;
    };  // SliceValue

    // one read or write of a value
    struct Access {
      const clang::Expr* expr_ = nullptr;  // null for a declaration
      const clang::Stmt* at_   = nullptr;  // the element of the cfg where the access takes effect
      int32_t unit_            = -1;
      int32_t value_           = -1;
      bool isUse_ = false, isDef_ = false, isKill_ = false;
      bool isByRef_ = false;  // a use that binds the value to a reference, and does not copy it
    };  // Access

    // the slice data of one body
    struct BodyModel {
      const clang::FunctionDecl* fn_   = nullptr;  // the function, or the call operator of the lambda
      const clang::LambdaExpr* lambda_ = nullptr;
      std::unique_ptr<clang::CFG> cfg_;
      std::unique_ptr<clang::ParentMap> pm_;

      std::vector<const clang::Stmt*> units_;
      std::unordered_map<const clang::Stmt*, int32_t> unit_of_;  // each element of the cfg, and each unit
      std::vector<std::vector<uint32_t>> unit_lines_;            // the lines of each unit, empty until a request
      std::vector<std::vector<int32_t>> block_units_;            // block id -> the units with an element in it
      std::vector<std::vector<int32_t>> unit_decisions_;         // unit -> the blocks with a condition in the unit
      std::vector<std::vector<int32_t>> dependents_;             // block id -> the blocks that depend on it

      std::vector<SliceValue> values_;
      std::vector<Access> accesses_;
      std::vector<std::vector<int32_t>> unit_accesses_;  // unit -> its accesses
      std::vector<std::vector<int32_t>> reached_;        // access of a definition -> the uses that it reaches
    };  // BodyModel

    //----------------------------------
    // Visitors

    // collects the lambdas in a statement. deep also collects the lambdas in the bodies of lambdas
    class LambdaCollector : public clang::RecursiveASTVisitor<LambdaCollector> {
      std::vector<const clang::LambdaExpr*>& out_;
      bool isDeep_ = false;

     public:
      LambdaCollector(std::vector<const clang::LambdaExpr*>& _out, const bool _deep) : out_(_out), isDeep_(_deep) {}

      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        out_.push_back(_e);
        return !isDeep_ || clang::RecursiveASTVisitor<LambdaCollector>::TraverseLambdaExpr(_e);
      }
    };  // LambdaCollector

    // collects the roots of the accesses in a body: the references to variables, and this.
    // the body of a nested lambda is not a part of the body, but its captures are
    class RootCollector : public clang::RecursiveASTVisitor<RootCollector> {
      std::vector<const clang::Expr*>& out_;
      std::unordered_set<const clang::Expr*> seen_;

     public:
      explicit RootCollector(std::vector<const clang::Expr*>& _out) : out_(_out) {}

      // the implicit statements of a range-based for loop are a part of the cfg
      bool shouldVisitImplicitCode() const { return true; }

      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        for (clang::Expr* init : _e->capture_inits())
          if (init) TraverseStmt(init);
        return true;
      }

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        if (llvm::isa<clang::VarDecl, clang::BindingDecl>(_e->getDecl()) && seen_.insert(_e).second) out_.push_back(_e);
        return true;
      }

      bool VisitCXXThisExpr(clang::CXXThisExpr* _e) {
        if (seen_.insert(_e).second) out_.push_back(_e);
        return true;
      }
    };  // RootCollector

    class CallCollector : public clang::RecursiveASTVisitor<CallCollector> {
      std::vector<const clang::CallExpr*>& out_;

     public:
      explicit CallCollector(std::vector<const clang::CallExpr*>& _out) : out_(_out) {}

      bool VisitCallExpr(clang::CallExpr* _e) {
        out_.push_back(_e);
        return true;
      }
    };  // CallCollector

    //----------------------------------
    // Body model

    // the unit of a statement of the cfg: the expression statement, declaration, return or condition around it
    [[nodiscard]] inline const clang::Stmt* unit_root(const clang::Stmt* _s, const clang::ParentMap& _pm) {
      const clang::Stmt* cur = _s;
      for (const clang::Stmt* p = _pm.getParent(cur); p; cur = p, p = _pm.getParent(p)) {
        if (llvm::isa<clang::ReturnStmt, clang::DeclStmt>(p)) return p;
        if (!llvm::isa<clang::Expr>(p)) return cur;
      }
      return cur;
    }  // unit_root

    // the lines of a statement, without the lines in the bodies of its lambdas
    [[nodiscard]] inline std::vector<uint32_t> stmt_lines(const clang::Stmt* _s, const clang::SourceManager& _sm) {
      std::vector<uint32_t> out;
      const LineRange r = lines_of(_s->getSourceRange(), _sm);
      if (r.first_ == 0) return out;

      std::vector<const clang::LambdaExpr*> lambdas;
      LambdaCollector(lambdas, false).TraverseStmt(const_cast<clang::Stmt*>(_s));
      for (uint32_t line = r.first_; line <= r.last_; ++line) {
        const bool isInside = std::any_of(lambdas.begin(), lambdas.end(), [&](const clang::LambdaExpr* _l) {
          const LineRange body = lines_of(_l->getBody()->getSourceRange(), _sm);
          return line > body.first_ && line < body.last_;
        });
        if (!isInside) out.push_back(line);
      }
      return out;
    }  // stmt_lines

    [[nodiscard]] inline const std::vector<uint32_t>& unit_lines(BodyModel& _b, const int32_t _unit,
                                                                 const clang::SourceManager& _sm) {
      std::vector<uint32_t>& out = _b.unit_lines_[_unit];
      if (out.empty()) out = stmt_lines(_b.units_[_unit], _sm);
      return out;
    }  // unit_lines

    // the units of the elements of the cfg, the units of each block, and the decisions of each unit
    inline void add_units(BodyModel& _b) {
      // the cfg splits a declaration of more than one variable. the parts belong to the declaration of the source
      std::unordered_map<const clang::Stmt*, const clang::Stmt*> source_of;
      for (const auto& [synthetic, source] : _b.cfg_->synthetic_stmts()) source_of[synthetic] = source;

      const auto unit_index = [&](const clang::Stmt* _s) -> int32_t {
        const auto src          = source_of.find(_s);
        const clang::Stmt* root = unit_root(src == source_of.end() ? _s : src->second, *_b.pm_);
        const auto [it, isNew]  = _b.unit_of_.try_emplace(root, int32_t(_b.units_.size()));
        const int32_t u         = it->second;
        if (isNew) {
          _b.units_.push_back(root);
          _b.unit_decisions_.emplace_back();
        }
        _b.unit_of_[_s] = u;
        return u;
      };

      _b.block_units_.assign(_b.cfg_->getNumBlockIDs(), {});
      for (const clang::CFGBlock* block : *_b.cfg_) {
        std::vector<int32_t>& units = _b.block_units_[block->getBlockID()];
        for (const clang::CFGElement& el : *block) {
          const auto s = el.getAs<clang::CFGStmt>();
          if (!s) continue;
          const int32_t u = unit_index(s->getStmt());
          if (std::find(units.begin(), units.end(), u) == units.end()) units.push_back(u);
        }
        const clang::Stmt* cond = block->getTerminatorCondition();
        if (cond && block->succ_size() >= 2)
          _b.unit_decisions_[unit_index(cond)].push_back(int32_t(block->getBlockID()));
      }
      _b.unit_lines_.assign(_b.units_.size(), {});
    }  // add_units

    // the root variable of an expression, through fields, subscripts, dereferences and calls on an object.
    // null for this. nullopt if the expression has no root
    [[nodiscard]] inline std::optional<const clang::ValueDecl*> root_of(const clang::Expr* _e) {
      for (int32_t i = 0; _e && i < 16; ++i) {
        _e = _e->IgnoreParenImpCasts();
        if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_e)) return r->getDecl();
        if (llvm::isa<clang::CXXThisExpr>(_e)) return nullptr;
        if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(_e))
          _e = m->getBase();
        else if (const auto* s = llvm::dyn_cast<clang::ArraySubscriptExpr>(_e))
          _e = s->getBase();
        else if (const auto* u = llvm::dyn_cast<clang::UnaryOperator>(_e); u && u->getOpcode() == clang::UO_Deref)
          _e = u->getSubExpr();
        else if (const auto* o = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_e); o && o->getNumArgs() > 0)
          _e = o->getArg(0);
        else if (const auto* c = llvm::dyn_cast<clang::CXXMemberCallExpr>(_e))
          _e = c->getImplicitObjectArgument();
        else
          return std::nullopt;
      }
      return std::nullopt;
    }  // root_of

    // the storage of a root. a local non-const reference to a persistent object is an alias of the object
    [[nodiscard]] inline Storage root_storage(const clang::ValueDecl* _root, const clang::FunctionDecl& _fn,
                                              std::unordered_map<const clang::ValueDecl*, Storage>& _memo) {
      if (!_root) return Storage::THIS;
      if (const auto it = _memo.find(_root); it != _memo.end()) return it->second;
      _memo[_root]  = Storage::LOCAL;  // stops a cycle

      Storage out   = Storage::LOCAL;
      const auto* v = llvm::dyn_cast<clang::VarDecl>(_root);
      if (v && v->hasGlobalStorage()) {
        out = Storage::GLOBAL;
      } else if (_root->getDeclContext() != static_cast<const clang::DeclContext*>(&_fn)) {
        out = Storage::OUTER;  // in a lambda: a variable of the enclosing function
      } else if (const auto* p = llvm::dyn_cast<clang::ParmVarDecl>(_root)) {
        const clang::QualType t = p->getType();
        if (t->isReferenceType() && !t.getNonReferenceType().isConstQualified())
          out = Storage::PARAM_REF;
        else if (t->isPointerType() && !t->getPointeeType().isConstQualified())
          out = Storage::PARAM_PTR;
        else
          out = Storage::PARAM_VALUE;
      } else if (v && v->getType()->isReferenceType() && !v->getType().getNonReferenceType().isConstQualified() &&
                 v->getInit()) {
        const auto root = root_of(v->getInit());
        if (root && is_persistent(root_storage(*root, _fn, _memo))) out = Storage::ALIAS;
      }
      _memo[_root] = out;
      return out;
    }  // root_storage

    // the access of a root: the longest path of fields above it, for example x.a.b for x. a maximum of 3 fields
    [[nodiscard]] inline std::pair<const clang::Expr*, ValueKey> access_of(const clang::Expr* _root,
                                                                           const clang::ParentMap& _pm) {
      ValueKey key;
      if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(_root)) key.root_ = r->getDecl();
      const clang::Expr* access = _root;
      while (key.fields_.size() < 3) {
        const auto* m = llvm::dyn_cast_or_null<clang::MemberExpr>(
            _pm.getParentIgnoreParenImpCasts(const_cast<clang::Expr*>(access)));
        const auto* f = m ? llvm::dyn_cast<clang::FieldDecl>(m->getMemberDecl()) : nullptr;
        if (!f || m->getBase()->IgnoreParenImpCasts() != access) break;
        key.fields_.push_back(f);
        access = m;
      }
      return {access, key};
    }  // access_of

    // true if a use binds the value to a reference, so the code does not copy the value: a reference argument,
    // the object of a member call, or the initializer of a reference variable
    [[nodiscard]] inline bool is_reference_use(const clang::Expr* _e, const clang::ParentMap& _pm) {
      const clang::Stmt* child = _e;
      const clang::Stmt* p     = _pm.getParent(child);
      for (; p; child = p, p = _pm.getParent(p)) {
        const auto* cast = llvm::dyn_cast<clang::ImplicitCastExpr>(p);
        if (!llvm::isa<clang::ParenExpr>(p) && !(cast && cast->getCastKind() != clang::CK_LValueToRValue)) break;
      }
      if (!p) return false;
      if (llvm::isa<clang::MemberExpr>(p)) return true;  // the object of a member call

      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(p)) {
        const clang::FunctionDecl* fn = call->getDirectCallee();
        const auto* method            = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(fn);
        const bool isMemberOperator   = llvm::isa<clang::CXXOperatorCallExpr>(call) && method && !method->isStatic();
        for (uint32_t i = 0; i < call->getNumArgs(); ++i) {
          if (call->getArg(i) != child) continue;
          if (isMemberOperator && i == 0) return true;  // the object of a member operator
          const uint32_t param = isMemberOperator ? i - 1 : i;
          return fn && param < fn->getNumParams() && fn->getParamDecl(param)->getType()->isReferenceType();
        }
        return false;
      }
      if (const auto* decl = llvm::dyn_cast<clang::DeclStmt>(p))
        for (const clang::Decl* d : decl->decls())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getInit() == child)
            return v->getType()->isReferenceType();
      return false;
    }  // is_reference_use

    // the reads and writes of the values in a body. the mutation analyzer of clang finds the writes
    inline void add_accesses(BodyModel& _b, const clang::Stmt& _body, clang::ASTContext& _ctx) {
      std::unordered_set<const clang::Stmt*> elements;
      for (const clang::CFGBlock* block : *_b.cfg_)
        for (const clang::CFGElement& el : *block)
          if (const auto s = el.getAs<clang::CFGStmt>()) elements.insert(s->getStmt());

      std::unordered_map<ValueKey, int32_t, ValueKeyHash> index;
      std::unordered_map<const clang::ValueDecl*, Storage> storages;
      const auto value_of = [&](const ValueKey& _key) -> int32_t {
        const auto [it, isNew] = index.try_emplace(_key, int32_t(_b.values_.size()));
        if (isNew)
          _b.values_.push_back(SliceValue{_key, root_storage(_key.root_, *_b.fn_, storages), value_text(_key)});
        return it->second;
      };
      _b.unit_accesses_.assign(_b.units_.size(), {});
      const auto add = [&](const Access& _a) -> void {
        _b.unit_accesses_[_a.unit_].push_back(int32_t(_b.accesses_.size()));
        _b.accesses_.push_back(_a);
      };

      // a declaration defines its variables
      for (const clang::CFGBlock* block : *_b.cfg_)
        for (const clang::CFGElement& el : *block) {
          const auto s     = el.getAs<clang::CFGStmt>();
          const auto* decl = s ? llvm::dyn_cast<clang::DeclStmt>(s->getStmt()) : nullptr;
          if (!decl) continue;
          for_each_declared(*decl, [&](const clang::ValueDecl* _d) {
            add(Access{.at_     = decl,
                       .unit_   = _b.unit_of_.at(decl),
                       .value_  = value_of(ValueKey{_d, {}}),
                       .isDef_  = true,
                       .isKill_ = true});
          });
        }

      // the uses and the writes of the references
      std::vector<const clang::Expr*> roots;
      RootCollector collector(roots);
      collector.TraverseStmt(const_cast<clang::Stmt*>(&_body));
      clang::ExprMutationAnalyzer mutation(_body, _ctx);
      for (const clang::Expr* root : roots) {
        const auto [expr, key] = access_of(root, *_b.pm_);
        if (!elements.contains(expr)) continue;  // not evaluated, for example in decltype

        // most accesses need no query of the mutation analyzer, which searches the full body for each query
        Access a{.expr_ = expr, .at_ = expr, .unit_ = _b.unit_of_.at(expr), .value_ = value_of(key)};
        const clang::Stmt* m = change_of(mutation, expr, *_b.pm_);

        // a change in another unit comes through a reference to the value, and the slice follows that reference.
        // a lambda that captures the value by reference does not change it
        const auto in_unit   = m ? _b.unit_of_.find(m) : _b.unit_of_.end();
        if (in_unit == _b.unit_of_.end() || in_unit->second != a.unit_ || llvm::isa<clang::LambdaExpr>(m)) m = nullptr;
        const auto also_reads = m ? assign_kind(m, expr) : std::nullopt;
        const bool isImplicit = key.root_ && key.root_->isImplicit();

        // a write to the whole value. x += 1 also reads x
        if (also_reads) {
          a.at_    = m;
          a.isUse_ = *also_reads;
          a.isDef_ = a.isKill_ = true;
        }

        // a possible write: a call, a write below the path, or a non-const reference. the implicit variables of a
        // range-based for loop only read the range
        else if (m && !isImplicit && !is_read_through_accessor(m, expr, mutation) && !is_returned(expr, *_b.pm_)) {
          a.at_    = m;
          a.isUse_ = a.isDef_ = true;
        }

        // a read
        else {
          a.isUse_ = true;
        }
        a.isByRef_ = a.isUse_ && is_reference_use(expr, *_b.pm_);
        add(a);
      }
    }  // add_accesses

    // reaching definitions over the cfg. a definition reaches the uses of each value that shares its memory
    inline void add_reaching(BodyModel& _b) {
      const int32_t nv = int32_t(_b.values_.size());

      // the values that share memory: the same root, and one path is a prefix of the other
      std::vector<std::vector<int32_t>> overlap(nv);
      std::unordered_map<const clang::ValueDecl*, std::vector<int32_t>> by_root;
      for (int32_t v = 0; v < nv; ++v) by_root[_b.values_[v].key_.root_].push_back(v);
      for (const auto& [root, vs] : by_root)
        for (const int32_t v : vs)
          for (const int32_t w : vs)
            if (is_prefix(_b.values_[v].key_, _b.values_[w].key_) || is_prefix(_b.values_[w].key_, _b.values_[v].key_))
              overlap[v].push_back(w);

      // the definitions, and the accesses at each element of the cfg
      std::vector<int32_t> defs;  // definition -> access
      std::vector<int32_t> def_of(_b.accesses_.size(), -1);
      std::vector<std::vector<int32_t>> value_defs(nv);
      std::unordered_map<const clang::Stmt*, std::vector<int32_t>> events;
      for (int32_t i = 0; i < int32_t(_b.accesses_.size()); ++i) {
        const Access& a = _b.accesses_[i];
        events[a.at_].push_back(i);
        if (!a.isDef_) continue;
        def_of[i] = int32_t(defs.size());
        value_defs[a.value_].push_back(int32_t(defs.size()));
        defs.push_back(i);
      }
      _b.reached_.assign(_b.accesses_.size(), {});

      const size_t n      = defs.size();
      const auto transfer = [&](const clang::CFGBlock& _block, llvm::BitVector _set,
                                const bool _record) -> llvm::BitVector {
        for (const clang::CFGElement& el : _block) {
          const auto s  = el.getAs<clang::CFGStmt>();
          const auto it = s ? events.find(s->getStmt()) : events.end();
          if (it == events.end()) continue;

          // the uses of an element come before its definitions, as in x += 1
          if (_record)
            for (const int32_t i : it->second) {
              const Access& use = _b.accesses_[i];
              if (!use.isUse_) continue;
              const size_t depth = _b.values_[use.value_].key_.fields_.size();
              for (const int32_t w : overlap[use.value_]) {
                // a write of a field reaches a use of the whole object only if the use copies the object
                if (use.isByRef_ && depth < _b.values_[w].key_.fields_.size()) continue;
                for (const int32_t d : value_defs[w])
                  if (_set.test(d) && defs[d] != i) _b.reached_[defs[d]].push_back(i);
              }
            }
          for (const int32_t i : it->second) {
            const Access& a = _b.accesses_[i];
            if (!a.isDef_) continue;
            if (a.isKill_)
              for (const int32_t d : value_defs[a.value_]) _set.reset(d);
            _set.set(def_of[i]);
          }
        }
        return _set;
      };

      // iterate until no set changes. then record the uses with the final sets
      std::vector<llvm::BitVector> in(_b.cfg_->getNumBlockIDs(), llvm::BitVector(n));
      std::vector<llvm::BitVector> out(_b.cfg_->getNumBlockIDs(), llvm::BitVector(n));
      for (bool changed = true; changed;) {
        changed = false;
        for (const clang::CFGBlock* b : *_b.cfg_) {
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
      for (const clang::CFGBlock* b : *_b.cfg_) transfer(*b, in[b->getBlockID()], true);
    }  // add_reaching

    // control dependence: for each decision block, the blocks that run only for some of its branches
    inline void add_control(BodyModel& _b) {
      clang::CFG& cfg  = *_b.cfg_;
      const uint32_t n = cfg.getNumBlockIDs();

      // only the blocks that can reach the exit are in the post-dominator tree
      std::vector<bool> reaches_exit(n, false);
      std::vector<const clang::CFGBlock*> stack{&cfg.getExit()};
      reaches_exit[cfg.getExit().getBlockID()] = true;
      while (!stack.empty()) {
        const clang::CFGBlock* b = stack.back();
        stack.pop_back();
        for (const clang::CFGBlock::AdjacentBlock& pred : b->preds()) {
          const clang::CFGBlock* p = pred.getReachableBlock();
          if (!p || reaches_exit[p->getBlockID()]) continue;
          reaches_exit[p->getBlockID()] = true;
          stack.push_back(p);
        }
      }

      clang::ControlDependencyCalculator cdc(&cfg);
      _b.dependents_.assign(n, {});
      for (clang::CFGBlock* b : cfg) {
        if (!reaches_exit[b->getBlockID()]) continue;
        for (const clang::CFGBlock* d : cdc.getControlDependencies(b))
          _b.dependents_[d->getBlockID()].push_back(int32_t(b->getBlockID()));
      }
    }  // add_control

    // builds the cfg, the units, the accesses and the dependences of a body. false if clang cannot build the cfg
    [[nodiscard]] inline bool build_body(BodyModel& _b, clang::ASTContext& _ctx) {
      clang::Stmt* body = _b.lambda_ ? _b.lambda_->getBody() : _b.fn_->getBody();
      if (!body) return false;
      clang::CFG::BuildOptions opts;
      opts.setAllAlwaysAdd();  // each expression is an element, in the sequence of the evaluation
      _b.cfg_ = build_cfg(_b.fn_, body, _ctx, opts);
      if (!_b.cfg_) return false;
      _b.pm_ = std::make_unique<clang::ParentMap>(body);

      add_units(_b);
      add_accesses(_b, *body, _ctx);
      add_reaching(_b);
      add_control(_b);
      return true;
    }  // build_body

    //----------------------------------
    // Slicer

    // a body of the main file, with the lines and the file offsets of its range. a lambda has the range of its body
    struct BodyRef {
      const clang::FunctionDecl* fn_   = nullptr;  // the function, or the call operator of the lambda
      const clang::LambdaExpr* lambda_ = nullptr;
      LineRange lines_;
      uint32_t begin_ = 0, end_ = 0;
    };  // BodyRef

    // the functions of the main file and the lambdas in them
    [[nodiscard]] inline std::vector<BodyRef> main_file_bodies(const std::vector<const clang::FunctionDecl*>& _fns,
                                                               const clang::SourceManager& _sm) {
      std::vector<BodyRef> out;
      const auto add = [&](const clang::FunctionDecl* _fn, const clang::LambdaExpr* _lambda,
                           const clang::SourceRange _r) {
        const clang::CharSourceRange r = _sm.getExpansionRange(_r);
        out.push_back(
            BodyRef{_fn, _lambda, lines_of(_r, _sm), _sm.getFileOffset(r.getBegin()), _sm.getFileOffset(r.getEnd())});
      };
      for (const clang::FunctionDecl* f : _fns) {
        if (!f->getBody()) continue;
        add(f, nullptr, f->getSourceRange());
        std::vector<const clang::LambdaExpr*> lambdas;
        LambdaCollector(lambdas, true).TraverseStmt(f->getBody());
        for (const clang::LambdaExpr* l : lambdas) add(l->getCallOperator(), l, l->getBody()->getSourceRange());
      }
      return out;
    }  // main_file_bodies
  }  // namespace Detail

  // the body models of a parse. all slices of the parse use them, for example the slices of the changes of a review. a
  // slice builds only the models that it needs
  struct SliceCache {
    bool isReady_ = false;  // refs_ has the bodies of the main file
    std::vector<Detail::BodyRef> refs_;
    std::unordered_map<const clang::FunctionDecl*, std::unique_ptr<Detail::BodyModel>> models_;
  };  // SliceCache

  namespace Detail {

    // the location of the called name, for example f in ns::f(x) or in obj.f(x)
    [[nodiscard]] inline clang::SourceLocation callee_loc(const clang::CallExpr& _call) {
      const clang::Expr* callee = _call.getCallee()->IgnoreParenImpCasts();
      if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(callee)) return m->getMemberLoc();
      if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(callee)) return r->getLocation();
      return _call.getBeginLoc();
    }  // callee_loc

    // the names that deleted code changes: the targets of assignments and increments. code with no assignment, for
    // example a call, can change all the names in it
    [[nodiscard]] inline std::unordered_set<std::string> changed_names(const std::string& _text) {
      const auto is_name = [](const std::string& _t) -> bool {
        return !_t.empty() && (std::isalpha(uint8_t(_t[0])) || _t[0] == '_');
      };
      const auto is_assign = [](const std::string& _t) -> bool {
        return _t == "=" ||
               (_t.size() == 2 && _t[1] == '=' && std::string_view("+-*/%&|^").find(_t[0]) != std::string_view::npos);
      };

      // the tokens: names, operators of two characters such as += ++ -> ==, and single characters
      std::vector<std::string> tokens;
      for (size_t i = 0; i < _text.size();) {
        const char c = _text[i];
        if (std::isspace(uint8_t(c))) {
          ++i;
          continue;
        }
        size_t j = i + 1;
        if (std::isalpha(uint8_t(c)) || c == '_') {
          while (j < _text.size() && (std::isalnum(uint8_t(_text[j])) || _text[j] == '_')) ++j;
        } else if (j < _text.size() && std::string_view("=+-*/%&|^<>!").find(c) != std::string_view::npos) {
          const char d = _text[j];
          if (d == '=' || (d == c && (c == '+' || c == '-')) || (c == '-' && d == '>')) ++j;
        }
        tokens.push_back(_text.substr(i, j - i));
        i = j;
      }

      std::unordered_set<std::string> out, all;
      for (size_t k = 0; k < tokens.size(); ++k) {
        if (is_name(tokens[k])) all.insert(tokens[k]);
        if (tokens[k] == "++" || tokens[k] == "--") {
          if (k > 0 && is_name(tokens[k - 1])) out.insert(tokens[k - 1]);
          if (k + 1 < tokens.size() && is_name(tokens[k + 1])) out.insert(tokens[k + 1]);
        }
        if (!is_assign(tokens[k])) continue;

        // the target of the assignment: names joined by . or ->, with subscripts
        for (size_t m = k; m > 0;) {
          if (tokens[m - 1] == "]") {
            for (int32_t depth = 0; m > 0;) {
              const std::string& t = tokens[--m];
              if (t == "]") ++depth;
              if (t == "[" && --depth == 0) break;
            }
            continue;
          }
          if (!is_name(tokens[m - 1])) break;
          out.insert(tokens[--m]);
          if (m == 0 || (tokens[m - 1] != "." && tokens[m - 1] != "->")) break;
          --m;
        }
      }
      return out.empty() ? all : out;
    }  // changed_names

    // true if _e is inside _s, and is not _s
    [[nodiscard]] inline bool is_inside(const clang::Stmt* _e, const clang::Stmt* _s, const clang::ParentMap& _pm) {
      if (_e == _s) return false;
      for (const clang::Stmt* p = _pm.getParent(_e); p; p = _pm.getParent(p))
        if (p == _s) return true;
      return false;
    }  // is_inside

    // the exit of a write to a whole persistent object
    [[nodiscard]] inline ExitKind whole_exit_kind(const Storage _s) {
      switch (_s) {
        case Storage::GLOBAL:
          return ExitKind::GLOBAL;
        case Storage::OUTER:
          return ExitKind::CAPTURE;
        case Storage::THIS:
          return ExitKind::MEMBER;
        default:
          return ExitKind::REFERENCE;
      }
    }  // whole_exit_kind

    struct SliceItem {
      BodyModel* body_       = nullptr;
      int32_t unit_          = -1;
      StepKind kind_         = StepKind::SEED;
      Confidence confidence_ = Confidence::EXACT;
      int32_t distance_      = 0;
      int32_t from_          = -1;
      int32_t member_steps_  = 0;
      std::string via_;
      const clang::Expr* via_expr_ = nullptr;  // the expression that brings the change into the unit
    };  // SliceItem

    // the queue gives the best confidence first, then the fewest member steps, then the shortest distance
    struct SliceItemLater {
      [[nodiscard]] bool operator()(const SliceItem& _a, const SliceItem& _b) const {
        return std::tuple(int32_t(_a.confidence_), _a.member_steps_, _a.distance_) >
               std::tuple(int32_t(_b.confidence_), _b.member_steps_, _b.distance_);
      }
    };  // SliceItemLater

    // finds the units that a seed affects. each unit gets the step of its first arrival from the queue
    class Slicer {
      clang::ASTContext& ctx_;
      const SliceOptions& opts_;
      std::vector<BodyRef>& refs_;
      std::unordered_map<const clang::FunctionDecl*, std::unique_ptr<BodyModel>>& models_;
      std::unordered_map<const BodyModel*, int32_t> slices_;  // model -> index in out_.bodies_
      std::unordered_map<const BodyModel*, std::unordered_set<int32_t>> visited_;
      std::priority_queue<SliceItem, std::vector<SliceItem>, SliceItemLater> queue_;
      SliceModel out_;

     public:
      Slicer(SliceCache& _cache, clang::ASTContext& _ctx, const SliceOptions& _opts)
          : ctx_(_ctx), opts_(_opts), refs_(_cache.refs_), models_(_cache.models_) {}

      [[nodiscard]] SliceModel run(const SliceSeed& _seed) {
        seed_lines(_seed.lines_);
        seed_deleted(_seed.deleted_);
        if (_seed.call_) out_.isCallFound_ = seed_call(_seed.call_->first, _seed.call_->second);
        while (!queue_.empty()) {
          const SliceItem item = queue_.top();
          queue_.pop();
          if (visited_[item.body_].insert(item.unit_).second) process(item);
        }
        return std::move(out_);
      }  // run

     private:
      // the model of a body. it is built at the first request. null if clang cannot build the cfg
      [[nodiscard]] BodyModel* model_of(const BodyRef& _ref) {
        std::unique_ptr<BodyModel>& slot = models_[_ref.fn_];
        if (!slot) {
          slot          = std::make_unique<BodyModel>();
          slot->fn_     = _ref.fn_;
          slot->lambda_ = _ref.lambda_;
          if (!build_body(*slot, ctx_)) slot->cfg_.reset();
        }
        return slot->cfg_ ? slot.get() : nullptr;
      }  // model_of

      [[nodiscard]] const BodyRef* ref_of(const clang::FunctionDecl* _fn) const {
        for (const BodyRef& r : refs_)
          if (r.fn_ == _fn) return &r;
        return nullptr;
      }  // ref_of

      [[nodiscard]] BodySlice& slice_of(const BodyModel& _b) {
        const auto [it, isNew] = slices_.try_emplace(&_b, int32_t(out_.bodies_.size()));
        if (isNew) out_.bodies_.push_back(BodySlice{.fn_ = _b.fn_, .lambda_ = _b.lambda_});
        return out_.bodies_[it->second];
      }  // slice_of

      // an item from a use in an argument of an async call is an async step
      void push(SliceItem&& _item) {
        const clang::CallExpr* call = _item.via_expr_ && _item.kind_ != StepKind::SEED
                                          ? async_call_of(*_item.body_, _item.unit_, _item.via_expr_)
                                          : nullptr;
        if (call) {
          _item.kind_       = StepKind::ASYNC;
          _item.confidence_ = Confidence::ESTIMATED;
          _item.via_        = call->getDirectCallee()->getQualifiedNameAsString();
        }
        queue_.push(std::move(_item));
      }  // push

      // the innermost body that contains a line
      [[nodiscard]] const BodyRef* innermost_at(const uint32_t _line) const {
        const BodyRef* out = nullptr;
        for (const BodyRef& r : refs_)
          if (_line >= r.lines_.first_ && _line <= r.lines_.last_ &&
              (!out || r.lines_.last_ - r.lines_.first_ < out->lines_.last_ - out->lines_.first_))
            out = &r;
        return out;
      }  // innermost_at

      // the units on the changed lines. a changed parameter brings its uses, and a changed case label its switch
      void seed_lines(const std::vector<uint32_t>& _lines) {
        const clang::SourceManager& sm = ctx_.getSourceManager();
        for (const uint32_t line : _lines) {
          bool isInBody = false, isSeeded = false;
          for (const BodyRef& ref : refs_) {
            if (line < ref.lines_.first_ || line > ref.lines_.last_) continue;
            isInBody     = true;
            BodyModel* b = model_of(ref);
            if (!b) continue;
            const auto seed = [&](const int32_t _unit, std::string _via, const clang::Expr* _via_expr) -> void {
              push(SliceItem{.body_       = b,
                             .unit_       = _unit,
                             .confidence_ = opts_.confidence_,
                             .via_        = std::move(_via),
                             .via_expr_   = _via_expr});
              std::vector<uint32_t>& seeds = slice_of(*b).seed_lines_;
              if (std::find(seeds.begin(), seeds.end(), line) == seeds.end()) seeds.push_back(line);
              isSeeded = true;
            };

            for (int32_t u = 0; u < int32_t(b->units_.size()); ++u) {
              const std::vector<uint32_t>& lines = unit_lines(*b, u, sm);
              if (std::find(lines.begin(), lines.end(), line) != lines.end()) seed(u, "", nullptr);
            }

            // a parameter on the line: its uses
            if (!ref.lambda_)
              for (const clang::ParmVarDecl* p : ref.fn_->parameters()) {
                if (sm.getExpansionLineNumber(p->getLocation()) != line) continue;
                for (const Access& a : b->accesses_)
                  if (a.isUse_ && b->values_[a.value_].key_.root_ == p) seed(a.unit_, p->getNameAsString(), a.expr_);
              }

            // a case label on the line: the condition of its switch
            for (int32_t u = 0; u < int32_t(b->units_.size()); ++u) {
              const auto* sw = llvm::dyn_cast_or_null<clang::SwitchStmt>(b->pm_->getParent(b->units_[u]));
              if (!sw || sw->getCond() != b->units_[u]) continue;
              for (const clang::SwitchCase* c = sw->getSwitchCaseList(); c; c = c->getNextSwitchCase())
                if (sm.getExpansionLineNumber(c->getKeywordLoc()) == line) {
                  seed(u, "case label", nullptr);
                  break;
                }
            }
          }
          if (!isInBody)
            out_.outside_.push_back(line);
          else if (!isSeeded)
            out_.quiet_.push_back(line);
        }
      }  // seed_lines

      // a deletion: the later uses of the variables that the deleted code names, in the innermost body.
      // the name of a field of this also counts
      void seed_deleted(const std::vector<std::pair<uint32_t, std::string>>& _deleted) {
        const clang::SourceManager& sm = ctx_.getSourceManager();
        for (const auto& [line, text] : _deleted) {
          const BodyRef* ref = innermost_at(line);
          if (!ref) {
            out_.outside_.push_back(line);
            continue;
          }
          BodyModel* b = model_of(*ref);
          if (!b) continue;

          const std::unordered_set<std::string> names = changed_names(text);
          bool isSeeded                               = false;
          for (const Access& a : b->accesses_) {
            if (!a.isUse_ || !a.expr_) continue;
            const ValueKey& key                = b->values_[a.value_].key_;
            const clang::NamedDecl* named      = key.root_             ? static_cast<const clang::NamedDecl*>(key.root_)
                                                 : key.fields_.empty() ? nullptr
                                                                       : key.fields_.front();
            const std::vector<uint32_t>& lines = unit_lines(*b, a.unit_, sm);
            if (!named || !names.contains(named->getNameAsString()) || lines.empty() || lines.front() < line) continue;
            push(SliceItem{.body_       = b,
                           .unit_       = a.unit_,
                           .confidence_ = opts_.confidence_,
                           .via_        = "deleted " + named->getNameAsString(),
                           .via_expr_   = a.expr_});
            isSeeded = true;
          }
          std::vector<uint32_t>& seeds = slice_of(*b).seed_lines_;
          if (!isSeeded)
            out_.quiet_.push_back(line);
          else if (std::find(seeds.begin(), seeds.end(), line) == seeds.end())
            seeds.push_back(line);
        }
      }  // seed_deleted

      // the call with the called name at the position, or else the innermost call that contains the position
      [[nodiscard]] bool seed_call(const uint32_t _line, const uint32_t _col) {
        const clang::SourceManager& sm = ctx_.getSourceManager();
        std::vector<const clang::CallExpr*> calls;
        CallCollector collector(calls);
        for (const BodyRef& ref : refs_)
          if (!ref.lambda_) collector.TraverseStmt(ref.fn_->getBody());

        const auto pos_of = [&](const clang::SourceLocation _loc) -> std::pair<uint32_t, uint32_t> {
          const clang::SourceLocation at = sm.getFileLoc(_loc);
          return {sm.getExpansionLineNumber(at), sm.getExpansionColumnNumber(at)};
        };
        const auto offset_of = [&](const clang::SourceLocation _loc) -> uint32_t {
          return sm.getFileOffset(sm.getExpansionLoc(_loc));
        };
        const std::pair<uint32_t, uint32_t> pos{_line, _col};
        const clang::CallExpr* best = nullptr;
        uint32_t best_size          = UINT32_MAX;
        for (const clang::CallExpr* c : calls) {
          if (pos_of(callee_loc(*c)) == pos) {
            best = c;
            break;
          }
          if (pos < pos_of(c->getBeginLoc()) || pos_of(c->getEndLoc()) < pos) continue;
          const uint32_t size = offset_of(c->getEndLoc()) - offset_of(c->getBeginLoc());
          if (size < best_size) {
            best      = c;
            best_size = size;
          }
        }
        if (!best) return false;

        // the innermost body that contains the call
        const uint32_t at  = offset_of(best->getBeginLoc());
        const BodyRef* ref = nullptr;
        for (const BodyRef& r : refs_)
          if (r.begin_ <= at && at <= r.end_ && (!ref || r.end_ - r.begin_ < ref->end_ - ref->begin_)) ref = &r;
        BodyModel* b = ref ? model_of(*ref) : nullptr;
        if (!b) return false;
        const auto unit = b->unit_of_.find(best);
        if (unit == b->unit_of_.end()) return false;

        const clang::FunctionDecl* callee = best->getDirectCallee();
        push(SliceItem{.body_       = b,
                       .unit_       = unit->second,
                       .confidence_ = opts_.confidence_,
                       .via_        = callee ? callee->getNameAsString() : std::string(),
                       .via_expr_   = best});
        return true;
      }  // seed_call

      // records the step of an item, its exits, and the items that depend on it
      void process(const SliceItem& _item) {
        BodyModel& b         = *_item.body_;
        const clang::Stmt* u = b.units_[_item.unit_];
        BodySlice& slice     = slice_of(b);
        const int32_t step   = int32_t(slice.steps_.size());
        slice.steps_.push_back(SliceStep{u, _item.kind_, _item.confidence_, _item.distance_, _item.from_, _item.via_});

        const auto next = [&](const int32_t _unit, const StepKind _kind, const Confidence _confidence,
                              const int32_t _member_steps, const std::string& _via,
                              const clang::Expr* _via_expr) -> void {
          push(SliceItem{.body_         = &b,
                         .unit_         = _unit,
                         .kind_         = _kind,
                         .confidence_   = _confidence,
                         .distance_     = _item.distance_ + 1,
                         .from_         = step,
                         .member_steps_ = _member_steps,
                         .via_          = _via,
                         .via_expr_     = _via_expr});
        };

        // an async call: the result of the call carries the change
        if (_item.kind_ == StepKind::ASYNC) add_exit(slice, ExitKind::ASYNC, u, step, _item.via_, true);

        // the change goes into a function of the user, or a lambda captures it. if the body calls the lambda, the
        // change continues in the body of the lambda
        if (_item.via_expr_) {
          if (const clang::CallExpr* call = argument_call(b, _item.unit_, _item.via_expr_))
            add_exit(slice, ExitKind::ARGUMENT, call, step, call->getDirectCallee()->getQualifiedNameAsString(), false);
          if (const clang::LambdaExpr* l = capturing_lambda(b, _item.unit_, _item.via_expr_))
            add_exit(slice, ExitKind::CAPTURE, l, step, _item.via_, enter_lambda(b, l, _item));
        }

        // a decision decides if the calls of the unit run. a function of the user can change more data than its
        // arguments, so its call is an exit
        if (_item.kind_ == StepKind::CONTROL)
          for (const clang::CallExpr* call : user_calls(b.units_[_item.unit_]))
            add_exit(slice, ExitKind::CALL, call, step, call->getDirectCallee()->getQualifiedNameAsString(), false);

        // a return. after the return of a lambda, the change continues at the lambda in the enclosing body
        if (const auto* ret = llvm::dyn_cast<clang::ReturnStmt>(u); ret && ret->getRetValue()) {
          if (b.lambda_) {
            add_exit(slice, ExitKind::RETURN, u, step, "return of the lambda", true);
            continue_after_lambda(_item);
          } else {
            add_exit(slice, ExitKind::RETURN, u, step, short_text(ctx_, u->getSourceRange()), false);
          }
        }

        // the definitions of the unit reach their uses. a changed line or a decision changes all definitions of
        // the unit. a step from one expression changes only the definitions that get its value
        for (const int32_t a : b.unit_accesses_[_item.unit_]) {
          const Access& def = b.accesses_[a];
          if (!def.isDef_ || is_async_object(b, def.expr_)) continue;
          if (_item.via_expr_ && !is_inside(_item.via_expr_, def.expr_ ? def.at_ : u, *b.pm_)) continue;
          const SliceValue& v   = b.values_[def.value_];
          const clang::Stmt* at = def.expr_ ? static_cast<const clang::Stmt*>(def.expr_) : u;

          // a possible write of a whole persistent object, for example a call with a reference argument. the slice
          // does not know what the call changes, so it does not follow the object
          if (def.expr_ && !def.isKill_ && v.key_.fields_.empty() && is_persistent(v.storage_)) {
            add_exit(slice, whole_exit_kind(v.storage_), at, step, v.text_, false);
            continue;
          }

          for (const int32_t use : b.reached_[a])
            next(b.accesses_[use].unit_, StepKind::DATA, _item.confidence_, _item.member_steps_, v.text_,
                 b.accesses_[use].expr_);
          if (!def.expr_ || !is_persistent(v.storage_)) continue;  // a declaration, or a value of this call

          // a field of a persistent object: a later call can read the new value
          if (!v.key_.fields_.empty()) {
            const bool isFollowed = _item.member_steps_ < opts_.max_member_steps_;
            add_exit(slice, ExitKind::MEMBER, at, step, v.text_, isFollowed);
            if (isFollowed)
              for (const Access& use : b.accesses_)
                if (use.isUse_ && is_prefix(v.key_, b.values_[use.value_].key_))
                  next(use.unit_, StepKind::MEMBER, Confidence::ESTIMATED, _item.member_steps_ + 1, v.text_, use.expr_);
          }

          // a write to a pointer parameter changes only the copy of the pointer
          else if (v.storage_ != Storage::PARAM_PTR) {
            add_exit(slice, whole_exit_kind(v.storage_), at, step, v.text_, false);
          }
        }

        // a decision: the units that run only for some of its branches
        if (!b.unit_decisions_[_item.unit_].empty()) {
          const std::string cond = short_text(ctx_, u->getSourceRange());
          for (const int32_t d : b.unit_decisions_[_item.unit_])
            for (const int32_t dep : b.dependents_[d])
              for (const int32_t v : b.block_units_[dep])
                next(v, StepKind::CONTROL, _item.confidence_, _item.member_steps_, cond, nullptr);
        }
      }  // process

      // true if the body calls the lambda: at once, as in [&] { ... }(), or through the variable that the lambda
      // initializes, as in auto f = [&] { ... }; f();. a std::function variable also counts
      [[nodiscard]] bool is_called(const BodyModel& _b, const clang::LambdaExpr* _l) const {
        const clang::Stmt* child = _l;
        const clang::Stmt* p     = _b.pm_->getParent(child);
        while (p && llvm::isa<clang::ImplicitCastExpr, clang::MaterializeTemporaryExpr, clang::CXXBindTemporaryExpr,
                              clang::ExprWithCleanups, clang::ParenExpr, clang::CXXConstructExpr>(p)) {
          child = p;
          p     = _b.pm_->getParent(p);
        }
        if (const auto* op = llvm::dyn_cast_or_null<clang::CXXOperatorCallExpr>(p);
            op && op->getOperator() == clang::OO_Call && op->getNumArgs() > 0 && op->getArg(0) == child)
          return true;
        const auto* ds = llvm::dyn_cast_or_null<clang::DeclStmt>(p);
        if (!ds) return false;
        const clang::VarDecl* var = nullptr;
        for (const clang::Decl* d : ds->decls())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getInit() == child) var = v;
        if (!var) return false;

        // a call of the variable in the body
        std::vector<const clang::Stmt*> todo{_b.lambda_ ? _b.lambda_->getBody() : _b.fn_->getBody()};
        while (!todo.empty()) {
          const clang::Stmt* s = todo.back();
          todo.pop_back();
          if (!s) continue;
          if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(s);
              op && op->getOperator() == clang::OO_Call && op->getNumArgs() > 0)
            if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(op->getArg(0)->IgnoreParenImpCasts());
                r && r->getDecl() == var)
              return true;
          for (const clang::Stmt* c : s->children()) todo.push_back(c);
        }
        return false;
      }  // is_called

      // a lambda that captures the changed variable: if the body calls the lambda, the change continues at the uses of
      // the variable in the body of the lambda. true if it continues
      bool enter_lambda(const BodyModel& _b, const clang::LambdaExpr* _l, const SliceItem& _item) {
        const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(_item.via_expr_->IgnoreParenImpCasts());
        const auto* var = ref ? llvm::dyn_cast<clang::VarDecl>(ref->getDecl()) : nullptr;
        if (!var || !is_called(_b, _l)) return false;
        const BodyRef* inner = ref_of(_l->getCallOperator());
        BodyModel* lb        = inner ? model_of(*inner) : nullptr;
        if (!lb) return false;
        bool out = false;
        for (const Access& a : lb->accesses_) {
          if (!a.isUse_ || lb->values_[a.value_].key_.root_ != var) continue;
          push(SliceItem{.body_         = lb,
                         .unit_         = a.unit_,
                         .kind_         = StepKind::DATA,
                         .confidence_   = _item.confidence_,
                         .distance_     = _item.distance_ + 1,
                         .member_steps_ = _item.member_steps_,
                         .via_          = var->getNameAsString(),
                         .via_expr_     = a.expr_});
          out = true;
        }
        return out;
      }  // enter_lambda

      // the return of a lambda: the change continues at the lambda in the enclosing body
      void continue_after_lambda(const SliceItem& _item) {
        const clang::LambdaExpr* lambda = _item.body_->lambda_;
        const auto* outer  = llvm::dyn_cast<clang::FunctionDecl>(lambda->getLambdaClass()->getDeclContext());
        const BodyRef* ref = outer ? ref_of(outer) : nullptr;
        BodyModel* b       = ref ? model_of(*ref) : nullptr;
        if (!b) return;
        const auto unit = b->unit_of_.find(lambda);
        if (unit == b->unit_of_.end()) return;
        push(SliceItem{.body_         = b,
                       .unit_         = unit->second,
                       .kind_         = StepKind::LAMBDA,
                       .confidence_   = _item.confidence_,
                       .distance_     = _item.distance_ + 1,
                       .member_steps_ = _item.member_steps_,
                       .via_          = "lambda",
                       .via_expr_     = lambda});
      }  // continue_after_lambda

      // adds an exit one time for each kind and text in the body
      void add_exit(BodySlice& _slice, const ExitKind _kind, const clang::Stmt* _at, const int32_t _step,
                    std::string _text, const bool _followed) {
        for (const SliceExit& e : _slice.exits_)
          if (e.kind_ == _kind && e.text_ == _text) return;
        _slice.exits_.push_back(SliceExit{_kind, _at, _step, std::move(_text), _followed});
      }  // add_exit

      // the call of an async function that gets _e as an argument, in the unit. null if there is none
      [[nodiscard]] const clang::CallExpr* async_call_of(const BodyModel& _b, const int32_t _unit,
                                                         const clang::Expr* _e) const {
        const clang::Stmt* unit  = _b.units_[_unit];
        const clang::Stmt* child = _e;
        for (const clang::Stmt* p = _b.pm_->getParent(child); p && child != unit; child = p, p = _b.pm_->getParent(p)) {
          const auto* call = llvm::dyn_cast<clang::CallExpr>(p);
          if (call && name_in(call->getDirectCallee(), opts_.async_functions_) &&
              std::find(call->arg_begin(), call->arg_end(), child) != call->arg_end())
            return call;
        }
        return nullptr;
      }  // async_call_of

      // the call of a function of the user that gets _e as an argument, in the unit. calls of std, of system
      // headers and of operators pass the value on to the call around them
      [[nodiscard]] const clang::CallExpr* argument_call(const BodyModel& _b, const int32_t _unit,
                                                         const clang::Expr* _e) const {
        const clang::Stmt* unit  = _b.units_[_unit];
        const clang::Stmt* child = _e;
        for (const clang::Stmt* p = _b.pm_->getParent(child); p && child != unit; child = p, p = _b.pm_->getParent(p)) {
          const auto* call = llvm::dyn_cast<clang::CallExpr>(p);
          if (call && std::find(call->arg_begin(), call->arg_end(), child) != call->arg_end() && is_user_call(*call))
            return call;
        }
        return nullptr;
      }  // argument_call

      // true if a call goes to a function of the user: not std, not a system header, not an operator, not an async
      // function
      [[nodiscard]] bool is_user_call(const clang::CallExpr& _call) const {
        const clang::FunctionDecl* fn = _call.getDirectCallee();
        return fn && !llvm::isa<clang::CXXOperatorCallExpr>(_call) && !fn->isInStdNamespace() &&
               !ctx_.getSourceManager().isInSystemHeader(fn->getLocation()) && !name_in(fn, opts_.async_functions_);
      }  // is_user_call

      // the calls of functions of the user in a unit, in the sequence of the source. the body of a lambda runs
      // later, so its calls do not count
      [[nodiscard]] std::vector<const clang::CallExpr*> user_calls(const clang::Stmt* _unit) const {
        std::vector<const clang::CallExpr*> out;
        std::vector<const clang::Stmt*> stack{_unit};
        while (!stack.empty()) {
          const clang::Stmt* s = stack.back();
          stack.pop_back();
          if (!s || llvm::isa<clang::LambdaExpr>(s)) continue;
          if (const auto* call = llvm::dyn_cast<clang::CallExpr>(s); call && is_user_call(*call)) out.push_back(call);
          for (const clang::Stmt* child : s->children()) stack.push_back(child);
        }
        const clang::SourceManager& sm = ctx_.getSourceManager();
        std::ranges::sort(out, [&](const clang::CallExpr* _a, const clang::CallExpr* _b) {
          return sm.isBeforeInTranslationUnit(_a->getBeginLoc(), _b->getBeginLoc());
        });
        return out;
      }  // user_calls

      // the lambda in the unit that captures _e, or null
      [[nodiscard]] const clang::LambdaExpr* capturing_lambda(const BodyModel& _b, const int32_t _unit,
                                                              const clang::Expr* _e) const {
        const clang::Stmt* unit  = _b.units_[_unit];
        const clang::Stmt* child = _e;
        for (const clang::Stmt* p = _b.pm_->getParent(child); p && child != unit; child = p, p = _b.pm_->getParent(p))
          if (const auto* l = llvm::dyn_cast<clang::LambdaExpr>(p))
            return std::find(l->capture_init_begin(), l->capture_init_end(), child) != l->capture_init_end() ? l
                                                                                                             : nullptr;
        return nullptr;
      }  // capturing_lambda

      // true for the object of an async call, as executor in executor.async(...). the call changes it, but that
      // is not a part of the change
      [[nodiscard]] bool is_async_object(const BodyModel& _b, const clang::Expr* _e) const {
        if (!_e) return false;
        auto* member = llvm::dyn_cast_or_null<clang::MemberExpr>(
            _b.pm_->getParentIgnoreParenImpCasts(const_cast<clang::Expr*>(_e)));
        const auto* call =
            member ? llvm::dyn_cast_or_null<clang::CXXMemberCallExpr>(_b.pm_->getParentIgnoreParenImpCasts(member))
                   : nullptr;
        return call && call->getCallee()->IgnoreParenImpCasts() == member &&
               name_in(call->getDirectCallee(), opts_.async_functions_);
      }  // is_async_object

    };  // Slicer
  }  // namespace Detail

  // the forward slice of the seed, in the functions of the main file and their lambdas. the cache keeps the body models
  // for the next slices of the same parse
  [[nodiscard]] inline SliceModel build_slice(const std::vector<const clang::FunctionDecl*>& _fns,
                                              const SliceSeed& _seed, clang::ASTContext& _ctx,
                                              const SliceOptions& _opts, SliceCache& _cache) {
    const TraversalScope scope(_ctx, _fns);  // the mutation analyzer needs the parents in these functions only
    if (!_cache.isReady_) {
      _cache.refs_    = Detail::main_file_bodies(_fns, _ctx.getSourceManager());
      _cache.isReady_ = true;
    }
    Detail::Slicer slicer(_cache, _ctx, _opts);
    return slicer.run(_seed);
  }  // build_slice

  //----------------------------------
  // Json

  namespace Detail {
    [[nodiscard]] inline const char* step_kind_name(const StepKind _kind) {
      switch (_kind) {
        case StepKind::SEED:
          return "seed";
        case StepKind::DATA:
          return "data";
        case StepKind::CONTROL:
          return "control";
        case StepKind::MEMBER:
          return "member";
        case StepKind::ASYNC:
          return "async";
        case StepKind::LAMBDA:
          return "lambda";
      }
      return "data";
    }  // step_kind_name

    [[nodiscard]] inline const char* confidence_name(const Confidence _confidence) {
      switch (_confidence) {
        case Confidence::EXACT:
          return "exact";
        case Confidence::CALL:
          return "call";
        case Confidence::ESTIMATED:
          return "estimated";
      }
      return "estimated";
    }  // confidence_name

    [[nodiscard]] inline const char* exit_kind_name(const ExitKind _kind) {
      switch (_kind) {
        case ExitKind::RETURN:
          return "return";
        case ExitKind::MEMBER:
          return "member";
        case ExitKind::GLOBAL:
          return "global";
        case ExitKind::REFERENCE:
          return "reference";
        case ExitKind::ARGUMENT:
          return "argument";
        case ExitKind::CAPTURE:
          return "capture";
        case ExitKind::ASYNC:
          return "async";
        case ExitKind::CALL:
          return "call";
      }
      return "argument";
    }  // exit_kind_name

    // the function of a body. for a lambda, the named function around it
    [[nodiscard]] inline const clang::FunctionDecl* named_function(const clang::FunctionDecl* _fn) {
      while (const auto* m = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(_fn)) {
        if (!m->getParent()->isLambda()) break;
        _fn = llvm::dyn_cast<clang::FunctionDecl>(m->getParent()->getDeclContext());
      }
      return _fn;
    }  // named_function

    // true if the call calls the function, also through a template instantiation
    [[nodiscard]] inline bool calls_function(const clang::CallExpr& _call, const clang::FunctionDecl& _fn) {
      const clang::FunctionDecl* callee = _call.getDirectCallee();
      if (!callee) return false;
      if (const clang::FunctionDecl* pattern = callee->getTemplateInstantiationPattern()) callee = pattern;
      return callee->getCanonicalDecl() == _fn.getCanonicalDecl();
    }  // calls_function
  }  // namespace Detail

  [[nodiscard]] inline JsonObject slice_to_json(const SliceModel& _model,
                                                const std::vector<const clang::FunctionDecl*>& _fns,
                                                clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const auto lines_json          = [](const std::vector<uint32_t>& _lines) -> JsonArray {
      JsonArray out;
      for (const uint32_t l : _lines) out.push_back(int64_t(l));
      return out;
    };

    // the calls of the main file, for the callers of the functions with a return exit
    std::vector<const clang::CallExpr*> calls;
    bool isCollected = false;

    JsonArray bodies;
    for (const BodySlice& s : _model.bodies_) {
      const clang::FunctionDecl* fn = Detail::named_function(s.fn_);
      if (!fn) continue;
      JsonObject body{{"function", function_to_json(*fn, sm)}, {"seedLines", lines_json(s.seed_lines_)}};
      if (s.lambda_) body["lambda"] = Detail::loc_to_json(sm, s.lambda_->getBeginLoc());

      JsonArray steps;
      for (const SliceStep& st : s.steps_) {
        const clang::SourceRange r = st.unit_->getSourceRange();
        JsonObject o               = Detail::span_to_json(Detail::span_of(r, _ctx), sm);
        o["lines"]                 = lines_json(Detail::stmt_lines(st.unit_, sm));
        o["kind"]                  = Detail::step_kind_name(st.kind_);
        o["confidence"]            = Detail::confidence_name(st.confidence_);
        o["distance"]              = int64_t(st.distance_);
        o["from"]                  = int64_t(st.from_);
        o["via"]                   = st.via_;
        o["text"]                  = Detail::short_text(_ctx, r);
        steps.push_back(std::move(o));
      }

      JsonArray exits;
      bool hasReturn = false;
      for (const SliceExit& e : s.exits_) {
        JsonObject o  = Detail::span_to_json(Detail::span_of(e.at_->getSourceRange(), _ctx), sm);
        o["kind"]     = Detail::exit_kind_name(e.kind_);
        o["text"]     = e.text_;
        o["step"]     = int64_t(e.step_);
        o["followed"] = e.isFollowed_;
        exits.push_back(std::move(o));
        hasReturn = hasReturn || (e.kind_ == ExitKind::RETURN && !s.lambda_);
      }
      body["steps"] = std::move(steps);
      body["exits"] = std::move(exits);

      // the callers in this file. the call hierarchy of the editor can add callers in other files
      if (hasReturn) {
        if (!isCollected) {
          Detail::CallCollector collector(calls);
          for (const clang::FunctionDecl* f : _fns)
            if (f->getBody()) collector.TraverseStmt(f->getBody());
          isCollected = true;
        }
        JsonArray callers;
        for (const clang::CallExpr* c : calls) {
          if (!Detail::calls_function(*c, *s.fn_)) continue;
          const clang::SourceLocation at   = sm.getFileLoc(Detail::callee_loc(*c));
          const uint32_t line              = sm.getExpansionLineNumber(at);
          const uint32_t col               = sm.getExpansionColumnNumber(at);
          const clang::FunctionDecl* outer = function_at(_fns, sm, line, col);
          callers.push_back(JsonObject{{"line", int64_t(line)},
                                       {"col", int64_t(col)},
                                       {"function", outer ? outer->getQualifiedNameAsString() : std::string()}});
        }
        body["callers"] = std::move(callers);
      }
      bodies.push_back(std::move(body));
    }

    return JsonObject{{"bodies", std::move(bodies)},
                      {"outside", lines_json(_model.outside_)},
                      {"quiet", lines_json(_model.quiet_)},
                      {"callFound", _model.isCallFound_}};
  }  // slice_to_json

}  // namespace DataFlow
