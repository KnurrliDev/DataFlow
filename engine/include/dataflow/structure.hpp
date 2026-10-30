#pragma once

#include <dataflow/slice.hpp>
#include <dataflow/threads.hpp>

/*
  The structure of one function, for the tools of a language model:
    > statements: the statements of the body in sequence, with their first and last lines. an if gives a branch for
      each if, else if and else of its chain. a switch gives a branch for each group of case labels. a try gives a
      branch for the try block and for each catch. a block and a loop give the statements of their body
    > the items of a statement, also of the statements in it: the exits, the calls of the event functions, the thread
      starts and the calls of the functions of the main file. a return in a lambda is no exit. the items of a lambda
      count only if the call that gets the lambda runs it before it returns
    > accesses: each access of a variable, of a parameter, of a data member through this, and of a static or global
      variable, with its role. a path goes through the data members, for example charge.is_dirty. the object of a path
      goes through the local references, for example home_battery_ctl.operational_settings for settings
    > reaches: the lines of the reads that a write reaches over the cfg, from the reaching definitions of the slice. the
      function and each lambda have a cfg of their own. a write of a captured variable in a lambda has no lines. a path
      through an element or a call, and a path with more than 3 data members, get the lines of their container
  The extension puts the statements into blocks. The accesses give the data that goes into a block and out of it.
*/

namespace DataFlow {

  struct StructureOptions {
    std::vector<std::string> event_functions_;  // functions that send an event, for example of a state machine
    std::vector<std::string> async_functions_;  // functions that run a callable on a different thread
  };  // StructureOptions

  struct StructureExit {
    uint32_t line_ = 0;
    std::string kind_;  // return, break, continue, throw or goto
  };  // StructureExit

  struct StructureEvent {
    uint32_t line_ = 0;
    std::string name_;  // the first string literal argument, or empty
  };  // StructureEvent

  struct StructureThread {
    uint32_t line_ = 0;
    std::string via_;   // for example std::thread or tf::Executor::async
    std::string runs_;  // the function that the thread runs, or lambda
  };  // StructureThread

  struct StructureCall {
    uint32_t line_ = 0;
    std::string name_;
  };  // StructureCall

  struct StructureStmt;

  // a branch of an if chain, a group of case labels of a switch, or the try block or a catch of a try
  struct StructureBranch {
    uint32_t first_ = 0;
    uint32_t last_  = 0;
    std::string label_;
    std::vector<StructureStmt> statements_;
  };  // StructureBranch

  struct StructureStmt {
    uint32_t first_ = 0;
    uint32_t last_  = 0;
    std::string kind_;
    std::string text_;
    bool hasBranches_ = false;  // an if, a switch or a try
    bool hasBody_     = false;  // a block or a loop
    std::vector<StructureBranch> branches_;
    std::vector<StructureStmt> body_;
    std::vector<StructureExit> exits_;
    std::vector<StructureEvent> events_;
    std::vector<StructureThread> threads_;
    std::vector<StructureCall> calls_;
  };  // StructureStmt

  struct StructureAccess {
    uint32_t line_ = 0;
    uint32_t col_  = 0;
    std::string path_;         // the path of the source text, for example settings.meter_hold_time
    std::string object_;       // the path through the local references, if it is different. else empty
    std::string role_;         // read, write, readwrite or decl
    std::string scope_;        // local, param, member or global
    bool isInLambda_ = false;  // in the parameters or in the body of a lambda
    int32_t lambda_  = -1;     // the innermost lambda of the access, or -1. not in the json
    bool hasReaches_ = false;  // reaches_ is known
    std::vector<uint32_t> reaches_;  // the lines of the reads that the write reaches
  };  // StructureAccess

  struct StructureModel {
    std::vector<StructureStmt> statements_;
    std::vector<StructureAccess> accesses_;
  };  // StructureModel

  namespace Detail {
    inline constexpr size_t structure_max_text = 100;  // the bytes of a text or of a label

    // a text of a maximum of structure_max_text bytes. a longer text ends with "..."
    [[nodiscard]] inline std::string limited(std::string _text) {
      if (_text.size() <= structure_max_text) return _text;
      size_t n = structure_max_text - 3;
      while (n > 0 && (uint8_t(_text[n]) & 0xC0) == 0x80) --n;  // the start of a utf-8 character
      return _text.substr(0, n) + "...";
    }  // limited

    // the text of a path. an element at the end belongs to its container, so optimizers[0] is optimizers
    [[nodiscard]] inline std::string path_text(const ObjectPath& _p) {
      size_t n = _p.steps_.size();
      while (n > 0 && !_p.steps_[n - 1]) --n;
      std::string out = object_text(_p, n);
      if (out.empty() && _p.isThis_) out = "this";
      return out;
    }  // path_text

    [[nodiscard]] inline const char* structure_role(const AccessRole& _r) {
      if (_r.first == Role::WRITE) return _r.second ? "readwrite" : "write";
      if (_r.first == Role::MAY_WRITE) return "readwrite";
      if (_r.first == Role::DEF) return "decl";
      return "read";
    }  // structure_role

    // the nodes of a body for the structure. the scan goes into the bodies of the lambdas
    class StructureScanner : public clang::RecursiveASTVisitor<StructureScanner> {
     public:
      std::vector<const clang::Expr*> objects_;  // the expressions of objects. the builder keeps the outermost steps
      std::vector<const clang::Stmt*> exits_;
      std::vector<const clang::CallExpr*> calls_;
      std::vector<const clang::Expr*> starts_;  // the calls and constructions that can start a thread
      std::vector<const clang::VarDecl*> vars_;
      std::vector<const clang::BindingDecl*> bindings_;
      std::vector<const clang::LambdaExpr*> lambdas_;
      std::vector<const clang::CXXForRangeStmt*> ranges_;

      // an explicit capture by copy reads the variable when the lambda starts. a capture by reference does not use the
      // variable, and an implicit capture is the use in the body
      bool TraverseLambdaExpr(clang::LambdaExpr* _e) {
        lambdas_.push_back(_e);
        for (const auto [capture, init] : llvm::zip(_e->captures(), _e->capture_inits())) {
          if (!capture.isExplicit() || (capture.getCaptureKind() == clang::LCK_ByRef && !_e->isInitCapture(&capture)))
            continue;
          if (init && !TraverseStmt(init)) return false;
        }
        for (clang::ParmVarDecl* p : _e->getCallOperator()->parameters())
          if (!TraverseDecl(p)) return false;
        return TraverseStmt(_e->getBody());
      }  // TraverseLambdaExpr

      bool VisitStmt(clang::Stmt* _s) {
        if (llvm::isa<clang::ReturnStmt, clang::CoreturnStmt, clang::BreakStmt, clang::ContinueStmt, clang::GotoStmt,
                      clang::CXXThrowExpr>(_s))
          exits_.push_back(_s);
        return true;
      }  // VisitStmt

      bool VisitExpr(clang::Expr* _e) {
        if (llvm::isa<clang::DeclRefExpr, clang::MemberExpr, clang::ArraySubscriptExpr>(_e) || is_path_call(_e) ||
            dependent_field(llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(_e)))
          objects_.push_back(_e);
        if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_e); c && called_function(c)) calls_.push_back(c);
        if (llvm::isa<clang::CallExpr, clang::CXXConstructExpr>(_e)) starts_.push_back(_e);
        return true;
      }  // VisitExpr

      bool VisitVarDecl(clang::VarDecl* _d) {
        if (!_d->isImplicit() && !llvm::isa<clang::DecompositionDecl>(_d)) vars_.push_back(_d);
        return true;
      }  // VisitVarDecl

      bool VisitBindingDecl(clang::BindingDecl* _d) {
        bindings_.push_back(_d);
        return true;
      }  // VisitBindingDecl

      bool VisitCXXForRangeStmt(clang::CXXForRangeStmt* _s) {
        ranges_.push_back(_s);
        return true;
      }  // VisitCXXForRangeStmt
    };  // StructureScanner

    class StructureBuilder {
      // an exit, an event, a thread start or a call at a place of the body
      struct Item {
        enum class Kind { EXIT, EVENT, THREAD, CALL };
        Kind kind_       = Kind::EXIT;
        uint32_t offset_ = 0;
        uint32_t line_   = 0;
        std::string text_;                     // the kind of an exit, the name of an event or a function, or the via
        std::string runs_;                     // a thread start: the function that the thread runs
        const clang::Stmt* target_ = nullptr;  // a break or a continue: the loop or the switch that it leaves
        bool isInLambda_           = false;
        bool isDeferred_           = false;  // in a lambda that its call does not run before the call returns
      };  // Item

      // the loop variable of a range for loop -> the range
      using ranges_t = std::unordered_map<const clang::VarDecl*, const clang::Expr*>;

      clang::ASTContext& ctx_;
      const clang::SourceManager& sm_;
      const clang::FunctionDecl& fn_;
      const StructureOptions& opts_;
      MemberOptions memberOpts_;
      std::unique_ptr<clang::ParentMap> pm_;
      std::vector<Item> items_;
      // the offsets after the captures and at the end of each lambda
      std::vector<std::pair<uint32_t, uint32_t>> lambdas_;
      std::vector<const clang::LambdaExpr*> lambdaExprs_;  // the lambdas in the sequence of lambdas_

     public:
      StructureBuilder(const clang::FunctionDecl& _fn, clang::ASTContext& _ctx, const StructureOptions& _opts)
          : ctx_(_ctx), sm_(_ctx.getSourceManager()), fn_(_fn), opts_(_opts), memberOpts_{_opts.async_functions_} {
        memberOpts_.async_functions_.push_back("std::async");
      }

      [[nodiscard]] StructureModel run() {
        StructureModel out;
        clang::Stmt* body = fn_.getBody();
        if (!body) return out;
        pm_ = parents_of(fn_);
        StructureScanner scanner;
        scanner.TraverseStmt(body);
        for (const clang::LambdaExpr* l : scanner.lambdas_)
          lambdas_.emplace_back(offset_of(l->getIntroducerRange().getEnd()), offsets_of(l).second);
        lambdaExprs_ = scanner.lambdas_;
        add_items(scanner);
        const clang::Stmt* top = body;
        if (const auto* co = llvm::dyn_cast<clang::CoroutineBodyStmt>(top)) top = co->getBody();
        out.statements_ = statements_of(top);
        out.accesses_   = accesses_of(scanner);
        add_reaches(out.accesses_);
        return out;
      }  // run

     private:
      [[nodiscard]] uint32_t line_of(const clang::SourceLocation _loc) const {
        return sm_.getExpansionLineNumber(sm_.getExpansionLoc(_loc));
      }  // line_of

      [[nodiscard]] uint32_t offset_of(const clang::SourceLocation _loc) const {
        return sm_.getFileOffset(sm_.getExpansionLoc(_loc));
      }  // offset_of

      // the offsets of the first and of the last token of a statement
      [[nodiscard]] std::pair<uint32_t, uint32_t> offsets_of(const clang::Stmt* _s) const {
        const clang::CharSourceRange r = sm_.getExpansionRange(_s->getSourceRange());
        return {sm_.getFileOffset(r.getBegin()), sm_.getFileOffset(r.getEnd())};
      }  // offsets_of

      // the text of the line of a statement, from the start of the statement
      [[nodiscard]] std::string line_text(const clang::SourceLocation _loc) const {
        const clang::SourceLocation at = sm_.getExpansionLoc(_loc);
        bool isInvalid                 = false;
        const llvm::StringRef buffer   = sm_.getBufferData(sm_.getFileID(at), &isInvalid);
        if (isInvalid) return {};
        const size_t from = sm_.getFileOffset(at);
        const size_t to   = std::min(buffer.find_first_of("\r\n", from), buffer.size());
        return limited(buffer.slice(from, to).trim().str());
      }  // line_text

      [[nodiscard]] bool is_in_lambda(const uint32_t _offset) const {
        return std::ranges::any_of(lambdas_, [&](const std::pair<uint32_t, uint32_t>& _l) {
          return _l.first < _offset && _offset <= _l.second;
        });
      }  // is_in_lambda

      // the innermost lambda at an offset: its index in lambdas_, or -1
      [[nodiscard]] int32_t lambda_at(const uint32_t _offset) const {
        int32_t out = -1;
        for (size_t i = 0; i < lambdas_.size(); ++i) {
          const auto [first, last] = lambdas_[i];
          if (first < _offset && _offset <= last &&
              (out < 0 || last - first < lambdas_[out].second - lambdas_[out].first))
            out = int32_t(i);
        }
        return out;
      }  // lambda_at

      //----------------------------------
      // Items

      // a function of the main file with a body. a lambda is a part of its function
      [[nodiscard]] bool is_main_file_function(const clang::FunctionDecl* _fn) const {
        const clang::FunctionDecl* def = nullptr;
        if (!_fn || _fn->isImplicit() || !_fn->isDefined(def) || !def) return false;
        if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(def); m && m->getParent()->isLambda()) return false;
        return sm_.isInMainFile(sm_.getExpansionLoc(def->getLocation()));
      }  // is_main_file_function

      // the loop or the switch that a break or a continue leaves
      [[nodiscard]] const clang::Stmt* target_of(const clang::Stmt* _s) const {
        const bool isBreak = llvm::isa<clang::BreakStmt>(_s);
        for (const clang::Stmt* p = pm_->getParent(_s); p; p = pm_->getParent(p)) {
          if (llvm::isa<clang::ForStmt, clang::WhileStmt, clang::DoStmt, clang::CXXForRangeStmt>(p)) return p;
          if (isBreak && llvm::isa<clang::SwitchStmt>(p)) return p;
          if (llvm::isa<clang::LambdaExpr>(p)) return nullptr;
        }
        return nullptr;
      }  // target_of

      // the lambda of an argument of a thread start, through conversions and a local variable. null for other arguments
      [[nodiscard]] static const clang::LambdaExpr* lambda_of(const clang::Expr* _arg) {
        const clang::Expr* e = _arg;
        for (int32_t i = 0; e && i < 8; ++i) {
          e = object_expr(e);
          if (const auto* l = llvm::dyn_cast<clang::LambdaExpr>(e)) return l;
          if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(e); c && c->getNumArgs() == 1) {
            e = c->getArg(0);
          } else if (const auto* f = llvm::dyn_cast<clang::CXXFunctionalCastExpr>(e)) {
            e = f->getSubExpr();
          } else if (const auto* r = llvm::dyn_cast<clang::DeclRefExpr>(e)) {
            const auto* v = llvm::dyn_cast<clang::VarDecl>(r->getDecl());
            if (!v || !v->isLocalVarDecl() || !v->getInit()) return nullptr;
            e = v->getInit();
          } else {
            return nullptr;
          }
        }
        return nullptr;
      }  // lambda_of

      // the first function of the user that a lambda calls, or lambda
      [[nodiscard]] std::string first_call_of(const clang::LambdaExpr* _l) const {
        CallFinder finder;
        finder.TraverseStmt(_l->getBody());
        for (const clang::CallExpr* c : finder.out_) {
          const clang::FunctionDecl* fn = called_function(c);
          if (fn && fn->getIdentifier() && !is_in_std(fn) && !sm_.isInSystemHeader(sm_.getFileLoc(fn->getLocation())))
            return fn->getNameAsString();
        }
        return "lambda";
      }  // first_call_of

      // the function that a thread start runs: a lambda, or a function as an argument
      [[nodiscard]] std::string runs_of(const clang::Expr* _start) const {
        std::vector<const clang::Expr*> args;
        if (const auto* c = llvm::dyn_cast<clang::CallExpr>(_start)) args.assign(c->arg_begin(), c->arg_end());
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(_start)) args.assign(c->arg_begin(), c->arg_end());
        for (const clang::Expr* a : args) {
          if (const clang::LambdaExpr* l = lambda_of(a)) return first_call_of(l);
          if (const clang::FunctionDecl* f = function_argument(a)) return f->getNameAsString();
        }
        return {};
      }  // runs_of

      // the place of an item, and the lambdas around it
      void set_place(Item& _item, const clang::Stmt* _s) const {
        _item.offset_            = offset_of(_s->getBeginLoc());
        _item.line_              = line_of(_s->getBeginLoc());
        const clang::Stmt* child = _s;
        for (const clang::Stmt* p = pm_->getParent(child); p; child = p, p = pm_->getParent(p)) {
          const auto* l = llvm::dyn_cast<clang::LambdaExpr>(p);
          if (!l || child != l->getBody()) continue;
          _item.isInLambda_ = true;
          if (!is_synchronous(l, *pm_)) _item.isDeferred_ = true;
        }
      }  // set_place

      void add_items(const StructureScanner& _scan) {
        for (const clang::Stmt* s : _scan.exits_) {
          Item item;
          item.kind_ = Item::Kind::EXIT;
          set_place(item, s);
          if (llvm::isa<clang::ReturnStmt, clang::CoreturnStmt>(s))
            item.text_ = "return";
          else if (llvm::isa<clang::BreakStmt>(s))
            item.text_ = "break";
          else if (llvm::isa<clang::ContinueStmt>(s))
            item.text_ = "continue";
          else if (llvm::isa<clang::GotoStmt>(s))
            item.text_ = "goto";
          else
            item.text_ = "throw";
          if (llvm::isa<clang::BreakStmt, clang::ContinueStmt>(s)) item.target_ = target_of(s);
          items_.push_back(std::move(item));
        }

        // a call of an event function is an event, not a call
        for (const clang::CallExpr* c : _scan.calls_) {
          const clang::FunctionDecl* fn = called_function(c);
          Item item;
          set_place(item, c);
          if (name_in(fn, opts_.event_functions_)) {
            item.kind_ = Item::Kind::EVENT;
            for (const clang::Expr* a : c->arguments())
              if (const clang::StringLiteral* lit = string_literal_of(a)) {
                if (lit->getCharByteWidth() == 1) item.text_ = lit->getString().str();
                break;
              }
            items_.push_back(std::move(item));
          } else if (start_name(c, memberOpts_).empty() && is_main_file_function(fn)) {
            item.kind_ = Item::Kind::CALL;
            item.text_ = fn->getNameAsString();
            items_.push_back(std::move(item));
          }
        }

        for (const clang::Expr* e : _scan.starts_) {
          std::string via = start_name(e, memberOpts_);
          if (via.empty()) continue;
          Item item;
          item.kind_ = Item::Kind::THREAD;
          set_place(item, e);
          item.text_ = std::move(via);
          item.runs_ = runs_of(e);
          items_.push_back(std::move(item));
        }
        std::ranges::stable_sort(items_, {}, &Item::offset_);
      }  // add_items

      // the items in a statement. a break or a continue is an exit only if it leaves the statement
      void add_statement_items(StructureStmt& _out, const clang::Stmt* _s) const {
        const auto [first, last] = offsets_of(_s);
        for (const Item& item : items_) {
          if (item.offset_ < first || item.offset_ > last) continue;
          switch (item.kind_) {
            case Item::Kind::EXIT: {
              if (item.isInLambda_) break;
              if (item.target_) {
                const auto [targetFirst, targetLast] = offsets_of(item.target_);
                if (targetFirst >= first && targetLast <= last) break;
              }
              _out.exits_.push_back({item.line_, item.text_});
              break;
            }
            case Item::Kind::EVENT:
              if (!item.isDeferred_) _out.events_.push_back({item.line_, item.text_});
              break;
            case Item::Kind::THREAD:
              if (!item.isDeferred_) _out.threads_.push_back({item.line_, item.text_, item.runs_});
              break;
            case Item::Kind::CALL: {
              const auto isSame = [&](const StructureCall& _c) { return _c.name_ == item.text_; };
              if (!item.isDeferred_ && std::ranges::none_of(_out.calls_, isSame))
                _out.calls_.push_back({item.line_, item.text_});
              break;
            }
          }
        }
      }  // add_statement_items

      //----------------------------------
      // Statements

      // the statements of a block, or one statement. an empty statement is not a part of the list
      [[nodiscard]] std::vector<StructureStmt> statements_of(const clang::Stmt* _s) const {
        std::vector<StructureStmt> out;
        if (!_s) return out;
        if (const auto* cs = llvm::dyn_cast<clang::CompoundStmt>(_s)) {
          for (const clang::Stmt* child : cs->body())
            if (!llvm::isa<clang::NullStmt>(child)) out.push_back(statement(child));
        } else if (!llvm::isa<clang::NullStmt>(_s)) {
          out.push_back(statement(_s));
        }
        return out;
      }  // statements_of

      // the last line of each branch: the line before the next branch. the last branch ends with the statement
      static void set_last_lines(std::vector<StructureBranch>& _branches, const uint32_t _last) {
        for (size_t i = 0; i < _branches.size(); ++i) {
          const uint32_t first = _branches[i].first_;
          if (i + 1 == _branches.size()) {
            _branches[i].last_ = std::max(first, _last);
          } else {
            const uint32_t next = _branches[i + 1].first_;
            _branches[i].last_  = next > first ? next - 1 : first;
          }
        }
      }  // set_last_lines

      // the condition of a decision, or the text of its line if it has no condition
      [[nodiscard]] std::string condition_or_line(const clang::Stmt* _s) const {
        std::string out = condition_text(_s, ctx_, structure_max_text);
        return out.empty() ? line_text(_s->getBeginLoc()) : out;
      }  // condition_or_line

      // the branches of an if chain. a branch after the first starts at the line of its else
      [[nodiscard]] std::vector<StructureBranch> if_branches(const clang::IfStmt* _s, const uint32_t _last) const {
        std::vector<StructureBranch> out;
        clang::SourceLocation at = _s->getBeginLoc();
        for (const clang::IfStmt* s = _s; s;) {
          out.push_back({line_of(at), 0, condition_or_line(s), statements_of(s->getThen())});
          const clang::Stmt* other = s->getElse();
          if (!other) break;
          at = s->getElseLoc();
          s  = llvm::dyn_cast<clang::IfStmt>(other);
          if (!s) out.push_back({line_of(at), 0, "else", statements_of(other)});
        }
        set_last_lines(out, _last);
        return out;
      }  // if_branches

      [[nodiscard]] std::string case_label(const clang::SwitchCase* _c) const {
        const auto* c = llvm::dyn_cast<clang::CaseStmt>(_c);
        if (!c) return "default";
        std::string out = "case " + short_text(ctx_, c->getLHS()->getSourceRange(), structure_max_text);
        if (const clang::Expr* rhs = c->getRHS())
          out += " ... " + short_text(ctx_, rhs->getSourceRange(), structure_max_text);
        return limited(std::move(out));
      }  // case_label

      // the groups of case labels of a switch, each with the statements after its labels
      [[nodiscard]] std::vector<StructureBranch> switch_branches(const clang::SwitchStmt* _s,
                                                                 const uint32_t _last) const {
        std::vector<StructureBranch> out;
        const auto* body = llvm::dyn_cast_or_null<clang::CompoundStmt>(_s->getBody());
        if (!body) return out;
        bool isOpen = false;  // the last group has labels, but no statement yet
        for (const clang::Stmt* child : body->body()) {
          const clang::Stmt* s = child;
          if (llvm::isa<clang::SwitchCase>(s)) {
            if (!isOpen) out.push_back({line_of(s->getBeginLoc()), 0, "", {}});
            isOpen = true;
            while (const auto* c = llvm::dyn_cast_or_null<clang::SwitchCase>(s)) {
              std::string& label = out.back().label_;
              label              = label.empty() ? case_label(c) : limited(label + ", " + case_label(c));
              s                  = c->getSubStmt();
            }
          }
          if (out.empty() || !s || llvm::isa<clang::NullStmt>(s)) continue;
          out.back().statements_.push_back(statement(s));
          isOpen = false;
        }
        set_last_lines(out, _last);
        return out;
      }  // switch_branches

      // the try block and the catch handlers of a try
      [[nodiscard]] std::vector<StructureBranch> try_branches(const clang::CXXTryStmt* _s, const uint32_t _last) const {
        std::vector<StructureBranch> out;
        out.push_back({line_of(_s->getBeginLoc()), 0, "try", statements_of(_s->getTryBlock())});
        for (uint32_t i = 0; i < _s->getNumHandlers(); ++i) {
          const clang::CXXCatchStmt* h = _s->getHandler(i);
          const clang::VarDecl* v      = h->getExceptionDecl();
          const std::string decl = v ? short_text(ctx_, v->getSourceRange(), structure_max_text) : std::string("...");
          out.push_back(
              {line_of(h->getCatchLoc()), 0, limited("catch (" + decl + ")"), statements_of(h->getHandlerBlock())});
        }
        set_last_lines(out, _last);
        return out;
      }  // try_branches

      [[nodiscard]] StructureStmt statement(const clang::Stmt* _s) const {
        StructureStmt out;
        out.first_           = line_of(_s->getBeginLoc());
        out.last_            = std::max(out.first_, line_of(sm_.getExpansionRange(_s->getSourceRange()).getEnd()));
        out.text_            = line_text(_s->getBeginLoc());

        // the kind of a labeled statement and of a statement with attributes is the kind of the statement in it
        const clang::Stmt* s = _s;
        while (true) {
          if (const auto* a = llvm::dyn_cast<clang::AttributedStmt>(s))
            s = a->getSubStmt();
          else if (const auto* l = llvm::dyn_cast<clang::LabelStmt>(s))
            s = l->getSubStmt();
          else
            break;
        }

        const auto set_body = [&](const char* _kind, const clang::Stmt* _body) {
          out.kind_    = _kind;
          out.hasBody_ = true;
          out.body_    = statements_of(_body);
        };
        if (const auto* i = llvm::dyn_cast<clang::IfStmt>(s)) {
          out.kind_        = "if";
          out.text_        = condition_or_line(i);
          out.hasBranches_ = true;
          out.branches_    = if_branches(i, out.last_);
        } else if (const auto* sw = llvm::dyn_cast<clang::SwitchStmt>(s)) {
          out.kind_        = "switch";
          out.text_        = condition_or_line(sw);
          out.hasBranches_ = true;
          out.branches_    = switch_branches(sw, out.last_);
        } else if (const auto* t = llvm::dyn_cast<clang::CXXTryStmt>(s)) {
          out.kind_        = "try";
          out.hasBranches_ = true;
          out.branches_    = try_branches(t, out.last_);
        } else if (const auto* f = llvm::dyn_cast<clang::ForStmt>(s)) {
          set_body("for", f->getBody());
          out.text_ = condition_or_line(f);
        } else if (const auto* r = llvm::dyn_cast<clang::CXXForRangeStmt>(s)) {
          set_body("for", r->getBody());
          out.text_ = condition_or_line(r);
        } else if (const auto* w = llvm::dyn_cast<clang::WhileStmt>(s)) {
          set_body("while", w->getBody());
          out.text_ = condition_or_line(w);
        } else if (const auto* d = llvm::dyn_cast<clang::DoStmt>(s)) {
          set_body("do", d->getBody());
          out.text_ = condition_or_line(d);
        } else if (llvm::isa<clang::CompoundStmt>(s)) {
          set_body("block", s);
        } else if (llvm::isa<clang::ReturnStmt, clang::CoreturnStmt>(s)) {
          out.kind_ = "return";
        } else if (llvm::isa<clang::BreakStmt>(s)) {
          out.kind_ = "break";
        } else if (llvm::isa<clang::ContinueStmt>(s)) {
          out.kind_ = "continue";
        } else if (llvm::isa<clang::DeclStmt>(s)) {
          out.kind_ = "decl";
        } else if (const auto* e = llvm::dyn_cast<clang::Expr>(s)) {
          out.kind_ = llvm::isa<clang::CXXThrowExpr>(e->IgnoreImplicit()) ? "throw" : "expr";
        } else {
          out.kind_ = "other";
        }
        add_statement_items(out, _s);
        return out;
      }  // statement

      //----------------------------------
      // Accesses

      // the scope of the root of a path. a parameter of a lambda is local
      [[nodiscard]] std::string scope_of(const ObjectPath& _p) const {
        if (_p.isThis_) return "member";
        const auto* v = llvm::dyn_cast_or_null<clang::VarDecl>(_p.root_);
        if (const auto* b = llvm::dyn_cast_or_null<clang::BindingDecl>(_p.root_))
          v = llvm::dyn_cast_or_null<clang::VarDecl>(b->getDecomposedDecl());
        if (!v) return "local";
        if (llvm::isa<clang::ParmVarDecl>(v))
          return v->getDeclContext() == static_cast<const clang::DeclContext*>(&fn_) ? "param" : "local";
        return v->hasGlobalStorage() ? "global" : "local";
      }  // scope_of

      // true for a variable that gives no data to follow: a constant, or a global variable of the standard library or
      // of a system header, for example std::nullopt
      [[nodiscard]] bool is_fixed(const clang::VarDecl* _v) const {
        if (!_v->hasGlobalStorage()) return false;
        if (_v->isConstexpr() || _v->getType().isConstQualified()) return true;
        return !_v->isStaticLocal() && (is_in_std(_v) || sm_.isInSystemHeader(sm_.getFileLoc(_v->getLocation())));
      }  // is_fixed

      // true if the expression only binds a local reference, also the reference of a range for loop. the accesses
      // through the reference have their own roles, so the binding is a read
      [[nodiscard]] bool is_reference_binding(const clang::Expr* _e) const {
        const clang::Stmt* child = _e;
        const clang::Stmt* p     = pm_->getParent(child);
        while (p && llvm::isa<clang::ImplicitCastExpr, clang::ParenExpr, clang::MaterializeTemporaryExpr,
                              clang::ExprWithCleanups>(p)) {
          child = p;
          p     = pm_->getParent(p);
        }
        const auto* ds = llvm::dyn_cast_or_null<clang::DeclStmt>(p);
        if (!ds) return false;
        if (const auto* loop = llvm::dyn_cast_or_null<clang::CXXForRangeStmt>(pm_->getParent(ds));
            loop && loop->getRangeStmt() == ds)
          return loop->getLoopVariable()->getType()->isReferenceType();
        for (const clang::Decl* d : ds->decls())
          if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getInit() == child)
            return v->getType()->isReferenceType();
        return false;
      }  // is_reference_binding

      // the object of a path through the local references. the reference of a range for loop is an element of its
      // range, because its initializer uses a variable that the compiler made. nullopt if the object is not known
      [[nodiscard]] static std::optional<ObjectPath> object_of(const ObjectPath& _written, const clang::Expr* _e,
                                                               const ranges_t& _ranges) {
        if (const auto* v = llvm::dyn_cast_or_null<clang::VarDecl>(_written.root_);
            v && v->getType()->isReferenceType())
          if (const auto it = _ranges.find(v); it != _ranges.end()) {
            std::optional<ObjectPath> p = object_path(it->second, {});
            if (!p) return std::nullopt;
            p->steps_.push_back(nullptr);
            p->steps_.insert(p->steps_.end(), _written.steps_.begin(), _written.steps_.end());
            return p;
          }
        std::optional<ObjectPath> p = object_path(_e, {});
        const auto* root            = p ? llvm::dyn_cast_or_null<clang::VarDecl>(p->root_) : nullptr;
        if (root && root->isImplicit()) return std::nullopt;
        return p;
      }  // object_of

      [[nodiscard]] std::vector<StructureAccess> accesses_of(const StructureScanner& _scan) const {
        ranges_t ranges;
        for (const clang::CXXForRangeStmt* s : _scan.ranges_)
          if (s->getLoopVariable() && s->getRangeInit()) ranges[s->getLoopVariable()] = s->getRangeInit();

        std::vector<std::pair<uint32_t, StructureAccess>> out;
        // a name in the body of a macro of a different file is not a part of the list. the user did not write it
        const auto add = [&](const clang::SourceLocation _loc, StructureAccess&& _access) {
          if (_loc.isInvalid() || !sm_.isWrittenInMainFile(sm_.getSpellingLoc(_loc))) return;
          const clang::SourceLocation at = sm_.getFileLoc(_loc);
          _access.line_                  = sm_.getExpansionLineNumber(at);
          _access.col_                   = sm_.getExpansionColumnNumber(at);
          _access.isInLambda_            = is_in_lambda(sm_.getFileOffset(at));
          _access.lambda_                = lambda_at(sm_.getFileOffset(at));
          out.emplace_back(sm_.getFileOffset(at), std::move(_access));
        };

        for (const clang::Expr* e : _scan.objects_) {
          if (is_inner_step(e, *pm_)) continue;
          const std::optional<ObjectPath> written = object_path(e, {}, 0, false);
          if (!written) continue;
          if (const auto* v = llvm::dyn_cast_or_null<clang::VarDecl>(written->root_);
              v && (v->isImplicit() || is_fixed(v)))
            continue;
          const std::optional<ObjectPath> object = object_of(*written, e, ranges);
          StructureAccess a;
          a.path_ = path_text(*written);
          if (a.path_.empty()) continue;
          if (object) a.object_ = path_text(*object);
          if (a.object_ == a.path_) a.object_.clear();
          a.role_  = is_reference_binding(e) ? "read" : structure_role(access_role(e, *pm_));
          a.scope_ = scope_of(object ? *object : *written);
          add(name_loc(e), std::move(a));
        }

        // a declaration. a reference gives the object of its initializer
        for (const clang::VarDecl* v : _scan.vars_) {
          if (!v->getIdentifier() || is_fixed(v)) continue;
          StructureAccess a;
          a.path_ = v->getNameAsString();
          if (v->getType()->isReferenceType())
            if (const std::optional<ObjectPath> p = object_of(ObjectPath{v, false, {}}, v->getInit(), ranges))
              a.object_ = path_text(*p);
          if (a.object_ == a.path_) a.object_.clear();
          a.role_  = "decl";
          a.scope_ = scope_of(ObjectPath{v, false, {}});
          add(v->getLocation(), std::move(a));
        }
        for (const clang::BindingDecl* b : _scan.bindings_) {
          if (!b->getIdentifier()) continue;
          StructureAccess a;
          a.path_  = b->getNameAsString();
          a.role_  = "decl";
          a.scope_ = scope_of(ObjectPath{b, false, {}});
          add(b->getLocation(), std::move(a));
        }

        std::ranges::stable_sort(out, {}, &std::pair<uint32_t, StructureAccess>::first);
        std::vector<StructureAccess> accesses;
        accesses.reserve(out.size());
        for (std::pair<uint32_t, StructureAccess>& p : out) accesses.push_back(std::move(p.second));
        return accesses;
      }  // accesses_of

      // the lines of the reads that each write reaches, from the reaching definitions of the slice. the function and
      // each lambda have a body of their own. a write and a definition of the slice agree if they have the same body,
      // the same line and the same path. in a lambda, only a local variable and a parameter by value get lines: the
      // reads of a captured variable are in the enclosing function
      void add_reaches(std::vector<StructureAccess>& _accesses) const {
        // the line and the path of a definition -> the lines of the reads that it reaches
        using reach_t         = std::map<std::pair<uint32_t, std::string>, std::set<uint32_t>>;
        const auto reaches_of = [&](BodyModel& _b, const bool _isLambda) -> std::optional<reach_t> {
          if (!build_body(_b, ctx_)) return std::nullopt;
          const auto line_of_access = [&](const Access& _a) {
            return line_of(_a.expr_ ? _a.expr_->getExprLoc() : _b.values_[_a.value_].key_.root_->getLocation());
          };
          reach_t out;
          for (size_t d = 0; d < _b.accesses_.size(); ++d) {
            const Access& def       = _b.accesses_[d];
            const SliceValue& value = _b.values_[def.value_];
            if (!def.isDef_ || (!def.expr_ && !value.key_.root_)) continue;
            if (_isLambda && value.storage_ != Storage::LOCAL && value.storage_ != Storage::PARAM_VALUE) continue;
            std::set<uint32_t>& lines = out[{line_of_access(def), value.text_}];
            for (const int32_t u : _b.reached_[d]) lines.insert(line_of_access(_b.accesses_[u]));
          }
          return out;
        };
        // the longest part of the path that the slice has. the slice stops a path at an element, at a call and after 3
        // data members, and a write there is a possible write of that part. its reads can be more than the reads of
        // the path, for example startPlans for startPlans[].kind
        const auto apply = [&](const int32_t _lambda, const reach_t& _reaches) {
          for (StructureAccess& a : _accesses) {
            if (a.role_ == "read" || a.lambda_ != _lambda) continue;
            std::string part = a.path_;
            auto it          = _reaches.find({a.line_, part});
            while (it == _reaches.end()) {
              const size_t cut = part.find_last_of(".[");
              if (cut == std::string::npos || cut == 0) break;
              part.resize(cut);
              it = _reaches.find({a.line_, part});
            }
            if (it == _reaches.end()) continue;
            a.hasReaches_ = true;
            a.reaches_.assign(it->second.begin(), it->second.end());
          }
        };

        BodyModel body;
        body.fn_ = &fn_;
        if (const std::optional<reach_t> r = reaches_of(body, false)) apply(-1, *r);
        for (size_t i = 0; i < lambdaExprs_.size(); ++i) {
          BodyModel b;
          b.lambda_ = lambdaExprs_[i];
          b.fn_     = lambdaExprs_[i]->getCallOperator();
          if (const std::optional<reach_t> r = reaches_of(b, true)) apply(int32_t(i), *r);
        }
      }  // add_reaches
    };  // StructureBuilder

    [[nodiscard]] inline JsonObject structure_stmt_to_json(const StructureStmt& _s);

    [[nodiscard]] inline JsonArray structure_stmts_to_json(const std::vector<StructureStmt>& _list) {
      JsonArray out;
      for (const StructureStmt& s : _list) out.push_back(structure_stmt_to_json(s));
      return out;
    }  // structure_stmts_to_json

    inline JsonObject structure_stmt_to_json(const StructureStmt& _s) {
      JsonArray exits;
      for (const StructureExit& e : _s.exits_)
        exits.push_back(JsonObject{{"line", int64_t(e.line_)}, {"kind", e.kind_}});
      JsonArray events;
      for (const StructureEvent& e : _s.events_)
        events.push_back(JsonObject{{"line", int64_t(e.line_)}, {"name", e.name_}});
      JsonArray threads;
      for (const StructureThread& t : _s.threads_)
        threads.push_back(JsonObject{{"line", int64_t(t.line_)}, {"via", t.via_}, {"runs", t.runs_}});
      JsonArray calls;
      for (const StructureCall& c : _s.calls_)
        calls.push_back(JsonObject{{"line", int64_t(c.line_)}, {"name", c.name_}});

      JsonObject out{{"first", int64_t(_s.first_)},
                     {"last", int64_t(_s.last_)},
                     {"kind", _s.kind_},
                     {"text", _s.text_},
                     {"exits", std::move(exits)},
                     {"events", std::move(events)},
                     {"threads", std::move(threads)},
                     {"calls", std::move(calls)}};
      if (_s.hasBranches_) {
        JsonArray branches;
        for (const StructureBranch& b : _s.branches_)
          branches.push_back(JsonObject{{"first", int64_t(b.first_)},
                                        {"last", int64_t(b.last_)},
                                        {"label", b.label_},
                                        {"statements", structure_stmts_to_json(b.statements_)}});
        out["branches"] = std::move(branches);
      }
      if (_s.hasBody_) out["body"] = structure_stmts_to_json(_s.body_);
      return out;
    }  // structure_stmt_to_json
  }  // namespace Detail

  [[nodiscard]] inline StructureModel build_structure(const clang::FunctionDecl& _fn, clang::ASTContext& _ctx,
                                                      const StructureOptions& _opts) {
    return Detail::StructureBuilder(_fn, _ctx, _opts).run();
  }  // build_structure

  [[nodiscard]] inline JsonObject structure_to_json(const StructureModel& _model) {
    JsonArray accesses;
    for (const StructureAccess& a : _model.accesses_) {
      JsonObject o{{"line", int64_t(a.line_)},
                   {"col", int64_t(a.col_)},
                   {"path", a.path_},
                   {"role", a.role_},
                   {"scope", a.scope_}};
      if (!a.object_.empty()) o["object"] = a.object_;
      if (a.isInLambda_) o["inLambda"] = true;
      if (a.hasReaches_) {
        JsonArray lines;
        for (const uint32_t l : a.reaches_) lines.push_back(int64_t(l));
        o["reaches"] = std::move(lines);
      }
      accesses.push_back(std::move(o));
    }
    return JsonObject{{"statements", Detail::structure_stmts_to_json(_model.statements_)},
                      {"accesses", std::move(accesses)}};
  }  // structure_to_json

}  // namespace DataFlow
