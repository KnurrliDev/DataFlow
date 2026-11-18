#pragma once

#include <dataflow/cost.hpp>
#include <dataflow/structure.hpp>

/*
  The metrics of the functions of a file, for the heat score of the extension:
    > decisions: if, the loops, the case labels, catch, &&, || and ?:, also in the lambdas. a decision in the expansion
      of a macro of a system header does not count, for example the || of assert
    > depth: the deepest nesting of the statements with decisions: if, the loops, switch and try. an else if has the
      depth of its if
    > loops: the first and the last line of each loop
    > writes: the data members, the globals and the static locals that the function writes, and the data that it writes
      through a non-const reference parameter or through a pointer parameter. the accesses of the structure give them
    > costs in loops: the allocations and the copies of hidden c++ in a loop of the function
    > the lines of the body, virtual and override, and the first declaration of the function
    > gui code: the class of a member function is a gui class or derives from one, or at least half of the calls, and
      at least 3 calls, go to a gui api. the heat score counts the points of gui code half
*/

namespace DataFlow {

  // a write of shared state: the path of the source text, for example charge.is_dirty, and its scope
  struct MetricsWrite {
    std::string path_;
    std::string scope_;  // member, global or param
  };  // MetricsWrite

  // why a function is gui code:
  //   > class: the class of the member function is a gui class or derives from one, for example from QWidget
  //   > calls: at least half of the calls of the function, and at least 3 calls, go to a gui api: a function of a gui
  //     namespace such as ImGui, or a member function of a gui class
  struct MetricsGui {
    std::string kind_;               // class or calls. empty: the function is not gui code
    std::string class_;              // class: the class of the member function
    std::string base_;               // class: the nearest gui class that the class is or derives from
    uint32_t calls_ = 0;             // calls: the calls to the gui apis
    uint32_t total_ = 0;             // calls: all calls of a known function, but no operator calls
    std::vector<std::string> apis_;  // calls: the gui namespaces and classes, the most calls first, at most 3
  };  // MetricsGui

  // the gui classes and the gui namespaces. a request adds the names of the settings to the known names
  struct GuiOptions {
    std::vector<std::string> classes_    = {"QWidget",     "QGraphicsItem", "QQuickItem", "SWidget",
                                            "UUserWidget", "UWidget",       "wxWindow",   "CWnd"};
    std::vector<std::string> namespaces_ = {"ImGui"};
  };  // GuiOptions

  struct FunctionMetrics {
    const clang::FunctionDecl* fn_ = nullptr;
    uint32_t decisions_            = 0;
    uint32_t depth_                = 0;
    uint32_t body_lines_           = 0;
    uint32_t allocations_in_loops_ = 0;
    uint32_t copies_in_loops_      = 0;
    bool isVirtual_ = false, isOverride_ = false;
    std::vector<std::pair<uint32_t, uint32_t>> loops_;  // the first and the last line of each loop
    std::vector<MetricsWrite> writes_;
    std::string decl_file_;  // the file of the first declaration, for example the header of a member function
    uint32_t decl_line_ = 0;
    MetricsGui gui_;
  };  // FunctionMetrics

  namespace Detail {
    // the decisions, the depth and the loops of a body
    struct DecisionWalker {
      const clang::SourceManager& sm_;
      uint32_t decisions_ = 0;
      uint32_t depth_     = 0;
      std::vector<std::pair<uint32_t, uint32_t>> loops_;

      // _depth: the number of statements with decisions around _s
      void walk(const clang::Stmt* _s, const uint32_t _depth) {
        if (!_s) return;
        // the code of a macro of a system header is not code of the user
        const bool isCounted = !sm_.isInSystemMacro(_s->getBeginLoc());
        uint32_t depth       = _depth;
        const auto nest      = [&]() {
          depth  = _depth + 1;
          depth_ = std::max(depth_, depth);
        };

        if (llvm::isa<clang::IfStmt>(_s)) {
          if (isCounted) ++decisions_;
          nest();
        } else if (llvm::isa<clang::ForStmt, clang::WhileStmt, clang::DoStmt, clang::CXXForRangeStmt>(_s)) {
          if (isCounted) ++decisions_;
          nest();
          loops_.emplace_back(line_of(_s->getBeginLoc()), line_of(_s->getEndLoc()));
        } else if (llvm::isa<clang::SwitchStmt, clang::CXXTryStmt>(_s)) {
          nest();
        } else if (llvm::isa<clang::CaseStmt, clang::CXXCatchStmt, clang::AbstractConditionalOperator>(_s)) {
          if (isCounted) ++decisions_;
        } else if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(_s); b && b->isLogicalOp()) {
          if (isCounted) ++decisions_;
        }

        // an else if has the depth of its if
        const auto* i = llvm::dyn_cast<clang::IfStmt>(_s);
        for (const clang::Stmt* c : _s->children())
          walk(c, i && c == i->getElse() && llvm::isa<clang::IfStmt>(c) ? _depth : depth);
      }  // walk

      [[nodiscard]] uint32_t line_of(const clang::SourceLocation _loc) const {
        return sm_.getExpansionLineNumber(sm_.getExpansionLoc(_loc));
      }  // line_of
    };  // DecisionWalker

    // true if a write of a parameter path changes data of the caller: any write through a non-const lvalue reference,
    // and a write through a pointer to a member or an element. a write of the pointer itself is local
    [[nodiscard]] inline bool is_shared_param_write(const clang::FunctionDecl& _fn, const std::string& _path) {
      const std::string root = _path.substr(0, _path.find_first_of(".["));
      for (const clang::ParmVarDecl* p : _fn.parameters()) {
        if (p->getName() != llvm::StringRef(root)) continue;
        const clang::QualType type = p->getType();
        if (type->isLValueReferenceType()) return !type->getPointeeType().isConstQualified();
        return type->isPointerType() && _path.size() > root.size();
      }
      return false;
    }  // is_shared_param_write

    // the writes of shared state in the accesses of a structure. each path counts one time
    [[nodiscard]] inline std::vector<MetricsWrite> shared_writes(const clang::FunctionDecl& _fn,
                                                                 const StructureModel& _model) {
      std::vector<MetricsWrite> out;
      std::set<std::string> seen;
      for (const StructureAccess& a : _model.accesses_) {
        if (a.role_ != "write" && a.role_ != "readwrite") continue;
        const bool isShared = a.scope_ == "member" || a.scope_ == "global" ||
                              (a.scope_ == "param" && is_shared_param_write(_fn, a.path_));
        if (!isShared || !seen.insert(a.path_).second) continue;
        out.push_back(MetricsWrite{a.path_, a.scope_});
      }
      return out;
    }  // shared_writes

    // the nearest gui class that a class is or derives from: the class itself, then its bases, then their bases.
    // nullptr if there is none. a base with no definition, for example a dependent base, is not known
    [[nodiscard]] inline const clang::CXXRecordDecl* gui_base(const clang::CXXRecordDecl* _record,
                                                              const std::vector<std::string>& _classes) {
      std::vector<const clang::CXXRecordDecl*> queue{_record};
      std::set<const clang::CXXRecordDecl*> seen;
      for (size_t i = 0; i < queue.size(); ++i) {
        const clang::CXXRecordDecl* r = queue[i]->getDefinition() ? queue[i]->getDefinition() : queue[i];
        if (!seen.insert(r->getCanonicalDecl()).second) continue;
        if (name_in(r, _classes)) return r;
        if (!r->hasDefinition()) continue;
        for (const clang::CXXBaseSpecifier& b : r->bases())
          if (const clang::CXXRecordDecl* base = b.getType()->getAsCXXRecordDecl()) queue.push_back(base);
      }
      return nullptr;
    }  // gui_base

    // the calls of a body to a known function, also in its lambdas: all calls, and the calls to each gui api. _api_of
    // gives the gui api of a function, or an empty text. an operator call does not count
    template <class ApiOf>
    void count_calls(const clang::Stmt* _s, const ApiOf& _api_of, uint32_t& _total,
                     std::map<std::string, uint32_t>& _apis) {
      if (!_s) return;
      if (const auto* call = llvm::dyn_cast<clang::CallExpr>(_s);
          call && !llvm::isa<clang::CXXOperatorCallExpr>(call)) {
        if (const clang::FunctionDecl* callee = call->getDirectCallee()) {
          ++_total;
          if (std::string api = _api_of(*callee); !api.empty()) ++_apis[std::move(api)];
        }
      }
      for (const clang::Stmt* c : _s->children()) count_calls(c, _api_of, _total, _apis);
    }  // count_calls
  }  // namespace Detail

  // the metrics of the functions with a body. _insts: the instantiations of the templates of the functions, for the
  // items of hidden c++. _gui: the gui classes and the gui namespaces
  [[nodiscard]] inline std::vector<FunctionMetrics> build_metrics(const std::vector<const clang::FunctionDecl*>& _fns,
                                                                  const Instantiations& _insts, clang::ASTContext& _ctx,
                                                                  const GuiOptions& _gui) {
    const clang::SourceManager& sm    = _ctx.getSourceManager();
    const std::vector<CostItem> costs = build_costs(_fns, _insts, _ctx, CostOptions{});
    StructureOptions structure_opts;
    structure_opts.hasReaches_ = false;

    // the gui class of each class, with one search for each class
    std::map<const clang::CXXRecordDecl*, const clang::CXXRecordDecl*> gui_bases;
    const auto gui_of = [&](const clang::CXXRecordDecl* _record) {
      const auto [it, isNew] = gui_bases.try_emplace(_record->getCanonicalDecl(), nullptr);
      if (isNew) it->second = Detail::gui_base(_record, _gui.classes_);
      return it->second;
    };
    // the gui api of a called function: its gui namespace, or the gui class of a member function. empty if it has none
    const auto api_of = [&](const clang::FunctionDecl& _callee) -> std::string {
      for (const clang::DeclContext* dc = _callee.getDeclContext(); dc; dc = dc->getParent())
        if (const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(dc); ns && Detail::name_in(ns, _gui.namespaces_))
          return ns->getQualifiedNameAsString();
      if (const auto* method = llvm::dyn_cast<clang::CXXMethodDecl>(&_callee); method && gui_of(method->getParent()))
        return method->getParent()->getQualifiedNameAsString();
      return {};
    };

    std::vector<FunctionMetrics> out;
    for (int32_t i = 0; i < int32_t(_fns.size()); ++i) {
      const clang::FunctionDecl& fn = *_fns[i];
      const clang::Stmt* body       = fn.getBody();
      if (!body) continue;

      FunctionMetrics m;
      m.fn_ = &fn;
      Detail::DecisionWalker walker{sm};
      walker.walk(body, 0);
      m.decisions_         = walker.decisions_;
      m.depth_             = walker.depth_;
      m.loops_             = std::move(walker.loops_);

      const uint32_t first = walker.line_of(body->getBeginLoc());
      const uint32_t last  = walker.line_of(body->getEndLoc());
      m.body_lines_        = last >= first ? last - first + 1 : 1;

      // the allocations and the copies in the loops of the function
      for (const CostItem& c : costs) {
        if (c.fn_ != i || (c.kind_ != CostKind::ALLOCATION && c.kind_ != CostKind::COPY)) continue;
        const uint32_t line = walker.line_of(c.at_.loc_);
        const bool isInLoop =
            std::ranges::any_of(m.loops_, [&](const auto& _l) { return line >= _l.first && line <= _l.second; });
        if (!isInLoop) continue;
        if (c.kind_ == CostKind::ALLOCATION)
          ++m.allocations_in_loops_;
        else
          ++m.copies_in_loops_;
      }

      m.writes_ = Detail::shared_writes(fn, build_structure(fn, _ctx, structure_opts));

      if (const auto* method = llvm::dyn_cast<clang::CXXMethodDecl>(&fn)) {
        m.isVirtual_  = method->isVirtual();
        m.isOverride_ = method->getCanonicalDecl()->size_overridden_methods() > 0;
      }

      // gui code: a member function of a gui class, or a function that mostly calls gui apis
      const auto* method = llvm::dyn_cast<clang::CXXMethodDecl>(&fn);
      if (const clang::CXXRecordDecl* base = method ? gui_of(method->getParent()) : nullptr) {
        m.gui_.kind_  = "class";
        m.gui_.class_ = method->getParent()->getQualifiedNameAsString();
        m.gui_.base_  = base->getQualifiedNameAsString();
      } else {
        uint32_t total = 0;
        std::map<std::string, uint32_t> apis;
        Detail::count_calls(body, api_of, total, apis);
        uint32_t calls = 0;
        for (const auto& [api, n] : apis) calls += n;
        if (calls >= 3 && 2 * calls >= total) {
          m.gui_.kind_  = "calls";
          m.gui_.calls_ = calls;
          m.gui_.total_ = total;
          std::vector<std::pair<std::string, uint32_t>> sorted(apis.begin(), apis.end());
          std::ranges::stable_sort(sorted, [](const auto& _a, const auto& _b) { return _a.second > _b.second; });
          for (size_t k = 0; k < sorted.size() && k < 3; ++k) m.gui_.apis_.push_back(sorted[k].first);
        }
      }

      const clang::FunctionDecl* decl = fn.getFirstDecl();
      m.decl_file_                    = Detail::file_of(sm, decl->getLocation());
      m.decl_line_                    = walker.line_of(decl->getLocation());
      out.push_back(std::move(m));
    }
    return out;
  }  // build_metrics

  // lines start at 1
  [[nodiscard]] inline JsonObject metrics_to_json(const std::vector<FunctionMetrics>& _metrics,
                                                  const clang::SourceManager& _sm) {
    JsonArray fns;
    for (const FunctionMetrics& m : _metrics) {
      JsonObject o   = function_to_json(*m.fn_, _sm);
      o["decisions"] = int64_t(m.decisions_);
      o["depth"]     = int64_t(m.depth_);
      o["bodyLines"] = int64_t(m.body_lines_);
      JsonArray loops;
      for (const auto& [first, last] : m.loops_) loops.push_back(JsonArray{int64_t(first), int64_t(last)});
      o["loops"] = std::move(loops);
      JsonArray writes;
      for (const MetricsWrite& w : m.writes_) writes.push_back(JsonObject{{"path", w.path_}, {"scope", w.scope_}});
      o["writes"]             = std::move(writes);
      o["allocationsInLoops"] = int64_t(m.allocations_in_loops_);
      o["copiesInLoops"]      = int64_t(m.copies_in_loops_);
      if (m.isVirtual_) o["virtual"] = true;
      if (m.isOverride_) o["override"] = true;
      o["declaration"] = JsonObject{{"file", m.decl_file_}, {"line", int64_t(m.decl_line_)}};
      if (m.gui_.kind_ == "class") {
        o["gui"] = JsonObject{{"kind", "class"}, {"class", m.gui_.class_}, {"base", m.gui_.base_}};
      } else if (m.gui_.kind_ == "calls") {
        JsonArray apis;
        for (const std::string& a : m.gui_.apis_) apis.push_back(a);
        o["gui"] = JsonObject{{"kind", "calls"},
                              {"calls", int64_t(m.gui_.calls_)},
                              {"total", int64_t(m.gui_.total_)},
                              {"apis", std::move(apis)}};
      }
      fns.push_back(std::move(o));
    }
    return JsonObject{{"functions", std::move(fns)}};
  }  // metrics_to_json

}  // namespace DataFlow
