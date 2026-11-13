#pragma once

#include <dataflow/callgraph.hpp>
#include <dataflow/member.hpp>

/*
  The facts of a line, for a hook in the code:
    > the innermost function that contains the line, or no function
    > the statements around the line, from the outside in: the loops with isOpenLoop, the decisions (if, switch and the
      conditional operator) with the branch of the line, try, catch, and the lambdas. a statement that starts on the
      line is not around the line, because code at the start of the line runs before the statement
    > the mutexes that the code holds at the start of the line
  The server adds the reach of the function from the call graph: the callers and the frame path.
*/

namespace DataFlow {

  // the bytes of a text of a statement around a line
  inline constexpr size_t place_max_text = 100;

  // a statement around a line
  struct PlaceScope {
    std::string kind_;    // for, while, do, if, switch, conditional, try, catch or lambda
    uint32_t first_ = 0;  // the lines of the statement
    uint32_t last_  = 0;
    std::string text_;    // the condition, the loop variable and the range, the exception or the captures
    std::string branch_;  // a decision: then, else, condition, true, false, or the case labels of a switch
    bool isOpenLoop_    = false;
    bool isSynchronous_ = false;  // a lambda that the call runs before it returns
  };  // PlaceScope

  struct Place {
    const clang::FunctionDecl* fn_ = nullptr;  // null if no function contains the line
    bool isInBody_                 = false;    // false for a line of the head of the function, for example a parameter
    std::vector<PlaceScope> around_;           // from the outside in
    std::vector<std::string> locks_;           // the mutexes that the code holds at the start of the line
  };  // Place

  namespace Detail {
    // the first and the last line of a statement in the main file. nullopt for a statement in a different file or with
    // no location
    [[nodiscard]] inline std::optional<std::pair<uint32_t, uint32_t>> main_lines_of(const clang::Stmt* _s,
                                                                                    const clang::SourceManager& _sm) {
      if (!_s || _s->getBeginLoc().isInvalid() || _s->getEndLoc().isInvalid()) return std::nullopt;
      const clang::CharSourceRange r = _sm.getExpansionRange(_s->getSourceRange());
      if (!_sm.isInMainFile(r.getBegin())) return std::nullopt;
      const uint32_t first = _sm.getExpansionLineNumber(r.getBegin());
      return std::pair(first, std::max(first, _sm.getExpansionLineNumber(r.getEnd())));
    }  // main_lines_of

    // the innermost function whose lines contain a line
    [[nodiscard]] inline const clang::FunctionDecl* function_on_line(
        const std::vector<const clang::FunctionDecl*>& _fns, const clang::SourceManager& _sm, const uint32_t _line) {
      const clang::FunctionDecl* out = nullptr;
      uint32_t best                  = UINT32_MAX;
      for (const clang::FunctionDecl* f : _fns) {
        const clang::CharSourceRange r = _sm.getExpansionRange(f->getSourceRange());
        const uint32_t first           = _sm.getExpansionLineNumber(r.getBegin());
        const uint32_t last            = _sm.getExpansionLineNumber(r.getEnd());
        if (_line < first || _line > last || last - first >= best) continue;
        best = last - first;
        out  = f;
      }
      return out;
    }  // function_on_line

    // the case labels of the group of a switch with the line: the last group that starts on the line or before it
    [[nodiscard]] inline std::string case_labels(const clang::SwitchStmt& _s, const uint32_t _line,
                                                 const clang::ASTContext& _ctx) {
      const clang::SwitchCase* group = nullptr;
      if (const auto* body = llvm::dyn_cast_or_null<clang::CompoundStmt>(_s.getBody())) {
        for (const clang::Stmt* s : body->body()) {
          const auto* c    = llvm::dyn_cast<clang::SwitchCase>(s);
          const auto lines = main_lines_of(s, _ctx.getSourceManager());
          if (c && lines && lines->first <= _line) group = c;
        }
      } else {
        group = llvm::dyn_cast_or_null<clang::SwitchCase>(_s.getBody());
      }

      // the labels of a group are nested: case A: case B: is a case A with the sub-statement case B
      std::string out;
      const clang::Stmt* s = group;
      while (const auto* c = llvm::dyn_cast_or_null<clang::SwitchCase>(s)) {
        std::string label = "default";
        if (const auto* cs = llvm::dyn_cast<clang::CaseStmt>(c)) {
          label = "case " + short_text(_ctx, cs->getLHS()->getSourceRange(), place_max_text);
          if (const clang::Expr* rhs = cs->getRHS()) label += " ... " + short_text(_ctx, rhs->getSourceRange());
        }
        out += out.empty() ? label : ", " + label;
        s = c->getSubStmt();
      }
      return one_line(out, place_max_text);
    }  // case_labels

    // the statement around a line for a parent on the way up from the line, with the child on the way. nullopt if the
    // parent is not a statement of a place, or if the child is not a part that has the line in it, for example the
    // init of a for
    [[nodiscard]] inline std::optional<PlaceScope> place_scope(const clang::Stmt* _parent, const clang::Stmt* _child,
                                                               const uint32_t _line, const clang::ParentMap& _pm,
                                                               const clang::ASTContext& _ctx) {
      PlaceScope out;
      const auto loop = [&](const char* _kind) {
        out.kind_       = _kind;
        out.text_       = condition_text(_parent, _ctx, place_max_text);
        out.isOpenLoop_ = is_open_loop(*_parent);
      };
      if (const auto* s = llvm::dyn_cast<clang::ForStmt>(_parent)) {
        if (_child != s->getBody() && _child != s->getCond() && _child != s->getInc() &&
            _child != s->getConditionVariableDeclStmt())
          return std::nullopt;
        loop("for");
      } else if (const auto* s = llvm::dyn_cast<clang::CXXForRangeStmt>(_parent)) {
        if (_child != s->getBody() && _child != s->getLoopVarStmt()) return std::nullopt;
        loop("for");
      } else if (llvm::isa<clang::WhileStmt>(_parent)) {
        loop("while");
      } else if (llvm::isa<clang::DoStmt>(_parent)) {
        loop("do");
      } else if (const auto* s = llvm::dyn_cast<clang::IfStmt>(_parent)) {
        out.kind_   = "if";
        out.text_   = condition_text(s, _ctx, place_max_text);
        out.branch_ = _child == s->getThen() ? "then" : _child == s->getElse() ? "else" : "condition";
      } else if (const auto* s = llvm::dyn_cast<clang::SwitchStmt>(_parent)) {
        out.kind_   = "switch";
        out.text_   = condition_text(s, _ctx, place_max_text);
        out.branch_ = _child == s->getBody() ? case_labels(*s, _line, _ctx) : std::string("condition");
      } else if (const auto* s = llvm::dyn_cast<clang::AbstractConditionalOperator>(_parent)) {
        out.kind_   = "conditional";
        out.text_   = condition_text(s, _ctx, place_max_text);
        out.branch_ = _child == s->getTrueExpr() ? "true" : _child == s->getFalseExpr() ? "false" : "condition";
      } else if (const auto* s = llvm::dyn_cast<clang::CXXTryStmt>(_parent)) {
        if (_child != s->getTryBlock()) return std::nullopt;  // a handler is a catch
        out.kind_ = "try";
      } else if (const auto* s = llvm::dyn_cast<clang::CXXCatchStmt>(_parent)) {
        const clang::VarDecl* v = s->getExceptionDecl();
        out.kind_               = "catch";
        out.text_               = v ? short_text(_ctx, v->getSourceRange(), place_max_text) : std::string("...");
      } else if (const auto* s = llvm::dyn_cast<clang::LambdaExpr>(_parent)) {
        if (_child != s->getBody()) return std::nullopt;
        out.kind_ = "lambda";
        out.text_ = short_text(_ctx, {s->getBeginLoc(), s->getBody()->getBeginLoc()}, place_max_text);
        if (out.text_.ends_with("{")) out.text_.pop_back();
        while (!out.text_.empty() && out.text_.back() == ' ') out.text_.pop_back();
        out.isSynchronous_ = is_synchronous(s, _pm);
      } else {
        return std::nullopt;
      }
      return out;
    }  // place_scope
  }  // namespace Detail

  // the facts of a line of the main file. _line starts at 1
  [[nodiscard]] inline Place build_place(clang::ASTUnit& _ast, const uint32_t _line) {
    Place out;
    const clang::ASTContext& ctx   = _ast.getASTContext();
    const clang::SourceManager& sm = _ast.getSourceManager();
    out.fn_                        = Detail::function_on_line(main_file_functions(_ast), sm, _line);
    const auto hasLine             = [&](const clang::Stmt* _s) {
      const auto lines = Detail::main_lines_of(_s, sm);
      return lines && lines->first <= _line && _line <= lines->second;
    };
    if (!out.fn_ || !hasLine(out.fn_->getBody())) return out;
    out.isInBody_         = true;

    // the innermost statement at the start of the line: down from the body, always into the first child with the line
    const clang::Stmt* at = out.fn_->getBody();
    while (true) {
      const auto children = at->children();
      const auto it       = llvm::find_if(children, hasLine);
      if (it == children.end()) break;
      at = *it;
    }

    // the statements around the line, from the outside in. a statement that starts on the line is not around it
    const clang::ParentMap pm(out.fn_->getBody());
    std::vector<const clang::Stmt*> chain{at};  // from the inside out
    for (const clang::Stmt* p = pm.getParent(at); p; p = pm.getParent(p)) chain.push_back(p);
    for (size_t i = chain.size() - 1; i > 0; --i) {
      const auto lines = Detail::main_lines_of(chain[i], sm);
      if (!lines || lines->first >= _line) continue;
      if (std::optional<PlaceScope> s = Detail::place_scope(chain[i], chain[i - 1], _line, pm, ctx)) {
        s->first_ = lines->first;
        s->last_  = lines->second;
        out.around_.push_back(std::move(*s));
      }
    }

    // the locks at the start of the line. a line between the statements of a block gets the locks before the next
    // statement, and a line after the last statement gets the locks at the end of the block
    const clang::Stmt* anchor = at;
    bool isAtEnd              = false;
    if (const auto* cs = llvm::dyn_cast<clang::CompoundStmt>(at)) {
      const auto body = cs->body();
      const auto next = llvm::find_if(body, [&](const clang::Stmt* _s) {
        const auto lines = Detail::main_lines_of(_s, sm);
        return lines && lines->first > _line;
      });
      if (next != body.end())
        anchor = *next;
      else
        isAtEnd = true;
    }
    out.locks_ = Detail::locks_at(anchor, pm, ctx, isAtEnd);
    return out;
  }  // build_place

  [[nodiscard]] inline JsonObject place_to_json(const Place& _p, const clang::SourceManager& _sm) {
    JsonArray around;
    for (const PlaceScope& s : _p.around_) {
      JsonObject o{{"kind", s.kind_}, {"first", int64_t(s.first_)}, {"last", int64_t(s.last_)}};
      if (!s.text_.empty()) o["text"] = s.text_;
      if (!s.branch_.empty()) o["branch"] = s.branch_;
      if (s.kind_ == "for" || s.kind_ == "while" || s.kind_ == "do") o["isOpenLoop"] = s.isOpenLoop_;
      if (s.kind_ == "lambda") o["isSynchronous"] = s.isSynchronous_;
      around.push_back(std::move(o));
    }
    return JsonObject{{"function", _p.fn_ ? Json(function_to_json(*_p.fn_, _sm)) : Json(nullptr)},
                      {"isInBody", _p.isInBody_},
                      {"around", std::move(around)},
                      {"locks", JsonArray(_p.locks_)}};
  }  // place_to_json

}  // namespace DataFlow
