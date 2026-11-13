#pragma once

#include <dataflow/compile_db.hpp>
#include <dataflow/member.hpp>

/*
  The call graph of the functions of the main file, for Call Hierarchy:
    > functions: the functions of the main file and the functions that they call. a call in a lambda belongs to the
      function around the lambda
    > calls: each call with its position and its data:
      > the thread start that runs the call, if the call is in a lambda that a thread or an async function gets
      > a call of an event function
      > the arguments that the call can write: a non-const reference or the address of a variable
      > the use of the result: discarded, returned, stored in a variable, checked in a condition, or used
      > a std::optional result: checked, or not checked before an access
*/

namespace DataFlow {

  enum class CallResult { NONE, DISCARDED, RETURNED, STORED, CHECKED, USED };
  enum class OptionalUse { NONE, CHECKED, UNCHECKED };

  struct CallFunction {
    const clang::FunctionDecl* fn_ = nullptr;  // the canonical declaration
    bool isCaller_                 = false;    // a function of the main file with a body: its calls are in the graph
  };  // CallFunction

  struct CallSite {
    int32_t from_                = -1;
    int32_t to_                  = -1;
    const clang::CallExpr* call_ = nullptr;
    clang::SourceLocation loc_;
    bool isInLambda_ = false;
    std::string async_;  // the thread start that runs the call, for example std::thread. empty for no thread
    bool isEvent_ = false;
    std::vector<std::string> writes_;
    CallResult result_ = CallResult::NONE;
    std::string into_;  // the variable that stores the result
    const clang::ValueDecl* into_decl_ = nullptr;
    OptionalUse optional_              = OptionalUse::NONE;
    uint32_t unchecked_line_           = 0;  // the line of the first access with no check
    int32_t virtualOf_ = -1;  // an override that a virtual call can run: the function that the call names
  };  // CallSite

  struct CallGraph {
    std::vector<CallFunction> functions_;
    std::vector<CallSite> calls_;
  };  // CallGraph

  struct CallOptions {
    std::vector<std::string> event_functions_;
    std::vector<std::string> async_functions_;
    std::vector<std::string> roots_;  // the folders of the project. a function outside of them is a library function
  };  // CallOptions

  namespace Detail {
    // the methods that override each method, by the canonical declaration of the overridden method
    using overrides_t = std::unordered_map<const clang::CXXMethodDecl*, std::vector<const clang::CXXMethodDecl*>>;

    // the files of the project: the main file and the files in the folders of the project, but not in the skipped
    // folders. with no folders, all files except the system headers
    class ProjectFiles {
      const clang::SourceManager& sm_;
      std::vector<std::string> roots_;  // as keys of normalize_path
      std::vector<std::string> skips_;
      llvm::DenseMap<clang::FileID, bool> files_;

     public:
      ProjectFiles(const clang::SourceManager& _sm, const std::vector<std::string>& _roots,
                   const std::vector<std::string>& _skips = {})
          : sm_(_sm) {
        for (const std::string& r : _roots) roots_.push_back(normalize_path(r));
        for (const std::string& s : _skips) skips_.push_back(normalize_path(s));
      }

      [[nodiscard]] bool contains(const clang::SourceLocation _loc) {
        const clang::SourceLocation at = sm_.getFileLoc(_loc);
        if (at.isInvalid() || sm_.isInSystemHeader(at)) return false;
        if (sm_.isInMainFile(at) || roots_.empty()) return true;
        const auto [it, isNew] = files_.try_emplace(sm_.getFileID(at), false);
        if (isNew) {
          const std::string key = normalize_path(file_of(sm_, at));
          const auto is_under   = [&](const std::string& _dir) {
            return key.size() > _dir.size() && key.starts_with(_dir) && llvm::sys::path::is_separator(key[_dir.size()]);
          };
          it->second = std::ranges::any_of(roots_, is_under) && std::ranges::none_of(skips_, is_under);
        }
        return it->second;
      }  // contains
    };  // ProjectFiles

    // finds the overrides in the namespaces and the classes of the project, not in the bodies of the functions. an
    // override in a library does not count, so a large library does not make the search slow
    inline void add_overrides(const clang::DeclContext& _dc, ProjectFiles& _files, overrides_t& _out) {
      for (const clang::Decl* d : _dc.decls()) {
        if (!_files.contains(d->getLocation())) continue;
        if (const auto* t = llvm::dyn_cast<clang::ClassTemplateDecl>(d)) d = t->getTemplatedDecl();
        if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(d)) {
          for (const clang::CXXMethodDecl* o : m->overridden_methods()) {
            std::vector<const clang::CXXMethodDecl*>& list = _out[o->getCanonicalDecl()];
            if (!llvm::is_contained(list, m->getCanonicalDecl())) list.push_back(m->getCanonicalDecl());
          }
        } else if (llvm::isa<clang::NamespaceDecl, clang::CXXRecordDecl, clang::LinkageSpecDecl, clang::ExportDecl>(
                       d)) {
          add_overrides(*llvm::cast<clang::DeclContext>(d), _files, _out);
        }
      }
    }  // add_overrides

    [[nodiscard]] inline bool is_optional_type(const clang::QualType _t) {
      const clang::CXXRecordDecl* rd = record_of(_t.getNonReferenceType());
      return rd && rd->getIdentifier() && rd->getName() == "optional" && is_in_std(rd);
    }  // is_optional_type

    // the parent map of a function: its body and the initializers of a constructor
    [[nodiscard]] inline std::unique_ptr<clang::ParentMap> parents_of(const clang::FunctionDecl& _fn) {
      auto out = std::make_unique<clang::ParentMap>(_fn.getBody());
      if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(&_fn))
        for (const clang::CXXCtorInitializer* init : ctor->inits())
          if (init->isWritten() && init->getInit()) out->addStmt(init->getInit());
      return out;
    }  // parents_of

    // the text of an argument: no & for an address, and no this->
    [[nodiscard]] inline std::string argument_text(const clang::Expr* _e, const clang::ASTContext& _ctx) {
      std::string out = short_text(_ctx, _e->getSourceRange());
      if (out.starts_with("&")) out.erase(0, 1);
      if (out.starts_with("this->")) out.erase(0, 6);
      return out;
    }  // argument_text

    // the arguments that a call can write: a non-const lvalue reference, and the address of a variable for a pointer to
    // non-const. a forwarding reference is not a write. the object of a member function is not an argument: a call of a
    // setter changes its object, so the object of each call of a widget would be a write
    [[nodiscard]] inline std::vector<std::string> writes_of(const clang::CallExpr* _c,
                                                            const clang::FunctionDecl* _callee,
                                                            const clang::ASTContext& _ctx) {
      std::vector<std::string> out;
      const bool isMemberOperator =
          llvm::isa<clang::CXXOperatorCallExpr>(_c) && llvm::isa<clang::CXXMethodDecl>(_callee);
      const uint32_t first = isMemberOperator ? 1 : 0;  // the object of a member operator is the first argument
      const clang::FunctionDecl* pattern = _callee->getTemplateInstantiationPattern();
      for (uint32_t i = 0; i + first < _c->getNumArgs() && i < _callee->getNumParams(); ++i) {
        if (pattern && i < pattern->getNumParams() && pattern->getParamDecl(i)->getType()->isRValueReferenceType())
          continue;
        const clang::QualType type = _callee->getParamDecl(i)->getType();
        const clang::Expr* arg     = _c->getArg(i + first);
        const auto* addr           = llvm::dyn_cast<clang::UnaryOperator>(arg->IgnoreParenImpCasts());
        const bool isRef           = type->isLValueReferenceType() && !type.getNonReferenceType().isConstQualified();
        const bool isAddr          = type->isPointerType() && !type->getPointeeType().isConstQualified() && addr &&
                            addr->getOpcode() == clang::UO_AddrOf;
        if (isRef || isAddr) out.push_back(argument_text(arg, _ctx));
      }

      std::ranges::sort(out);
      out.erase(std::unique(out.begin(), out.end()), out.end());
      std::erase(out, std::string());
      return out;
    }  // writes_of

    // the use of the result of a call: discarded, returned, stored in a variable, checked in a condition, or used
    [[nodiscard]] inline CallResult result_of(const clang::CallExpr* _c, const clang::FunctionDecl* _callee,
                                              const clang::ParentMap& _pm, const clang::ASTContext& _ctx,
                                              CallSite& _site) {
      if (_callee->getReturnType()->isVoidType()) return CallResult::NONE;
      const clang::Stmt* child = _c;
      const clang::Stmt* p     = _pm.getParent(child);
      while (p) {
        const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(p);
        if (!llvm::isa<clang::ImplicitCastExpr, clang::ExprWithCleanups, clang::MaterializeTemporaryExpr,
                       clang::CXXBindTemporaryExpr, clang::ParenExpr>(p) &&
            !(c && c->getNumArgs() == 1))
          break;
        child = p;
        p     = _pm.getParent(p);
      }
      if (!p) return CallResult::USED;  // an initializer of a constructor
      if (const auto* cast = llvm::dyn_cast<clang::ExplicitCastExpr>(p); cast && cast->getType()->isVoidType())
        return CallResult::DISCARDED;
      if (llvm::isa<clang::ReturnStmt>(p)) return CallResult::RETURNED;
      if (const auto* ds = llvm::dyn_cast<clang::DeclStmt>(p)) {
        for (const clang::Decl* d : ds->decls())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getInit() == child) {
            _site.into_      = v->getNameAsString();
            _site.into_decl_ = v;
          }
        return CallResult::STORED;
      }

      // an assignment, also with the operator of a class
      const clang::Expr* target = nullptr;
      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(p); b && b->isAssignmentOp() && b->getRHS() == child)
        target = b->getLHS();
      const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(p);
      if (op && op->getOperator() == clang::OO_Equal && op->getNumArgs() == 2 && op->getArg(1) == child)
        target = op->getArg(0);
      if (target) {
        _site.into_ = argument_text(target, _ctx);
        if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(target->IgnoreParenImpCasts()))
          _site.into_decl_ = ref->getDecl();
        return CallResult::STORED;
      }

      if (is_in_condition(child, _pm)) return CallResult::CHECKED;
      if (!llvm::isa<clang::Expr>(p)) return CallResult::DISCARDED;  // a statement, for example the body of an if
      return CallResult::USED;
    }  // result_of

    // the references to a variable in a statement
    class RefFinder : public clang::RecursiveASTVisitor<RefFinder> {
      const clang::ValueDecl* decl_ = nullptr;

     public:
      std::vector<const clang::DeclRefExpr*> out_;

      explicit RefFinder(const clang::ValueDecl* _decl) : decl_(_decl) {}

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        if (_e->getDecl() == decl_) out_.push_back(_e);
        return true;
      }
    };  // RefFinder

    // marks the std::optional results that the function accesses with no check, with the unchecked access model of
    // clang. a result with no access and no check keeps NONE
    inline void set_optional_uses(CallGraph& _graph, const std::vector<int32_t>& _sites, const clang::FunctionDecl& _fn,
                                  clang::ASTContext& _ctx) {
      using namespace clang::dataflow;
      const clang::SourceManager& sm = _ctx.getSourceManager();
      std::unordered_set<clang::SourceLocation::UIntTy> unchecked;
      const TraversalScope scope(_ctx, {&_fn});
      UncheckedOptionalAccessDiagnoser diagnoser;
      auto res =
          diagnoseFunction<UncheckedOptionalAccessModel, UncheckedOptionalAccessDiagnostic>(_fn, _ctx, diagnoser);
      if (res) {
        for (const UncheckedOptionalAccessDiagnostic& d : *res)
          unchecked.insert(sm.getExpansionLoc(d.Range.getBegin()).getRawEncoding());
      } else {
        llvm::consumeError(res.takeError());
      }

      for (const int32_t i : _sites) {
        CallSite& s = _graph.calls_[i];
        if (s.result_ == CallResult::CHECKED) s.optional_ = OptionalUse::CHECKED;
        if (unchecked.contains(sm.getExpansionLoc(s.call_->getBeginLoc()).getRawEncoding())) {
          s.optional_       = OptionalUse::UNCHECKED;
          s.unchecked_line_ = sm.getExpansionLineNumber(s.call_->getBeginLoc());
          continue;
        }
        if (!s.into_decl_) continue;

        // the accesses of the variable after the call. one access with no check is enough
        RefFinder refs(s.into_decl_);
        refs.TraverseStmt(_fn.getBody());
        bool isAccessed = false;
        for (const clang::DeclRefExpr* r : refs.out_) {
          const clang::SourceLocation at = sm.getExpansionLoc(r->getBeginLoc());
          if (sm.isBeforeInTranslationUnit(at, sm.getExpansionLoc(s.call_->getEndLoc()))) continue;
          isAccessed = true;
          if (unchecked.contains(at.getRawEncoding())) {
            s.optional_       = OptionalUse::UNCHECKED;
            s.unchecked_line_ = sm.getExpansionLineNumber(at);
            break;
          }
        }
        if (isAccessed && s.optional_ != OptionalUse::UNCHECKED) s.optional_ = OptionalUse::CHECKED;
      }
    }  // set_optional_uses

    //----------------------------------
    // Visitors

    // collects the calls of one function of the main file. a call in a lambda belongs to the function
    class CallGraphCollector : public clang::RecursiveASTVisitor<CallGraphCollector> {
      using Base = clang::RecursiveASTVisitor<CallGraphCollector>;
      const clang::ASTContext& ctx_;
      const CallOptions& opts_;
      const MemberOptions starts_;
      const clang::ParentMap& pm_;
      CallGraph& graph_;
      std::unordered_map<const clang::FunctionDecl*, int32_t>& index_;
      const overrides_t& overrides_;
      int32_t from_ = -1;
      std::vector<std::string> async_;  // the thread start of each lambda around the node. empty for no thread

     public:
      CallGraphCollector(const clang::ASTContext& _ctx, const CallOptions& _opts, const clang::ParentMap& _pm,
                         CallGraph& _graph, std::unordered_map<const clang::FunctionDecl*, int32_t>& _index,
                         const overrides_t& _overrides, const int32_t _from)
          : ctx_(_ctx),
            opts_(_opts),
            starts_{_opts.async_functions_},
            pm_(_pm),
            graph_(_graph),
            index_(_index),
            overrides_(_overrides),
            from_(_from) {}

      bool shouldVisitTemplateInstantiations() const { return false; }

      // a lambda that a thread start gets runs its calls on that thread. a lambda in it runs them on the same thread
      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        for (clang::Expr* init : _e->capture_inits())
          if (init && !TraverseStmt(init)) return false;
        const std::string via = start_name(call_of_lambda(_e, pm_), starts_);
        async_.push_back(!via.empty() ? via : async_.empty() ? std::string() : async_.back());
        const bool res = TraverseStmt(_e->getBody());
        async_.pop_back();
        return res;
      }  // TraverseLambdaExpr

      bool VisitCallExpr(clang::CallExpr* _e) {
        add(_e);
        return true;
      }

     private:
      void add(const clang::CallExpr* _c) {
        const clang::FunctionDecl* callee = called_function(_c);
        if (!callee) return;
        // an implicit conversion, for example operator bool in if (opt), has no name in the source
        const auto* cast = llvm::dyn_cast_or_null<clang::ImplicitCastExpr>(pm_.getParent(_c));
        if (cast && cast->getCastKind() == clang::CK_UserDefinedConversion) return;
        const clang::SourceManager& sm = ctx_.getSourceManager();
        const clang::SourceLocation at = sm.getFileLoc(_c->getExprLoc());
        if (at.isInvalid() || !sm.isInMainFile(at)) return;

        CallSite s;
        s.from_       = from_;
        s.to_         = index_of(*callee, index_, graph_);
        s.call_       = _c;
        s.loc_        = at;
        s.isInLambda_ = !async_.empty();
        s.async_      = async_.empty() ? std::string() : async_.back();
        s.isEvent_    = name_in(callee, opts_.event_functions_);
        s.writes_     = writes_of(_c, callee, ctx_);
        s.result_     = result_of(_c, callee, pm_, ctx_, s);
        graph_.calls_.push_back(std::move(s));
        add_overrides_of(_c);
      }  // add

      // a virtual call can also run an override of the function that it names, in a class of the object. a call with a
      // qualifier, for example Base::run(), runs the named function. a final function and a final class have no
      // override
      void add_overrides_of(const clang::CallExpr* _c) {
        const auto* mc     = llvm::dyn_cast<clang::CXXMemberCallExpr>(_c);
        const auto* method = mc ? mc->getMethodDecl() : nullptr;
        const auto* member = mc ? llvm::dyn_cast<clang::MemberExpr>(mc->getCallee()->IgnoreParens()) : nullptr;
        if (!method || !method->isVirtual() || !member || member->hasQualifier() || method->hasAttr<clang::FinalAttr>())
          return;
        // the class of the object before the conversion to the class of the function, for example Plain for p.sides()
        clang::QualType type = mc->getImplicitObjectArgument()->IgnoreParenImpCasts()->getType();
        if (type->isPointerType()) type = type->getPointeeType();
        const clang::CXXRecordDecl* object = type->getAsCXXRecordDecl();
        if (object && object->hasAttr<clang::FinalAttr>()) return;

        const size_t at = graph_.calls_.size() - 1;
        std::vector<const clang::CXXMethodDecl*> todo{method->getCanonicalDecl()};
        std::vector<const clang::CXXMethodDecl*> seen;
        while (!todo.empty()) {
          const auto it = overrides_.find(todo.back());
          todo.pop_back();
          if (it == overrides_.end()) continue;
          for (const clang::CXXMethodDecl* o : it->second) {
            if (llvm::is_contained(seen, o)) continue;
            seen.push_back(o);
            todo.push_back(o);
            const clang::CXXRecordDecl* rd = o->getParent();
            if (object && rd->getCanonicalDecl() != object->getCanonicalDecl() && !rd->isDerivedFrom(object)) continue;
            CallSite v   = graph_.calls_[at];
            v.virtualOf_ = v.to_;
            v.to_        = index_of(*o, index_, graph_);
            graph_.calls_.push_back(std::move(v));
          }
        }
      }  // add_overrides_of

     public:
      // the index of a function in the graph. the canonical declaration is the key
      static int32_t index_of(const clang::FunctionDecl& _fn,
                              std::unordered_map<const clang::FunctionDecl*, int32_t>& _index, CallGraph& _graph) {
        const clang::FunctionDecl* key = _fn.getCanonicalDecl();
        const auto [it, isNew]         = _index.try_emplace(key, int32_t(_graph.functions_.size()));
        if (isNew) _graph.functions_.push_back(CallFunction{key, false});
        return it->second;
      }  // index_of

    };  // CallGraphCollector
  }  // namespace Detail

  [[nodiscard]] inline CallGraph build_calls(clang::ASTUnit& _ast, const CallOptions& _opts) {
    clang::ASTContext& ctx = _ast.getASTContext();
    CallGraph out;
    std::unordered_map<const clang::FunctionDecl*, int32_t> index;

    // the functions of the main file first, so that a caller has a low index
    const std::vector<const clang::FunctionDecl*> fns = main_file_functions(_ast);
    for (const clang::FunctionDecl* f : fns)
      out.functions_[Detail::CallGraphCollector::index_of(*f, index, out)].isCaller_ = true;
    Detail::overrides_t overrides;
    Detail::ProjectFiles project(ctx.getSourceManager(), _opts.roots_);
    Detail::add_overrides(*ctx.getTranslationUnitDecl(), project, overrides);

    for (const clang::FunctionDecl* f : fns) {
      if (!f->getBody()) continue;
      const int32_t from                         = index.at(f->getCanonicalDecl());
      const std::unique_ptr<clang::ParentMap> pm = Detail::parents_of(*f);
      const size_t first                         = out.calls_.size();
      Detail::CallGraphCollector collector(ctx, _opts, *pm, out, index, overrides, from);
      collector.TraverseStmt(f->getBody());
      if (const auto* ctor = llvm::dyn_cast<clang::CXXConstructorDecl>(f))
        for (const clang::CXXCtorInitializer* init : ctor->inits())
          if (init->isWritten() && init->getInit()) collector.TraverseStmt(init->getInit());

      // the std::optional results of the calls of this function
      std::vector<int32_t> optionals;
      for (size_t i = first; i < out.calls_.size(); ++i) {
        const clang::FunctionDecl* callee = out.calls_[i].call_->getDirectCallee();
        if (callee && Detail::is_optional_type(callee->getReturnType())) optionals.push_back(int32_t(i));
      }
      if (!optionals.empty()) Detail::set_optional_uses(out, optionals, *f, ctx);
    }
    return out;
  }  // build_calls

  //----------------------------------
  // Json

  namespace Detail {
    [[nodiscard]] inline const char* call_result_name(const CallResult _result) {
      switch (_result) {
        case CallResult::NONE:
          return "none";
        case CallResult::DISCARDED:
          return "discarded";
        case CallResult::RETURNED:
          return "returned";
        case CallResult::STORED:
          return "stored";
        case CallResult::CHECKED:
          return "checked";
        case CallResult::USED:
          return "used";
      }
      return "used";
    }  // call_result_name

    // main: the main file has the definition, or the declaration if there is no definition. library: a system header,
    // the namespace std, or a file outside of the project folders. project: all other files
    [[nodiscard]] inline const char* call_place(const clang::FunctionDecl& _fn, const clang::SourceManager& _sm,
                                                const std::vector<std::string>& _roots) {
      const clang::FunctionDecl* def = _fn.getDefinition();
      const clang::SourceLocation at = _sm.getFileLoc((def ? def : &_fn)->getLocation());
      if (_sm.isInMainFile(at)) return "main";
      if (_sm.isInSystemHeader(at) || is_in_std(&_fn)) return "library";
      if (_roots.empty()) return "project";
      const std::string key = normalize_path(file_of(_sm, at));
      const bool isInRoots  = std::ranges::any_of(_roots, [&](const std::string& _r) {
        const std::string root = normalize_path(_r);
        return key.size() > root.size() && key.starts_with(root) && llvm::sys::path::is_separator(key[root.size()]);
      });
      return isInRoots ? "project" : "library";
    }  // call_place
  }  // namespace Detail

  [[nodiscard]] inline JsonObject calls_to_json(const CallGraph& _graph, clang::ASTContext& _ctx,
                                                const CallOptions& _opts) {
    const clang::SourceManager& sm = _ctx.getSourceManager();

    JsonArray functions;
    for (const CallFunction& f : _graph.functions_) {
      const clang::FunctionDecl* def = f.fn_->getDefinition();
      const clang::FunctionDecl& fn  = def ? *def : *f.fn_;
      const auto* method             = llvm::dyn_cast<clang::CXXMethodDecl>(&fn);
      const bool isLambda            = method && method->getParent()->isLambda();
      const char* kind               = isLambda                                   ? "lambda"
                                       : llvm::isa<clang::CXXConstructorDecl>(fn) ? "constructor"
                                       : llvm::isa<clang::CXXDestructorDecl>(fn)  ? "destructor"
                                       : method                                   ? "method"
                                                                                  : "function";
      JsonObject o                   = Detail::place_to_json(fn.getLocation(), _ctx);
      o["name"]                      = isLambda ? std::string("lambda") : fn.getNameAsString();
      o["qualifiedName"]             = isLambda ? std::string() : fn.getQualifiedNameAsString();
      if (std::optional<std::string> call = macro_call_text(fn); call && !isLambda) o["macroCall"] = std::move(*call);
      o["kind"]                      = kind;
      o["where"]                     = Detail::call_place(fn, sm, _opts.roots_);
      o["isDefined"]                 = def != nullptr;
      if (f.isCaller_ && def) {
        const clang::CharSourceRange r = sm.getExpansionRange(def->getSourceRange());
        o["range"]                     = JsonObject{{"begin", int64_t(sm.getExpansionLineNumber(r.getBegin()))},
                                                    {"end", int64_t(sm.getExpansionLineNumber(r.getEnd()))}};
      }
      functions.push_back(std::move(o));
    }

    JsonArray calls;
    for (const CallSite& s : _graph.calls_) {
      JsonObject o{{"from", int64_t(s.from_)},
                   {"to", int64_t(s.to_)},
                   {"line", int64_t(sm.getExpansionLineNumber(s.loc_))},
                   {"col", int64_t(sm.getExpansionColumnNumber(s.loc_))},
                   {"result", Detail::call_result_name(s.result_)}};
      if (s.isInLambda_) o["inLambda"] = true;
      if (!s.async_.empty()) o["async"] = s.async_;
      if (s.isEvent_) o["event"] = true;
      if (!s.writes_.empty()) {
        JsonArray writes;
        for (const std::string& w : s.writes_) writes.push_back(w);
        o["writes"] = std::move(writes);
      }
      if (!s.into_.empty()) o["into"] = s.into_;
      if (s.optional_ == OptionalUse::CHECKED) o["optional"] = "checked";
      if (s.optional_ == OptionalUse::UNCHECKED) {
        o["optional"]      = "unchecked";
        o["uncheckedLine"] = int64_t(s.unchecked_line_);
      }
      if (s.virtualOf_ >= 0) o["virtualOf"] = int64_t(s.virtualOf_);
      calls.push_back(std::move(o));
    }

    return JsonObject{{"functions", std::move(functions)}, {"calls", std::move(calls)}};
  }  // calls_to_json

}  // namespace DataFlow
