#pragma once

#include <dataflow/defines.hpp>

namespace DataFlow {

  // a range on one line of the file. len counts utf-8 bytes
  struct Span {
    clang::SourceLocation loc_;
    uint32_t len_ = 0;
  };  // Span

  namespace Detail {
    // the absolute path of a file, with native separators and without dots
    [[nodiscard]] inline std::string path_of(const clang::FileEntryRef _entry, const clang::FileManager& _files) {
      llvm::SmallString<256> path(_entry.getName());
      _files.makeAbsolutePath(path);
      llvm::sys::path::remove_dots(path, true);
      llvm::sys::path::native(path);
      return std::string(path);
    }  // path_of

    // the absolute path of the file of a location. empty for a buffer with no file, for example <built-in>
    [[nodiscard]] inline std::string file_of(const clang::SourceManager& _sm, const clang::SourceLocation _loc) {
      const clang::OptionalFileEntryRef entry = _sm.getFileEntryRefForID(_sm.getFileID(_sm.getFileLoc(_loc)));
      return entry ? path_of(*entry, _sm.getFileManager()) : std::string();
    }  // file_of

    [[nodiscard]] inline JsonObject loc_to_json(const clang::SourceManager& _sm, const clang::SourceLocation _loc) {
      const clang::SourceLocation exp = _sm.getExpansionLoc(_loc);
      return JsonObject{{"line", int64_t(_sm.getExpansionLineNumber(exp))},
                        {"col", int64_t(_sm.getExpansionColumnNumber(exp))}};
    }  // loc_to_json

    [[nodiscard]] inline JsonObject range_to_json(const clang::SourceManager& _sm, const clang::SourceRange _range) {
      return JsonObject{{"begin", loc_to_json(_sm, _range.getBegin())}, {"end", loc_to_json(_sm, _range.getEnd())}};
    }  // range_to_json

    [[nodiscard]] inline std::string source_text(const clang::ASTContext& _ctx, const clang::SourceRange _range) {
      const clang::SourceManager& sm = _ctx.getSourceManager();
      return clang::Lexer::getSourceText(sm.getExpansionRange(_range), sm, _ctx.getLangOpts()).str();
    }  // source_text

    // the text on one line with single spaces, with at most _max bytes
    [[nodiscard]] inline std::string one_line(const llvm::StringRef _text, const size_t _max = 120) {
      std::string out;
      bool isSpace = false;
      for (const char c : _text) {
        if (std::isspace(static_cast<unsigned char>(c))) {
          isSpace = !out.empty();
          continue;
        }
        if (isSpace) out += ' ';
        isSpace = false;
        out += c;
      }
      if (out.size() <= _max) return out;
      size_t end = _max - 3;
      while (end > 0 && (static_cast<unsigned char>(out[end]) & 0xC0) == 0x80) --end;  // not in a utf-8 sequence
      return out.substr(0, end) + "...";
    }  // one_line

    // the span of a range. a name in a macro argument gets the position of the argument in the source.
    // a range on more than one line gets the length of its first token
    [[nodiscard]] inline Span span_of(const clang::SourceRange _range, const clang::ASTContext& _ctx) {
      const clang::SourceManager& sm = _ctx.getSourceManager();
      const clang::SourceLocation b  = sm.getFileLoc(_range.getBegin());
      const clang::SourceLocation e  = sm.getFileLoc(_range.getEnd());
      uint32_t len                   = clang::Lexer::MeasureTokenLength(b, sm, _ctx.getLangOpts());
      if (sm.getFileID(b) == sm.getFileID(e) && sm.getExpansionLineNumber(b) == sm.getExpansionLineNumber(e)) {
        const uint32_t end = sm.getFileOffset(e) + clang::Lexer::MeasureTokenLength(e, sm, _ctx.getLangOpts());
        if (end > sm.getFileOffset(b)) len = end - sm.getFileOffset(b);
      }
      return Span{b, len};
    }  // span_of

    // the line, the column and the length of a span. lines and columns start at 1. columns are utf-8 bytes
    [[nodiscard]] inline JsonObject span_to_json(const Span& _span, const clang::SourceManager& _sm) {
      return JsonObject{{"line", int64_t(_sm.getExpansionLineNumber(_span.loc_))},
                        {"col", int64_t(_sm.getExpansionColumnNumber(_span.loc_))},
                        {"len", int64_t(_span.len_)}};
    }  // span_to_json

    // one element of a cfg block: a statement, or an implicit action such as a destructor call
    [[nodiscard]] inline Json element_to_json(const clang::CFGElement& _el, const clang::ASTContext& _ctx) {
      const clang::SourceManager& sm = _ctx.getSourceManager();
      if (const auto s = _el.getAs<clang::CFGStmt>())
        return JsonObject{{"kind", "stmt"},
                          {"stmt", s->getStmt()->getStmtClassName()},
                          {"range", range_to_json(sm, s->getStmt()->getSourceRange())}};
      if (const auto d = _el.getAs<clang::CFGAutomaticObjDtor>())
        return JsonObject{{"kind", "dtor"},
                          {"var", d->getVarDecl()->getNameAsString()},
                          {"type", d->getVarDecl()->getType().getAsString()},
                          {"at", loc_to_json(sm, d->getTriggerStmt()->getEndLoc())}};
      if (const auto t = _el.getAs<clang::CFGTemporaryDtor>())
        return JsonObject{{"kind", "tempDtor"},
                          {"type", t->getBindTemporaryExpr()->getType().getAsString()},
                          {"at", loc_to_json(sm, t->getBindTemporaryExpr()->getBeginLoc())}};
      if (const auto l = _el.getAs<clang::CFGLifetimeEnds>())
        return JsonObject{{"kind", "lifetimeEnds"}, {"var", l->getVarDecl()->getNameAsString()}};
      if (const auto b = _el.getAs<clang::CFGScopeBegin>())
        return JsonObject{{"kind", "scopeBegin"}, {"var", b->getVarDecl()->getNameAsString()}};
      if (const auto e = _el.getAs<clang::CFGScopeEnd>())
        return JsonObject{{"kind", "scopeEnd"}, {"var", e->getVarDecl()->getNameAsString()}};
      return JsonObject{{"kind", "other"}, {"elementKind", int64_t(_el.getKind())}};
    }  // element_to_json

    // true if the name of the function is in the list. an item with "::" is a qualified name
    [[nodiscard]] inline bool name_in(const clang::FunctionDecl* _fn, const std::vector<std::string>& _names) {
      if (!_fn || !_fn->getIdentifier()) return false;
      for (std::string_view n : _names) {
        if (n.starts_with("::")) n.remove_prefix(2);
        const bool isQualified = n.find("::") != std::string_view::npos;
        if (isQualified ? _fn->getQualifiedNameAsString() == n : _fn->getName() == llvm::StringRef(n.data(), n.size()))
          return true;
      }
      return false;
    }  // name_in

    // finds the range for loops on a dependent range. in a template, clang gives such a loop no begin, no end, no
    // condition and no increment
    class DependentRangeFinder : public clang::RecursiveASTVisitor<DependentRangeFinder> {
     public:
      std::vector<clang::CXXForRangeStmt*> out_;

      bool VisitCXXForRangeStmt(clang::CXXForRangeStmt* _s) {
        if (!_s->getBeginStmt() || !_s->getEndStmt() || !_s->getCond() || !_s->getInc()) out_.push_back(_s);
        return true;
      }
    };  // DependentRangeFinder
  }  // namespace Detail

  // limits the traversal of the ast to some declarations while it lives, for example to the function of an analysis.
  // the matchers of clang ask for the parents of nodes, and the first request builds the parent map of the traversal
  // scope. the default scope is the full translation unit with all headers, and its parent map takes up to seconds
  class TraversalScope {
    clang::ASTContext& ctx_;
    std::vector<clang::Decl*> old_;

   public:
    TraversalScope(clang::ASTContext& _ctx, const std::vector<const clang::FunctionDecl*>& _fns)
        : ctx_(_ctx), old_(_ctx.getTraversalScope()) {
      std::vector<clang::Decl*> scope;
      scope.reserve(_fns.size());
      for (const clang::FunctionDecl* f : _fns) scope.push_back(const_cast<clang::FunctionDecl*>(f));
      ctx_.setTraversalScope(scope);
    }

    TraversalScope(const TraversalScope&)            = delete;
    TraversalScope& operator=(const TraversalScope&) = delete;

    ~TraversalScope() { ctx_.setTraversalScope(old_); }
  };  // TraversalScope

  // builds the cfg of a body. the cfg builder of clang stops at a range for loop on a dependent range, so such a loop
  // gets placeholders while clang builds the cfg: two variables with no name for the begin and the end, and two
  // references to the range variable of the loop for the condition and the increment. the placeholders contain no
  // variable of the user. a reference of a dependent type has no known value, so the loop can end
  [[nodiscard]] inline std::unique_ptr<clang::CFG> build_cfg(const clang::Decl* _decl, clang::Stmt* _body,
                                                             clang::ASTContext& _ctx,
                                                             const clang::CFG::BuildOptions& _opts) {
    if (!_body) return nullptr;
    Detail::DependentRangeFinder finder;
    finder.TraverseStmt(_body);

    struct Saved {
      clang::CXXForRangeStmt* loop_ = nullptr;
      clang::Stmt* begin_           = nullptr;
      clang::Stmt* end_             = nullptr;
      clang::Expr* cond_            = nullptr;
      clang::Expr* inc_             = nullptr;
    };  // Saved
    std::vector<Saved> saved;
    for (clang::CXXForRangeStmt* s : finder.out_) {
      clang::DeclStmt* range_stmt = s->getRangeStmt();
      auto* range = range_stmt ? llvm::dyn_cast_or_null<clang::VarDecl>(range_stmt->getSingleDecl()) : nullptr;
      if (!range) continue;
      const clang::SourceLocation loc = s->getColonLoc();
      const auto placeholder_ref      = [&]() -> clang::Expr* {
        return clang::DeclRefExpr::Create(_ctx, clang::NestedNameSpecifierLoc(), clang::SourceLocation(), range, false,
                                               loc, range->getType().getNonReferenceType(), clang::VK_LValue);
      };
      const auto placeholder_decl = [&]() -> clang::Stmt* {
        auto* v = clang::VarDecl::Create(_ctx, range->getDeclContext(), loc, loc, nullptr, _ctx.IntTy,
                                         _ctx.getTrivialTypeSourceInfo(_ctx.IntTy, loc), clang::SC_None);
        v->setImplicit();
        return new (_ctx) clang::DeclStmt(clang::DeclGroupRef(v), loc, loc);
      };

      saved.push_back(Saved{s, s->getBeginStmt(), s->getEndStmt(), s->getCond(), s->getInc()});
      if (!s->getBeginStmt()) s->setBeginStmt(placeholder_decl());
      if (!s->getEndStmt()) s->setEndStmt(placeholder_decl());
      if (!s->getCond()) s->setCond(placeholder_ref());
      if (!s->getInc()) s->setInc(placeholder_ref());
    }

    std::unique_ptr<clang::CFG> out = clang::CFG::buildCFG(_decl, _body, &_ctx, _opts);

    // the ast gets its nodes back. the cfg keeps the placeholders, and the context keeps their memory
    for (const Saved& v : saved) {
      v.loop_->setBeginStmt(v.begin_);
      v.loop_->setEndStmt(v.end_);
      v.loop_->setCond(v.cond_);
      v.loop_->setInc(v.inc_);
    }
    return out;
  }  // build_cfg

  // builds the cfg of a function with implicit destructors, temporaries, lifetimes and scopes
  [[nodiscard]] inline Json cfg_to_json(const clang::FunctionDecl& _fn, clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();

    clang::CFG::BuildOptions opts;
    opts.AddImplicitDtors                 = true;
    opts.AddTemporaryDtors                = true;
    opts.AddInitializers                  = true;
    opts.AddLifetime                      = true;
    opts.AddScopes                        = true;
    const std::unique_ptr<clang::CFG> cfg = build_cfg(&_fn, _fn.getBody(), _ctx, opts);
    if (!cfg) return nullptr;

    JsonArray blocks;
    for (const clang::CFGBlock* block : *cfg) {
      JsonArray elements;
      for (const clang::CFGElement& el : *block) elements.push_back(Detail::element_to_json(el, _ctx));

      // the first successor of a two-way branch is the true branch
      const clang::Stmt* term = block->getTerminatorStmt();
      const bool is_branch    = term && block->succ_size() == 2 && !llvm::isa<clang::SwitchStmt>(term);
      JsonArray succs;
      uint32_t idx = 0;
      for (const clang::CFGBlock::AdjacentBlock& adj : block->succs()) {
        // an unreachable edge keeps its target only in the second pointer
        const clang::CFGBlock* to =
            adj.getReachableBlock() ? adj.getReachableBlock() : adj.getPossiblyUnreachableBlock();
        std::string label = is_branch ? (idx == 0 ? "true" : "false") : "";
        if (to && to->getLabel()) {
          if (const auto* c = llvm::dyn_cast<clang::CaseStmt>(to->getLabel()))
            label = "case " + Detail::source_text(_ctx, c->getLHS()->getSourceRange());
          else if (llvm::isa<clang::DefaultStmt>(to->getLabel()))
            label = "default";
        }
        succs.push_back(JsonObject{{"block", to ? Json(int64_t(to->getBlockID())) : Json(nullptr)},
                                   {"label", label},
                                   {"reachable", adj.getReachableBlock() != nullptr}});
        ++idx;
      }

      JsonObject b{
          {"id", int64_t(block->getBlockID())}, {"elements", std::move(elements)}, {"succs", std::move(succs)}};
      if (block == &cfg->getEntry()) b["label"] = "entry";
      if (block == &cfg->getExit()) b["label"] = "exit";
      if (term) {
        JsonObject t{{"stmt", term->getStmtClassName()}, {"range", Detail::range_to_json(sm, term->getSourceRange())}};
        if (const clang::Stmt* cond = block->getTerminatorCondition())
          t["cond"] = Detail::source_text(_ctx, cond->getSourceRange());
        b["terminator"] = std::move(t);
      }
      blocks.push_back(std::move(b));
    }

    return JsonObject{{"entry", int64_t(cfg->getEntry().getBlockID())},
                      {"exit", int64_t(cfg->getExit().getBlockID())},
                      {"blocks", std::move(blocks)}};
  }  // cfg_to_json

  // runs the unchecked optional access model of the clang dataflow framework on one function
  [[nodiscard]] inline std::expected<Json, std::string> optional_access_to_json(const clang::FunctionDecl& _fn,
                                                                                clang::ASTContext& _ctx) {
    using namespace clang::dataflow;

    const TraversalScope scope(_ctx, {&_fn});
    UncheckedOptionalAccessDiagnoser diagnoser;
    auto res = diagnoseFunction<UncheckedOptionalAccessModel, UncheckedOptionalAccessDiagnostic>(_fn, _ctx, diagnoser);
    if (!res) return std::unexpected(llvm::toString(res.takeError()));

    JsonArray out;
    for (const UncheckedOptionalAccessDiagnostic& d : *res) {
      const clang::SourceRange range = d.Range.getAsRange();
      out.push_back(JsonObject{{"range", Detail::range_to_json(_ctx.getSourceManager(), range)},
                               {"text", Detail::source_text(_ctx, range)}});
    }
    return Json(std::move(out));
  }  // optional_access_to_json

  //----------------------------------
  // Functions

  namespace Detail {
    // collects the function definitions under a declaration of a file. _isIn tells if a location is in the file
    template <class IsIn>
    inline void collect_functions(const clang::Decl* _decl, const IsIn& _isIn,
                                  std::vector<const clang::FunctionDecl*>& _out) {
      const clang::Decl* d = _decl;
      if (const auto* t = llvm::dyn_cast<clang::FunctionTemplateDecl>(d)) d = t->getTemplatedDecl();
      if (const auto* t = llvm::dyn_cast<clang::ClassTemplateDecl>(d)) d = t->getTemplatedDecl();

      // an instantiation of a template is also a top-level declaration of the ast unit, with the locations of the
      // template. the lenses analyze the template
      if (const auto* f = llvm::dyn_cast<clang::FunctionDecl>(d)) {
        if (f->doesThisDeclarationHaveABody() && !f->isImplicit() && !f->isTemplateInstantiation() &&
            _isIn(f->getLocation()))
          _out.push_back(f);
        return;
      }

      // a namespace or a class that starts in a different file has no function of the file. each block of a
      // namespace is a declaration of its own
      if (!_isIn(d->getLocation())) return;
      if (const auto* dc = llvm::dyn_cast<clang::DeclContext>(d))
        for (const clang::Decl* child : dc->decls()) collect_functions(child, _isIn, _out);
    }  // collect_functions

    // a test for the locations of the main file
    [[nodiscard]] inline auto main_file_test(const clang::SourceManager& _sm) {
      return [&_sm](const clang::SourceLocation _loc) { return _sm.isInMainFile(_sm.getExpansionLoc(_loc)); };
    }  // main_file_test

    // a test for the locations of a different file of the translation unit, for example a header. the test compares the
    // identity of the files
    [[nodiscard]] inline auto file_test(const clang::SourceManager& _sm, const std::string& _file) {
      const clang::OptionalFileEntryRef target = _sm.getFileManager().getOptionalFileRef(_file);
      auto cache                               = std::make_shared<llvm::DenseMap<clang::FileID, bool>>();
      return [&_sm, target, cache](const clang::SourceLocation _loc) {
        if (!target) return false;
        const clang::FileID id = _sm.getFileID(_sm.getExpansionLoc(_loc));
        const auto [it, isNew] = cache->try_emplace(id, false);
        if (isNew) {
          const clang::OptionalFileEntryRef entry = _sm.getFileEntryRefForID(id);
          it->second                              = entry && entry->getUniqueID() == target->getUniqueID();
        }
        return it->second;
      };
    }  // file_test
  }  // namespace Detail

  // the function definitions of the main file. no lambdas, no template instantiations
  [[nodiscard]] inline std::vector<const clang::FunctionDecl*> main_file_functions(clang::ASTUnit& _ast) {
    std::vector<const clang::FunctionDecl*> out;
    const auto isIn = Detail::main_file_test(_ast.getSourceManager());
    for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it) Detail::collect_functions(*it, isIn, out);
    return out;
  }  // main_file_functions

  // the function definitions of a different file of the translation unit, for example a header in the unit of a source
  // file that includes it. the declarations of the preamble are not top-level declarations of the ast unit, so the
  // search starts at the translation unit
  [[nodiscard]] inline std::vector<const clang::FunctionDecl*> file_functions(clang::ASTUnit& _ast,
                                                                              const std::string& _file) {
    std::vector<const clang::FunctionDecl*> out;
    const auto isIn = Detail::file_test(_ast.getSourceManager(), _file);
    for (const clang::Decl* d : _ast.getASTContext().getTranslationUnitDecl()->decls())
      Detail::collect_functions(d, isIn, out);
    return out;
  }  // file_functions

  // the instantiations of the templates of a file by the canonical declaration of the template function
  using Instantiations = std::unordered_map<const clang::FunctionDecl*, std::vector<const clang::FunctionDecl*>>;

  namespace Detail {
    // the instantiations with a body of the function templates and of the members of class templates of a file. clang
    // gives each instantiation of a function body to the ast unit as a top-level declaration
    template <class IsIn>
    [[nodiscard]] inline Instantiations instantiations(clang::ASTUnit& _ast, const IsIn& _isIn) {
      Instantiations out;
      std::unordered_set<const clang::FunctionDecl*> seen;
      for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it) {
        const auto* f = llvm::dyn_cast<clang::FunctionDecl>(*it);
        if (!f || !f->isTemplateInstantiation() || f->isImplicit() || !f->doesThisDeclarationHaveABody() ||
            !seen.insert(f).second)
          continue;
        const clang::FunctionDecl* pattern = f->getTemplateInstantiationPattern();
        if (pattern && _isIn(pattern->getLocation())) out[pattern->getCanonicalDecl()].push_back(f);
      }
      return out;
    }  // instantiations
  }  // namespace Detail

  [[nodiscard]] inline Instantiations main_file_instantiations(clang::ASTUnit& _ast) {
    return Detail::instantiations(_ast, Detail::main_file_test(_ast.getSourceManager()));
  }  // main_file_instantiations

  // the instantiations of the templates of a different file of the translation unit, for example a header. the
  // instantiations in the code of the main file count
  [[nodiscard]] inline Instantiations file_instantiations(clang::ASTUnit& _ast, const std::string& _file) {
    return Detail::instantiations(_ast, Detail::file_test(_ast.getSourceManager(), _file));
  }  // file_instantiations

  // the innermost function that contains a position. _line and _col start at 1
  [[nodiscard]] inline const clang::FunctionDecl* function_at(const std::vector<const clang::FunctionDecl*>& _fns,
                                                              const clang::SourceManager& _sm, const uint32_t _line,
                                                              const uint32_t _col) {
    const auto key = [&](const clang::SourceLocation _loc) -> uint64_t {
      const clang::SourceLocation exp = _sm.getExpansionLoc(_loc);
      return (uint64_t(_sm.getExpansionLineNumber(exp)) << 32) | _sm.getExpansionColumnNumber(exp);
    };

    const uint64_t pos             = (uint64_t(_line) << 32) | _col;
    const clang::FunctionDecl* out = nullptr;
    uint64_t best                  = UINT64_MAX;
    for (const clang::FunctionDecl* f : _fns) {
      const uint64_t begin = key(f->getSourceRange().getBegin());
      const uint64_t end   = key(f->getSourceRange().getEnd());
      if (pos < begin || pos > end || end - begin >= best) continue;
      best = end - begin;
      out  = f;
    }
    return out;
  }  // function_at

  // a function of the main file by name. _name can be qualified. overloads have the same name, so a line from 1 selects
  // the overload that contains the line, else the overload that starts nearest to the line. with no line, the first
  [[nodiscard]] inline const clang::FunctionDecl* function_by_name(const std::vector<const clang::FunctionDecl*>& _fns,
                                                                   const std::string& _name,
                                                                   const clang::SourceManager& _sm,
                                                                   const std::optional<uint32_t> _line = std::nullopt) {
    const clang::FunctionDecl* out = nullptr;
    uint32_t best                  = UINT32_MAX;
    for (const clang::FunctionDecl* f : _fns) {
      if (f->getQualifiedNameAsString() != _name && f->getNameAsString() != _name) continue;
      if (!_line) return f;
      const uint32_t first = _sm.getExpansionLineNumber(_sm.getExpansionLoc(f->getSourceRange().getBegin()));
      const uint32_t last  = _sm.getExpansionLineNumber(_sm.getExpansionLoc(f->getSourceRange().getEnd()));
      const uint32_t dist  = *_line < first ? first - *_line : *_line > last ? *_line - last : 0;
      if (dist < best) {
        best = dist;
        out  = f;
      }
    }
    return out;
  }  // function_by_name

  // the text of the macro call that makes a function, if ## in the macro makes the name of the function or of its
  // class. for example TEST_CASE("split") of catch2 for the function CATCH2_INTERNAL_TEST_0, or TEST(Pool, Post) of
  // googletest for Pool_Post_Test::TestBody. a name in the body of a macro, for example tr of Q_OBJECT, stays
  [[nodiscard]] inline std::optional<std::string> macro_call_text(const clang::FunctionDecl& _fn) {
    const clang::ASTContext& ctx   = _fn.getASTContext();
    const clang::SourceManager& sm = ctx.getSourceManager();
    const auto isPasted            = [&](const clang::SourceLocation _loc) {
      return _loc.isMacroID() && sm.isWrittenInScratchSpace(sm.getSpellingLoc(_loc));
    };
    const auto* parent = llvm::dyn_cast<clang::CXXRecordDecl>(_fn.getDeclContext());
    if (!isPasted(_fn.getLocation()) && !(parent && !parent->isLambda() && isPasted(parent->getLocation())))
      return std::nullopt;

    // the text of the outermost macro call, on one line
    const clang::CharSourceRange range = sm.getExpansionRange(_fn.getLocation());
    const llvm::StringRef raw          = clang::Lexer::getSourceText(range, sm, ctx.getLangOpts());
    std::string out;
    for (const char c : raw) {
      const bool isSpace = c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\\';
      if (!isSpace)
        out += c;
      else if (!out.empty() && out.back() != ' ')
        out += ' ';
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    if (out.empty()) return std::nullopt;

    constexpr size_t max_size = 100;
    if (out.size() > max_size) out = out.substr(0, max_size - 3) + "...";
    return out;
  }  // macro_call_text

  [[nodiscard]] inline JsonObject function_to_json(const clang::FunctionDecl& _fn, const clang::SourceManager& _sm) {
    const char* kind = "function";
    if (llvm::isa<clang::CXXConstructorDecl>(_fn))
      kind = "constructor";
    else if (llvm::isa<clang::CXXDestructorDecl>(_fn))
      kind = "destructor";
    else if (llvm::isa<clang::CXXMethodDecl>(_fn))
      kind = "method";

    JsonObject out{{"name", _fn.getNameAsString()},
                   {"qualifiedName", _fn.getQualifiedNameAsString()},
                   {"kind", kind},
                   {"range", Detail::range_to_json(_sm, _fn.getSourceRange())},
                   {"nameAt", Detail::loc_to_json(_sm, _fn.getLocation())}};
    if (const clang::Stmt* body = _fn.getBody()) out["body"] = Detail::range_to_json(_sm, body->getSourceRange());
    if (std::optional<std::string> call = macro_call_text(_fn)) out["macroCall"] = std::move(*call);
    return out;
  }  // function_to_json

}  // namespace DataFlow
