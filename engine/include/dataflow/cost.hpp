#pragma once

#include <dataflow/analysis.hpp>

/*
  Hidden C++ of the functions of a file: the operations that the compiler adds, and that the code does not show
    > copies and moves of class types. a trivially copyable type of min_copy_bytes_ or less does not show
    > conversions that change the value: integer and floating point, narrow casts, and conversion functions
    > temporaries that a reference keeps alive, and temporaries from implicit conversions
    > names that hide a variable of an outer scope
    > destructors at the end of a scope, and at a return, a break or a continue
    > allocations: new, make_unique, make_shared, and container calls that can grow. the container calls are a heuristic
    > repeated lookups of the same key in the same container, with no change of the container between them
    > hidden state: static locals, and globals that the function writes
*/

namespace DataFlow {

  enum class CostKind { COPY, MOVE, CONVERSION, TEMPORARY, SHADOW, DESTRUCTOR, ALLOCATION, LOOKUP, STATE };

  struct CostItem {
    CostKind kind_ = CostKind::COPY;
    int32_t fn_    = -1;  // the index of the function
    Span at_;
    std::string text_;     // the short text of the hint
    std::string detail_;   // the text of the panel
    std::string pattern_;  // the key of "Not useful": the kind and the type
    bool isHeuristic_ = false;
    std::vector<Span> related_;  // the other places of the item, for example the other lookups of a group
  };  // CostItem

  struct CostOptions {
    uint64_t min_copy_bytes_ = 16;
  };  // CostOptions

  namespace Detail {
    // the printing policy of the type texts: no keyword struct or class and no scope
    [[nodiscard]] inline clang::PrintingPolicy type_policy(const clang::ASTContext& _ctx) {
      clang::PrintingPolicy out(_ctx.getLangOpts());
      out.SuppressTagKeyword = true;
      out.SuppressScope      = true;
      return out;
    }  // type_policy

    // the text of a type with the short names of the string types
    [[nodiscard]] inline std::string short_type_names(std::string _text) {
      std::string out = std::move(_text);

      // the canonical names of the string types are long. the aliases are the names in the code
      // a nested name has the scope std::, and the outer name has no scope. % marks the place of the scope
      using Alias     = std::pair<std::string_view, std::string_view>;
      for (const auto& [form, to] :
           {Alias{"%basic_string<char, %char_traits<char>, %allocator<char>>", "std::string"},
            Alias{"%basic_string<char>", "std::string"},
            Alias{"%basic_string<wchar_t, %char_traits<wchar_t>, %allocator<wchar_t>>", "std::wstring"},
            Alias{"%basic_string<wchar_t>", "std::wstring"},
            Alias{"%basic_string_view<char, %char_traits<char>>", "std::string_view"},
            Alias{"%basic_string_view<char>", "std::string_view"}}) {
        for (const std::string_view scope : {std::string_view("std::"), std::string_view()}) {
          std::string from;
          for (const char c : form) from += c == '%' ? std::string(scope) : std::string(1, c);
          for (size_t at = out.find(from); at != std::string::npos; at = out.find(from, at + to.size()))
            out.replace(at, from.size(), to);
        }
      }

      // clang gives the type of size_t expressions the internal name __size_t
      if (out == "__size_t") out = "size_t";
      return out;
    }  // short_type_names

    // the text of a type with all scopes, as the scope std:: of the standard names. the outer name of a different scope
    // gets no scope, for example GridStatus for electricity::GridStatus
    [[nodiscard]] inline std::string scoped_type_text(const clang::QualType _t, const clang::ASTContext& _ctx) {
      clang::PrintingPolicy policy = type_policy(_ctx);
      policy.SuppressScope         = false;
      std::string out              = short_type_names(_t.getAsString(policy));

      // the outer name comes after const and volatile, and ends at its template arguments, a pointer, a reference, an
      // array or a function type
      size_t begin                 = 0;
      for (const std::string_view q : {std::string_view("const "), std::string_view("volatile ")})
        if (std::string_view(out).substr(begin).starts_with(q)) begin += q.size();
      if (std::string_view(out).substr(begin).starts_with("std::")) return out;
      const size_t end = out.find_first_of("<(*&[ ,", begin);
      if (end == begin) return out;
      const size_t scope = out.rfind("::", end);
      if (scope != std::string::npos && scope >= begin) out.erase(begin, scope + 2 - begin);
      return out;
    }  // scoped_type_text

    // the text of a type, with no reference and no const
    [[nodiscard]] inline std::string type_text(const clang::QualType _t, const clang::ASTContext& _ctx) {
      // a typedef in a class, for example mapped_type of std::map, gets the type that it names
      clang::QualType t = _t.getNonReferenceType().getUnqualifiedType();
      if (const auto* td = t->getAs<clang::TypedefType>();
          td && llvm::isa<clang::CXXRecordDecl>(td->getDecl()->getDeclContext()))
        t = t.getCanonicalType();
      return scoped_type_text(t, _ctx);
    }  // type_text

    // the template arguments of an instantiation, for example <std::string, 4>. a type keeps its reference and its
    // const
    [[nodiscard]] inline std::string arguments_text(const llvm::ArrayRef<clang::TemplateArgument> _args,
                                                    const clang::ASTContext& _ctx) {
      const clang::PrintingPolicy policy = type_policy(_ctx);
      std::vector<std::string> texts;
      const auto add = [&](const auto& _self, const clang::TemplateArgument& _a) -> void {
        if (_a.getKind() == clang::TemplateArgument::Pack) {
          for (const clang::TemplateArgument& p : _a.pack_elements()) _self(_self, p);
        } else if (_a.getKind() == clang::TemplateArgument::Type) {
          texts.push_back(scoped_type_text(_a.getAsType().getCanonicalType(), _ctx));
        } else {
          std::string text;
          llvm::raw_string_ostream os(text);
          _a.print(policy, os, false);
          texts.push_back(std::move(text));
        }
      };
      for (const clang::TemplateArgument& a : _args) add(add, a);
      return "<" + llvm::join(texts, ", ") + ">";
    }  // arguments_text

    // the name of an instantiation with its template arguments, for example Box<std::string>::get or twice<int>
    [[nodiscard]] inline std::string instantiation_name(const clang::FunctionDecl& _fn, const clang::ASTContext& _ctx) {
      std::string out;
      if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(&_fn)) {
        out = m->getParent()->getNameAsString();
        if (const auto* s = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(m->getParent()))
          out += arguments_text(s->getTemplateArgs().asArray(), _ctx);
        out += "::";
      }
      out += _fn.getNameAsString();
      if (const clang::TemplateArgumentList* args = _fn.getTemplateSpecializationArgs())
        out += arguments_text(args->asArray(), _ctx);
      return out;
    }  // instantiation_name

    // true for a position in the body of a macro, for example the code of a test macro. a macro argument is code of the
    // user
    [[nodiscard]] inline bool in_macro_body(const clang::SourceLocation _loc, const clang::SourceManager& _sm) {
      return _loc.isMacroID() && _sm.isMacroBodyExpansion(_loc);
    }  // in_macro_body

    // the size of a type in bytes. 0 for a type that is incomplete or dependent
    [[nodiscard]] inline uint64_t size_of(const clang::QualType _t, const clang::ASTContext& _ctx) {
      if (_t.isNull() || _t->isDependentType() || _t->isIncompleteType()) return 0;
      return uint64_t(_ctx.getTypeSizeInChars(_t).getQuantity());
    }  // size_of

    // true if a copy of the type shows. a small trivially copyable type is noise
    [[nodiscard]] inline bool copy_shows(const clang::QualType _t, const clang::ASTContext& _ctx,
                                         const CostOptions& _opts) {
      const clang::QualType t = _t.getNonReferenceType();
      if (t.isNull() || t->isDependentType() || t->isIncompleteType()) return false;
      return !t.isTriviallyCopyableType(_ctx) || size_of(t, _ctx) > _opts.min_copy_bytes_;
    }  // copy_shows

    // qt types with implicit sharing. a copy only adds a reference to the data
    [[nodiscard]] inline bool is_shared_qt(const clang::CXXRecordDecl* _rd) {
      return _rd && _rd->getIdentifier() &&
             llvm::is_contained({"QString",
                                 "QByteArray",
                                 "QList",
                                 "QVector",
                                 "QMap",
                                 "QMultiMap",
                                 "QHash",
                                 "QMultiHash",
                                 "QSet",
                                 "QStringList",
                                 "QVariant",
                                 "QImage",
                                 "QPixmap",
                                 "QBitmap",
                                 "QIcon",
                                 "QFont",
                                 "QPen",
                                 "QBrush",
                                 "QRegion",
                                 "QPolygon",
                                 "QPolygonF",
                                 "QPainterPath",
                                 "QUrl",
                                 "QDateTime",
                                 "QDir",
                                 "QFileInfo",
                                 "QJsonObject",
                                 "QJsonArray",
                                 "QJsonValue",
                                 "QJsonDocument",
                                 "QRegularExpression",
                                 "QLocale",
                                 "QPalette",
                                 "QBitArray"},
                                _rd->getName());
    }  // is_shared_qt

    // std and qt containers with keys
    [[nodiscard]] inline bool is_associative(const clang::CXXRecordDecl* _rd) {
      if (!_rd || !_rd->getIdentifier()) return false;
      if (_rd->isInStdNamespace())
        return llvm::is_contained(
            {"map", "multimap", "unordered_map", "unordered_multimap", "set", "multiset", "unordered_set",
             "unordered_multiset", "flat_map", "flat_multimap", "flat_set", "flat_multiset"},
            _rd->getName());
      return llvm::is_contained({"QMap", "QMultiMap", "QHash", "QMultiHash", "QSet"}, _rd->getName());
    }  // is_associative

    // std and qt containers that can grow
    [[nodiscard]] inline bool is_container(const clang::CXXRecordDecl* _rd) {
      if (!_rd || !_rd->getIdentifier()) return false;
      if (is_associative(_rd)) return true;
      if (_rd->isInStdNamespace())
        return llvm::is_contained({"vector", "deque", "list", "forward_list", "basic_string"}, _rd->getName());
      return llvm::is_contained({"QList", "QVector", "QString", "QByteArray", "QStringList"}, _rd->getName());
    }  // is_container

    // a lookup in an associative container. Profile gives the structure of the container and of the key
    struct Lookup {
      clang::SourceLocation loc_;
      const clang::Stmt* call_ = nullptr;
      Span at_;
      std::string method_;
      llvm::FoldingSetNodeID container_;
      llvm::FoldingSetNodeID key_;
      std::string container_text_;
      std::string key_text_;
      std::string container_type_;
      const clang::Expr* key_expr_ = nullptr;
    };  // Lookup

    // a call that changes an associative container, for example insert or erase
    struct ContainerChange {
      clang::SourceLocation loc_;
      const clang::Stmt* at_ = nullptr;
      llvm::FoldingSetNodeID container_;
    };  // ContainerChange

    // the order of the statements of a function on the paths of its cfg. a path does not go back through a loop, so
    // two lookups in one turn of a loop are in one sequence, and two lookups in two branches are not
    class PathOrder {
      std::unique_ptr<clang::CFG> cfg_;
      std::unordered_map<const clang::Stmt*, std::pair<uint32_t, uint32_t>> pos_;  // the block and the element
      std::vector<const clang::CFGBlock*> blocks_;                                 // by the id of the block
      std::vector<uint32_t> rpo_;                                                  // the reverse post order of a block
      std::unordered_map<uint32_t, std::vector<bool>> reach_;
      const clang::ParentMap pm_;
      const clang::SourceManager& sm_;

     public:
      PathOrder(const clang::FunctionDecl& _fn, clang::ASTContext& _ctx)
          : cfg_(build_cfg(&_fn, _fn.getBody(), _ctx, {})), pm_(_fn.getBody()), sm_(_ctx.getSourceManager()) {
        if (!cfg_) return;
        blocks_.assign(cfg_->getNumBlockIDs(), nullptr);
        for (const clang::CFGBlock* b : *cfg_) {
          blocks_[b->getBlockID()] = b;
          uint32_t index           = 0;
          for (const clang::CFGElement& el : *b) {
            if (const auto s = el.getAs<clang::CFGStmt>()) pos_.try_emplace(s->getStmt(), b->getBlockID(), index);
            ++index;
          }
        }

        // the reverse post order from the entry. an edge to a block that is not later in this order goes back
        rpo_.assign(cfg_->getNumBlockIDs(), UINT32_MAX);
        std::vector<uint32_t> post;
        std::vector<bool> isSeen(cfg_->getNumBlockIDs(), false);
        std::vector<std::pair<const clang::CFGBlock*, clang::CFGBlock::const_succ_iterator>> stack;
        stack.push_back({&cfg_->getEntry(), cfg_->getEntry().succ_begin()});
        isSeen[cfg_->getEntry().getBlockID()] = true;
        while (!stack.empty()) {
          auto& [b, it] = stack.back();
          if (it == b->succ_end()) {
            post.push_back(b->getBlockID());
            stack.pop_back();
            continue;
          }
          const clang::CFGBlock* next = it->getReachableBlock();
          ++it;
          if (next && !isSeen[next->getBlockID()]) {
            isSeen[next->getBlockID()] = true;
            stack.push_back({next, next->succ_begin()});
          }
        }
        for (uint32_t i = 0; i < post.size(); ++i) rpo_[post[i]] = uint32_t(post.size() - 1 - i);
      }  // PathOrder

      [[nodiscard]] bool is_valid() const { return cfg_ != nullptr; }

      // true if _b can run after _a on a path. a statement in a lambda or in a part of an element has the position of
      // the element that contains it. two statements of one element keep the sequence of the source
      [[nodiscard]] bool runs_after(const clang::Stmt* _a, const clang::Stmt* _b) {
        const auto a = position(_a), b = position(_b);
        if (!a || !b) return sm_.isBeforeInTranslationUnit(_a->getBeginLoc(), _b->getBeginLoc());
        if (a->first == b->first) {
          if (a->second != b->second) return a->second < b->second;
          return sm_.isBeforeInTranslationUnit(_a->getBeginLoc(), _b->getBeginLoc());
        }
        return reaches(a->first)[b->first];
      }  // runs_after

     private:
      [[nodiscard]] std::optional<std::pair<uint32_t, uint32_t>> position(const clang::Stmt* _s) const {
        for (const clang::Stmt* s = _s; s; s = pm_.getParent(s))
          if (const auto it = pos_.find(s); it != pos_.end()) return it->second;
        return std::nullopt;
      }  // position

      // the blocks that a path from _block reaches with no edge back
      [[nodiscard]] const std::vector<bool>& reaches(const uint32_t _block) {
        const auto it = reach_.find(_block);
        if (it != reach_.end()) return it->second;
        std::vector<bool> out(cfg_->getNumBlockIDs(), false);
        std::vector<uint32_t> todo{_block};
        while (!todo.empty()) {
          const uint32_t id = todo.back();
          todo.pop_back();
          for (const clang::CFGBlock::AdjacentBlock& next : blocks_[id]->succs()) {
            const clang::CFGBlock* n = next.getReachableBlock();
            if (!n || out[n->getBlockID()] || rpo_[n->getBlockID()] == UINT32_MAX || rpo_[n->getBlockID()] <= rpo_[id])
              continue;
            out[n->getBlockID()] = true;
            todo.push_back(n->getBlockID());
          }
        }
        return reach_.emplace(_block, std::move(out)).first->second;
      }  // reaches
    };  // PathOrder

    // collects the items of one function body, except the shadowed names and the destructors
    class CostCollector : public clang::RecursiveASTVisitor<CostCollector> {
      clang::ASTContext& ctx_;
      const CostOptions& opts_;
      std::vector<CostItem>& out_;
      int32_t fn_;
      clang::Stmt* body_;
      std::vector<Lookup> lookups_;
      std::vector<ContainerChange> changes_;
      std::unordered_set<const clang::Expr*> temporary_casts_;  // conversions that make a temporary
      std::unordered_set<const clang::VarDecl*> globals_;
      std::unordered_map<const clang::VarDecl*, std::vector<const clang::DeclRefExpr*>> local_refs_;
      std::unique_ptr<clang::ExprMutationAnalyzer> mutation_;
      std::unordered_set<const clang::Stmt*> seen_;  // the two forms of an init list can share nodes

     public:
      CostCollector(clang::ASTContext& _ctx, const CostOptions& _opts, std::vector<CostItem>& _out, const int32_t _fn,
                    clang::Stmt* _body)
          : ctx_(_ctx), opts_(_opts), out_(_out), fn_(_fn), body_(_body) {}

      // the semantic form of an init list has the copies of an aggregate init, for example MeterRead{state}
      bool shouldVisitImplicitCode() const { return true; }

      // an implicit function, for example the move constructor of a local class, is not code of the function.
      // an implicit variable stays: the range of a range-for loop is the initializer of an implicit variable
      bool TraverseDecl(clang::Decl* _d) {
        if (_d && _d->isImplicit() && llvm::isa<clang::FunctionDecl>(_d)) return true;
        return clang::RecursiveASTVisitor<CostCollector>::TraverseDecl(_d);
      }  // TraverseDecl

      bool VisitCXXConstructExpr(clang::CXXConstructExpr* _e) {
        if (!is_new(_e)) return true;
        const clang::CXXConstructorDecl* ctor = _e->getConstructor();
        if (_e->isElidable() || !ctor || !(ctor->isCopyConstructor() || ctor->isMoveConstructor())) return true;

        // the return of a variable that the compiler constructs in the place of the result: no copy and no move
        const auto* ref =
            _e->getNumArgs() > 0 ? llvm::dyn_cast<clang::DeclRefExpr>(_e->getArg(0)->IgnoreParenImpCasts()) : nullptr;
        if (const auto* v = ref ? llvm::dyn_cast<clang::VarDecl>(ref->getDecl()) : nullptr; v && v->isNRVOVariable())
          return true;
        if (copy_shows(_e->getType(), ctx_, opts_))
          add_copy(_e->getSourceRange(), _e->getType(), ctor->isMoveConstructor(), "");
        return true;
      }  // VisitCXXConstructExpr

      bool VisitCXXOperatorCallExpr(clang::CXXOperatorCallExpr* _e) {
        if (!is_new(_e)) return true;
        if (_e->getOperator() == clang::OO_Subscript && _e->getNumArgs() == 2) {
          const clang::Expr* c = _e->getArg(0)->IgnoreImplicit()->IgnoreParenImpCasts();
          add_lookup(_e, c, c->getType()->getAsCXXRecordDecl(), _e->getArg(1), "[]");
        }
        if (_e->getOperator() != clang::OO_Equal || _e->getNumArgs() != 2) return true;

        // an assignment of a full container changes the container
        const clang::Expr* lhs = _e->getArg(0)->IgnoreImplicit()->IgnoreParenImpCasts();
        if (is_associative(lhs->getType()->getAsCXXRecordDecl())) add_change(lhs, _e);

        const auto* m = llvm::dyn_cast_or_null<clang::CXXMethodDecl>(_e->getDirectCallee());
        if (m && (m->isCopyAssignmentOperator() || m->isMoveAssignmentOperator()) &&
            copy_shows(lhs->getType(), ctx_, opts_))
          add_copy(_e->getSourceRange(), lhs->getType(), m->isMoveAssignmentOperator(), " assignment");
        return true;
      }  // VisitCXXOperatorCallExpr

      bool VisitCXXMemberCallExpr(clang::CXXMemberCallExpr* _e) {
        if (!is_new(_e)) return true;
        const clang::CXXMethodDecl* m = _e->getMethodDecl();
        const clang::Expr* obj        = _e->getImplicitObjectArgument();
        if (!m || !m->getIdentifier() || !obj) return true;
        const llvm::StringRef name = m->getName();

        // the class of the object without the implicit cast. a std container can have its methods in a base class
        obj                        = obj->IgnoreImplicit()->IgnoreParenImpCasts();
        const clang::QualType type =
            obj->getType()->isPointerType() ? obj->getType()->getPointeeType() : obj->getType();
        const clang::CXXRecordDecl* rd = type->getAsCXXRecordDecl();

        // lookups and changes of associative containers
        if (is_associative(rd)) {
          if (_e->getNumArgs() >= 1 &&
              llvm::is_contained({"find", "count", "contains", "at", "equal_range", "lower_bound", "upper_bound"},
                                 name))
            add_lookup(_e, obj, rd, _e->getArg(0), name.str());
          else if (llvm::is_contained({"insert", "emplace", "emplace_hint", "try_emplace", "insert_or_assign", "erase",
                                       "clear", "extract", "merge", "swap"},
                                      name))
            add_change(obj, _e);
        }

        // container calls that can grow, and copies into a container through a const reference parameter
        if (!is_container(rd) || !llvm::is_contained({"push_back", "emplace_back", "push_front", "emplace_front",
                                                      "insert", "emplace", "resize", "reserve", "append", "prepend"},
                                                     name))
          return true;
        add(CostKind::ALLOCATION, _e->getSourceRange(), "can allocate: " + name.str(),
            "The call " + name.str() + " can allocate memory when the container grows. This item is a heuristic.",
            "allocation|" + name.str(), true);
        if (!llvm::is_contained({"push_back", "push_front", "insert", "append", "prepend"}, name)) return true;
        for (uint32_t i = 0; i < _e->getNumArgs() && i < m->getNumParams(); ++i) {
          const clang::QualType param = m->getParamDecl(i)->getType();
          const clang::Expr* arg      = _e->getArg(i)->IgnoreParenImpCasts();
          if (param->isLValueReferenceType() && param.getNonReferenceType().isConstQualified() && arg->isLValue() &&
              arg->getType()->getAsCXXRecordDecl() && copy_shows(arg->getType(), ctx_, opts_))
            add_copy(arg->getSourceRange(), arg->getType(), false, " into the container");
        }
        return true;
      }  // VisitCXXMemberCallExpr

      // make_unique, make_shared and the other functions of std that allocate
      bool VisitCallExpr(clang::CallExpr* _e) {
        if (llvm::isa<clang::CXXMemberCallExpr, clang::CXXOperatorCallExpr>(_e) || !is_new(_e)) return true;
        const clang::FunctionDecl* fn = _e->getDirectCallee();
        if (!fn || !fn->getIdentifier() || !fn->isInStdNamespace() ||
            !llvm::is_contained({"make_unique", "make_shared", "allocate_shared", "make_unique_for_overwrite",
                                 "make_shared_for_overwrite"},
                                fn->getName()))
          return true;
        const clang::TemplateArgumentList* args = fn->getTemplateSpecializationArgs();
        const std::string type = args && args->size() > 0 && args->get(0).getKind() == clang::TemplateArgument::Type
                                     ? type_text(args->get(0).getAsType(), ctx_)
                                     : std::string("?");
        add(CostKind::ALLOCATION, _e->getSourceRange(), "allocation: " + fn->getNameAsString() + "<" + type + ">",
            "The call " + fn->getNameAsString() + " allocates memory for " + type + ".", "allocation|" + type);
        return true;
      }  // VisitCallExpr

      bool VisitCXXNewExpr(clang::CXXNewExpr* _e) {
        if (!is_new(_e)) return true;
        // a placement new constructs the object in memory that the caller gives. it does not allocate memory
        if (const clang::FunctionDecl* op = _e->getOperatorNew(); op && op->isReservedGlobalPlacementOperator())
          return true;
        const std::string type = type_text(_e->getAllocatedType(), ctx_) + (_e->isArray() ? "[]" : "");
        add(CostKind::ALLOCATION, _e->getSourceRange(), "allocation: new " + type,
            "The expression new allocates memory for " + type + ".", "allocation|" + type);
        return true;
      }  // VisitCXXNewExpr

      // conversions that change the value. a constant has a known value, so it does not show, but a string literal
      // that becomes a string shows. a conversion to bool, as in if (ptr), is a usual idiom and does not show
      bool VisitImplicitCastExpr(clang::ImplicitCastExpr* _e) {
        if (!is_new(_e)) return true;
        const clang::QualType to = _e->getType();
        if (temporary_casts_.contains(_e) || to->isDependentType() || to->isBooleanType()) return true;

        // the source of a class conversion: the argument of the constructor, or the object of the conversion function
        const clang::CastKind kind = _e->getCastKind();
        const clang::Expr* source  = _e->getSubExpr();
        const clang::Expr* inner   = source->IgnoreImplicit();
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(inner);
            c && kind == clang::CK_ConstructorConversion && c->getNumArgs() > 0) {
          // a consteval constructor runs in the compiler, for example the format string of std::format
          if (c->getConstructor() && c->getConstructor()->isConsteval()) return true;
          source = c->getArg(0);
        }
        if (const auto* m = llvm::dyn_cast<clang::CXXMemberCallExpr>(inner);
            m && kind == clang::CK_UserDefinedConversion)
          source = m->getImplicitObjectArgument();
        const bool isLiteral = llvm::isa<clang::StringLiteral>(source->IgnoreParenImpCasts());
        if (source->isValueDependent() || (!isLiteral && source->isEvaluatable(ctx_))) return true;

        const clang::QualType from = source->getType();
        bool isSignChange          = false;  // the width stays, but the sign of the type changes
        switch (kind) {
          case clang::CK_IntegralToFloating:
          case clang::CK_FloatingToIntegral:
          case clang::CK_UserDefinedConversion:
          case clang::CK_ConstructorConversion:
            break;
          case clang::CK_FloatingCast:
            if (ctx_.getTypeSize(to) >= ctx_.getTypeSize(from)) return true;
            break;
          case clang::CK_IntegralCast: {
            // a narrow type, a signed type to an unsigned type, and an unsigned type to a signed type of the same width
            // can change the value. an unsigned type to a wider signed type cannot
            if (to->isBooleanType()) return true;
            const uint64_t toWidth = ctx_.getIntWidth(to), fromWidth = ctx_.getIntWidth(from);
            const bool isFromSigned = from->isSignedIntegerOrEnumerationType();
            const bool isToSigned   = to->isSignedIntegerOrEnumerationType();
            if (toWidth >= fromWidth && (isFromSigned == isToSigned || (!isFromSigned && toWidth > fromWidth)))
              return true;
            isSignChange = toWidth >= fromWidth;
            break;
          }
          default:
            return true;
        }
        // a string literal that becomes a view, for example std::string_view, costs nothing. a value that becomes
        // std::optional, std::expected or std::variant is the usual way to return the value
        const clang::CXXRecordDecl* target = to->getAsCXXRecordDecl();
        if (isLiteral && target && target->hasDefinition() && target->hasTrivialDestructor()) return true;
        if (target && target->isInStdNamespace() && target->getIdentifier() &&
            llvm::is_contained({"optional", "expected", "unexpected", "variant"}, target->getName()))
          return true;

        const std::string f = isLiteral ? "string literal" : type_text(from, ctx_);
        const std::string t = type_text(to, ctx_);
        if (f == t) return true;
        if (isSignChange) {
          const char* change = from->isSignedIntegerOrEnumerationType() ? "A negative value becomes a large value."
                                                                        : "A large value becomes a negative value.";
          add(CostKind::CONVERSION, _e->getSourceRange(), "sign change: " + f + " -> " + t,
              "The code converts " + f + " to " + t + ". " + change, "sign|" + f + ">" + t);
          return true;
        }
        add(CostKind::CONVERSION, _e->getSourceRange(), "conversion: " + f + " -> " + t,
            "The code converts " + f + " to " + t + ". The value can change.", "conversion|" + f + ">" + t);
        return true;
      }  // VisitImplicitCastExpr

      bool VisitMaterializeTemporaryExpr(clang::MaterializeTemporaryExpr* _e) {
        if (!is_new(_e)) return true;
        const clang::QualType type     = _e->getType();
        const clang::CXXRecordDecl* rd = type->getAsCXXRecordDecl();
        if (!rd || type->isDependentType()) return true;
        const std::string t = type_text(type, ctx_);

        // a reference keeps the temporary alive to the end of its scope. an implicit reference is the range of a loop
        if (const clang::ValueDecl* d = _e->getExtendingDecl()) {
          const std::string by = d->isImplicit() ? "the range-for loop" : d->getNameAsString();
          add(CostKind::TEMPORARY, _e->getSourceRange(), "temporary " + t + ", kept alive by " + by,
              "The reference " + by + " keeps a temporary " + t +
                  " alive to the end of its scope. The temporary is a full object, not a reference to an object.",
              "temporary|" + t);
          return true;
        }

        // a temporary from an implicit conversion, for example a string literal for a const std::string& parameter.
        // the conversion is under the node that binds the temporary, and under casts that only add const
        const clang::Expr* sub = _e->getSubExpr();
        while (true) {
          if (const auto* b = llvm::dyn_cast<clang::CXXBindTemporaryExpr>(sub))
            sub = b->getSubExpr();
          else if (const auto* c = llvm::dyn_cast<clang::ImplicitCastExpr>(sub);
                   c && c->getCastKind() == clang::CK_NoOp)
            sub = c->getSubExpr();
          else
            break;
        }
        // the conversion is a cast with a converting constructor, or the constructor alone for a reference parameter.
        // a constructor that the code names, as in std::string("x"), is not hidden
        const clang::Expr* from = nullptr;
        if (const auto* cast = llvm::dyn_cast<clang::ImplicitCastExpr>(sub);
            cast && cast->getCastKind() == clang::CK_ConstructorConversion) {
          temporary_casts_.insert(cast);
          from = cast->getSubExpr();
        } else if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(sub);
                   c && !llvm::isa<clang::CXXTemporaryObjectExpr>(c) && c->getNumArgs() > 0 && c->getConstructor() &&
                   !c->getConstructor()->isCopyOrMoveConstructor()) {
          from = c->getArg(0);
        }
        if (!from || rd->hasTrivialDestructor()) return true;
        if (const auto* c = llvm::dyn_cast<clang::CXXConstructExpr>(from->IgnoreImplicit()); c && c->getNumArgs() > 0)
          from = c->getArg(0);
        const bool isLiteral = llvm::isa<clang::StringLiteral>(from->IgnoreImplicit()->IgnoreParenImpCasts());
        const std::string f  = isLiteral ? "string literal" : type_text(from->getType(), ctx_);
        add(CostKind::TEMPORARY, _e->getSourceRange(), "temporary " + t + " from " + f,
            "The code makes a temporary " + t + " from " + f +
                " for this argument. The temporary is destroyed at the end of the statement.",
            "temporary|" + t);
        return true;
      }  // VisitMaterializeTemporaryExpr

      // a static local keeps its value between calls
      bool VisitVarDecl(clang::VarDecl* _d) {
        if (!_d->isStaticLocal() || _d->isConstexpr() || _d->getType().isConstQualified()) return true;
        const std::string name = _d->getNameAsString();
        add(CostKind::STATE, {_d->getLocation(), _d->getLocation()}, "static: keeps its value between calls",
            "The variable " + name +
                " is static. It keeps its value between calls, and all callers share it. The type is " +
                type_text(_d->getType(), ctx_) + ".",
            "state|" + name);
        return true;
      }  // VisitVarDecl

      // a global that the function writes. the first write of each global shows. the references of the local variables
      // are for the keys of the lookups
      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        const auto* v = llvm::dyn_cast<clang::VarDecl>(_e->getDecl());
        if (v && v->hasLocalStorage() && is_new(_e)) local_refs_[v].push_back(_e);
        if (!v || !v->hasGlobalStorage() || v->isStaticLocal() || v->isConstexpr() || v->getType().isConstQualified() ||
            globals_.contains(v))
          return true;
        if (!mutation_) mutation_ = std::make_unique<clang::ExprMutationAnalyzer>(*body_, ctx_);
        if (!mutation_->findMutation(_e)) return true;
        globals_.insert(v);
        const std::string name = v->getNameAsString();
        add(CostKind::STATE, _e->getSourceRange(), "writes the global " + name,
            "The function writes the global variable " + name + ". Other calls and other threads can see the change.",
            "state|" + name);
        return true;
      }  // VisitDeclRefExpr

      // groups the lookups of the same key in the same container. two lookups are in one group if one can run after
      // the other on a path, and no change of the container or of a variable of the key can run between them. the
      // count is the largest number of lookups on one path, and the item shows all lookups of the group. with no cfg,
      // the sequence of the source gives the paths
      void finish(const clang::FunctionDecl& _fn) {
        const clang::SourceManager& sm = ctx_.getSourceManager();
        std::sort(lookups_.begin(), lookups_.end(), [&](const Lookup& _a, const Lookup& _b) -> bool {
          return sm.isBeforeInTranslationUnit(_a.loc_, _b.loc_);
        });
        if (lookups_.size() < 2) return;
        PathOrder order(_fn, ctx_);
        const auto runs_after = [&](const clang::Stmt* _a, const clang::Stmt* _b) -> bool {
          return order.is_valid() ? order.runs_after(_a, _b)
                                  : sm.isBeforeInTranslationUnit(_a->getBeginLoc(), _b->getBeginLoc());
        };
        const auto is_between = [&](const clang::Stmt* _s, const clang::Stmt* _a, const clang::Stmt* _b) -> bool {
          return runs_after(_a, _s) && runs_after(_s, _b);
        };

        // the lookups of each key in each container, in the sequence of the source
        std::vector<std::vector<size_t>> sets;
        for (size_t i = 0; i < lookups_.size(); ++i) {
          const auto it = std::find_if(sets.begin(), sets.end(), [&](const std::vector<size_t>& _set) -> bool {
            return lookups_[_set.front()].container_ == lookups_[i].container_ &&
                   lookups_[_set.front()].key_ == lookups_[i].key_;
          });
          if (it == sets.end())
            sets.push_back({i});
          else
            it->push_back(i);
        }

        for (const std::vector<size_t>& set : sets) {
          if (set.size() < 2) continue;
          const Lookup& first                                     = lookups_[set.front()];
          const std::vector<const clang::DeclRefExpr*> key_writes = writes_of_key(first);

          // next[a] has the lookups that can run after a, with no change between them
          const size_t n                                          = set.size();
          std::vector<std::vector<size_t>> next(n);
          std::vector<size_t> group_of(n);
          for (size_t a = 0; a < n; ++a) group_of[a] = a;
          const auto root = [&](size_t _a) -> size_t {
            while (group_of[_a] != _a) _a = group_of[_a] = group_of[group_of[_a]];
            return _a;
          };
          for (size_t a = 0; a < n; ++a)
            for (size_t b = 0; b < n; ++b) {
              const clang::Stmt* from = lookups_[set[a]].call_;
              const clang::Stmt* to   = lookups_[set[b]].call_;
              if (a == b || !runs_after(from, to)) continue;
              const bool isChanged =
                  std::any_of(changes_.begin(), changes_.end(),
                              [&](const ContainerChange& _c) -> bool {
                                return _c.container_ == first.container_ && is_between(_c.at_, from, to);
                              }) ||
                  std::any_of(key_writes.begin(), key_writes.end(),
                              [&](const clang::DeclRefExpr* _w) -> bool { return is_between(_w, from, to); });
              if (isChanged) continue;
              next[a].push_back(b);
              group_of[root(a)] = root(b);
            }

          // the longest path of lookups from each lookup. the edges only go forward on the paths
          std::vector<int32_t> longest(n, 0);
          std::vector<size_t> best_next(n, SIZE_MAX);
          const std::function<int32_t(size_t)> length = [&](const size_t _a) -> int32_t {
            if (longest[_a] != 0) return longest[_a];
            longest[_a] = 1;  // also stops a cycle
            for (const size_t b : next[_a])
              if (const int32_t l = 1 + length(b); l > longest[_a]) {
                longest[_a]   = l;
                best_next[_a] = b;
              }
            return longest[_a];
          };

          std::vector<bool> isDone(n, false);
          for (size_t a = 0; a < n; ++a) {
            if (isDone[a]) continue;
            std::vector<size_t> group;
            for (size_t b = 0; b < n; ++b)
              if (root(b) == root(a)) {
                group.push_back(b);
                isDone[b] = true;
              }
            if (group.size() < 2) continue;

            // the lookups of the longest path, for the count and for the calls of each method
            size_t start = group.front();
            for (const size_t b : group)
              if (length(b) > length(start)) start = b;
            std::vector<std::pair<std::string, int32_t>> counts;
            int32_t count = 0;
            for (size_t b = start; b != SIZE_MAX; b = best_next[b]) {
              ++count;
              const auto it = std::find_if(counts.begin(), counts.end(), [&](const auto& _c) -> bool {
                return _c.first == lookups_[set[b]].method_;
              });
              if (it == counts.end())
                counts.push_back({lookups_[set[b]].method_, 1});
              else
                ++it->second;
            }
            std::string calls;
            for (const auto& [method, c] : counts)
              calls += (calls.empty() ? "" : ", ") + method + " " + std::to_string(c);

            CostItem item;
            for (const size_t b : group)
              if (b != group.front()) item.related_.push_back(lookups_[set[b]].at_);
            const std::string number = std::to_string(count);
            const std::string all    = std::to_string(group.size());
            item.kind_               = CostKind::LOOKUP;
            item.fn_                 = fn_;
            item.at_                 = lookups_[set[group.front()]].at_;
            item.text_               = number + " lookups of " + first.key_text_ + " in " + first.container_text_;
            item.detail_ =
                "The code looks up the same key " + first.key_text_ + " in " + first.container_text_ + " " + number +
                " times on one path: " + calls + "." +
                (group.size() > size_t(count) ? " The group has " + all + " lookups in different branches." : "") +
                " The container and the key do not change between the lookups.";
            item.pattern_ = "lookup|" + first.container_type_;
            out_.push_back(std::move(item));
          }
        }
      }  // finish

     private:
      // false if the visitor saw the node before
      bool is_new(const clang::Stmt* _s) { return seen_.insert(_s).second; }

      // the writes of the local variables of the key of a lookup, for example ++i for m.find(i)
      [[nodiscard]] std::vector<const clang::DeclRefExpr*> writes_of_key(const Lookup& _l) {
        std::vector<const clang::DeclRefExpr*> out;
        std::vector<const clang::Stmt*> stack{_l.key_expr_};
        while (!stack.empty()) {
          const clang::Stmt* s = stack.back();
          stack.pop_back();
          if (!s) continue;
          if (const auto* ref = llvm::dyn_cast<clang::DeclRefExpr>(s)) {
            const auto* v = llvm::dyn_cast<clang::VarDecl>(ref->getDecl());
            const auto it = v ? local_refs_.find(v) : local_refs_.end();
            if (it == local_refs_.end()) continue;
            if (!mutation_) mutation_ = std::make_unique<clang::ExprMutationAnalyzer>(*body_, ctx_);
            for (const clang::DeclRefExpr* use : it->second)
              if (use != ref && mutation_->findMutation(use)) out.push_back(use);
          }
          for (const clang::Stmt* child : s->children()) stack.push_back(child);
        }
        return out;
      }  // writes_of_key

      void add(const CostKind _kind, const clang::SourceRange _range, std::string _text, std::string _detail,
               std::string _pattern, const bool _isHeuristic = false) {
        if (in_macro_body(_range.getBegin(), ctx_.getSourceManager())) return;
        out_.push_back({_kind,
                        fn_,
                        span_of(_range, ctx_),
                        std::move(_text),
                        std::move(_detail),
                        std::move(_pattern),
                        _isHeuristic,
                        {}});
      }  // add

      void add_copy(const clang::SourceRange _range, const clang::QualType _type, const bool _isMove,
                    const std::string& _what) {
        const std::string t  = type_text(_type, ctx_);
        const std::string kb = std::to_string(size_of(_type.getNonReferenceType(), ctx_)) + " B";
        if (_isMove) {
          add(CostKind::MOVE, _range, "move" + _what + ": " + t, "The code moves " + t + _what + ".", "move|" + t);
          return;
        }
        if (is_shared_qt(_type.getNonReferenceType()->getAsCXXRecordDecl())) {
          add(CostKind::COPY, _range, "shared copy" + _what + ": " + t,
              t + " uses implicit sharing. The copy adds a reference, and a write later copies the data.", "copy|" + t);
          return;
        }
        add(CostKind::COPY, _range, "copy" + _what + ": " + t + " (" + kb + ")",
            "The code copies " + t + _what + ". The size of " + t + " is " + kb + ".", "copy|" + t);
      }  // add_copy

      void add_lookup(const clang::Expr* _call, const clang::Expr* _container, const clang::CXXRecordDecl* _rd,
                      const clang::Expr* _key, std::string _method) {
        if (!is_associative(_rd) || in_macro_body(_call->getBeginLoc(), ctx_.getSourceManager())) return;
        const clang::Expr* key = _key->IgnoreImplicit()->IgnoreParenImpCasts();
        Lookup l;
        l.loc_      = _call->getBeginLoc();
        l.call_     = _call;
        l.key_expr_ = key;
        l.at_       = span_of(_call->getSourceRange(), ctx_);
        l.method_ = std::move(_method);
        _container->Profile(l.container_, ctx_, true);
        key->Profile(l.key_, ctx_, true);
        // the type as written. the canonical type also has the default arguments, for example the allocator
        const clang::QualType type =
            _container->getType()->isPointerType() ? _container->getType()->getPointeeType() : _container->getType();
        l.container_text_ = source_text(ctx_, _container->getSourceRange());
        l.key_text_       = source_text(ctx_, key->getSourceRange());
        l.container_type_ = type_text(type, ctx_);
        lookups_.push_back(std::move(l));
      }  // add_lookup

      void add_change(const clang::Expr* _container, const clang::Stmt* _at) {
        ContainerChange c;
        c.loc_ = _at->getBeginLoc();
        c.at_  = _at;
        _container->Profile(c.container_, ctx_, true);
        changes_.push_back(std::move(c));
      }  // add_change
    };  // CostCollector

    class DeclStmtCollector : public clang::RecursiveASTVisitor<DeclStmtCollector> {
     public:
      std::vector<const clang::DeclStmt*> out_;

      bool VisitDeclStmt(clang::DeclStmt* _s) {
        out_.push_back(_s);
        return true;
      }
    };  // DeclStmtCollector

    // a variable with the name of a variable of an outer scope of the same function
    inline void add_shadows(std::vector<CostItem>& _out, const clang::FunctionDecl& _fn, const int32_t _index,
                            const clang::ASTContext& _ctx) {
      clang::Stmt* body = _fn.getBody();
      const clang::ParentMap pm(body);
      const clang::SourceManager& sm = _ctx.getSourceManager();

      // the scope of a declaration: the next statement up that starts a scope
      const auto scope_of            = [&](const clang::Stmt* _s) -> const clang::Stmt* {
        for (const clang::Stmt* p = pm.getParent(_s); p; p = pm.getParent(p))
          if (llvm::isa<clang::CompoundStmt, clang::ForStmt, clang::CXXForRangeStmt, clang::IfStmt, clang::WhileStmt,
                        clang::SwitchStmt, clang::CXXCatchStmt>(p))
            return p;
        return body;
      };
      const auto is_inside = [&](const clang::Stmt* _inner, const clang::Stmt* _outer) -> bool {
        for (const clang::Stmt* p = _inner; p; p = pm.getParent(p))
          if (p == _outer) return true;
        return false;
      };

      struct Named {
        const clang::NamedDecl* decl_;
        const clang::Stmt* scope_;
      };  // Named
      std::vector<Named> names;
      for (const clang::ParmVarDecl* p : _fn.parameters())
        if (p->getIdentifier()) names.push_back({p, body});

      DeclStmtCollector stmts;
      stmts.TraverseStmt(body);
      for (const clang::DeclStmt* ds : stmts.out_) {
        const clang::Stmt* scope = scope_of(ds);
        for (const clang::Decl* d : ds->decls()) {
          if (const auto* dd = llvm::dyn_cast<clang::DecompositionDecl>(d)) {
            for (const clang::BindingDecl* b : dd->bindings())
              if (b->getIdentifier()) names.push_back({b, scope});
          } else if (const auto* v = llvm::dyn_cast<clang::VarDecl>(d); v && v->getIdentifier() && !v->isImplicit()) {
            names.push_back({v, scope});
          }
        }
      }

      for (const Named& inner : names) {
        if (in_macro_body(inner.decl_->getLocation(), sm)) continue;
        for (const Named& outer : names) {
          if (inner.decl_ == outer.decl_ || inner.scope_ == outer.scope_ ||
              inner.decl_->getName() != outer.decl_->getName() ||
              !sm.isBeforeInTranslationUnit(outer.decl_->getLocation(), inner.decl_->getLocation()) ||
              !is_inside(inner.scope_, outer.scope_))
            continue;
          const std::string name = inner.decl_->getNameAsString();
          const std::string line = std::to_string(sm.getExpansionLineNumber(outer.decl_->getLocation()));
          _out.push_back({CostKind::SHADOW,
                          _index,
                          span_of({inner.decl_->getLocation(), inner.decl_->getLocation()}, _ctx),
                          "hides " + name + " of line " + line,
                          "This " + name + " hides the variable " + name + " of line " + line +
                              " in an outer scope. A later use of " + name + " in this scope gets this variable.",
                          "shadow|" + name,
                          false,
                          {}});
          break;
        }
      }
    }  // add_shadows

    // the destructors that run at the end of a scope, and at a return, a break or a continue
    inline void add_destructors(std::vector<CostItem>& _out, const clang::FunctionDecl& _fn, const int32_t _index,
                                clang::ASTContext& _ctx) {
      clang::CFG::BuildOptions build;
      build.AddImplicitDtors                = true;
      const std::unique_ptr<clang::CFG> cfg = build_cfg(&_fn, _fn.getBody(), _ctx, build);
      if (!cfg) return;

      std::vector<std::pair<const clang::Stmt*, const clang::VarDecl*>> seen;
      for (const clang::CFGBlock* b : *cfg) {
        for (const clang::CFGElement& el : *b) {
          const auto d = el.getAs<clang::CFGAutomaticObjDtor>();
          if (!d) continue;
          const clang::VarDecl* var  = d->getVarDecl();
          const clang::Stmt* trigger = d->getTriggerStmt();
          if (!var->getIdentifier() || var->isNRVOVariable() ||
              in_macro_body(var->getLocation(), _ctx.getSourceManager()) ||
              std::find(seen.begin(), seen.end(), std::pair{trigger, var}) != seen.end())
            continue;
          seen.push_back({trigger, var});

          // the end of a scope is its closing brace. a jump gives its own position
          const auto* scope              = llvm::dyn_cast<clang::CompoundStmt>(trigger);
          const clang::SourceLocation at = scope ? scope->getRBracLoc() : trigger->getBeginLoc();
          const std::string name         = var->getNameAsString();
          const std::string t            = type_text(var->getType(), _ctx);
          const std::string what         = var->getType()->isReferenceType()
                                               ? "the temporary " + t + " that " + name + " keeps alive"
                                               : name + " (" + t + ")";
          _out.push_back({CostKind::DESTRUCTOR,
                          _index,
                          span_of({at, at}, _ctx),
                          "~" + name,
                          "The destructor of " + what + " runs here.",
                          "destructor|" + t,
                          false,
                          {}});
        }
      }
    }  // add_destructors

    [[nodiscard]] inline const char* cost_kind_name(const CostKind _kind) {
      switch (_kind) {
        case CostKind::COPY:
          return "copy";
        case CostKind::MOVE:
          return "move";
        case CostKind::CONVERSION:
          return "conversion";
        case CostKind::TEMPORARY:
          return "temporary";
        case CostKind::SHADOW:
          return "shadow";
        case CostKind::DESTRUCTOR:
          return "destructor";
        case CostKind::ALLOCATION:
          return "allocation";
        case CostKind::LOOKUP:
          return "lookup";
        case CostKind::STATE:
          return "state";
      }
      return "copy";
    }  // cost_kind_name
  }  // namespace Detail

  // the instantiations of a template that the hidden c++ analyzes
  inline constexpr size_t cost_max_instantiations = 16;

  namespace Detail {
    // the items of a body, except the shadowed names
    inline void add_body_costs(std::vector<CostItem>& _out, const clang::FunctionDecl& _fn, const int32_t _index,
                               clang::ASTContext& _ctx, const CostOptions& _opts) {
      CostCollector collector(_ctx, _opts, _out, _index, _fn.getBody());
      collector.TraverseStmt(_fn.getBody());
      collector.finish(_fn);
      add_destructors(_out, _fn, _index, _ctx);
    }  // add_body_costs

    // the items of the instantiations of a template that the template does not have. the code of a template that
    // depends on a template parameter has no copies, conversions or destructors. only an instantiation has them, at
    // the positions of the template. the items of more than one instantiation with the same hint show one time
    inline void add_instantiation_costs(std::vector<CostItem>& _out, const size_t _first,
                                        const std::vector<const clang::FunctionDecl*>& _insts, const int32_t _index,
                                        clang::ASTContext& _ctx, const CostOptions& _opts) {
      const auto key = [](const CostItem& _i) -> std::string {
        return std::to_string(int32_t(_i.kind_)) + "|" + std::to_string(_i.at_.loc_.getRawEncoding()) + "|" +
               std::to_string(_i.at_.len_) + "|" + _i.text_;
      };
      std::unordered_set<std::string> known;
      for (size_t i = _first; i < _out.size(); ++i) known.insert(key(_out[i]));

      struct Added {
        CostItem item_;
        std::vector<std::string> names_;  // the instantiations with the item
        bool isSameDetail_ = true;        // all instantiations give the same detail, for example the same types
      };  // Added
      std::vector<Added> added;
      std::unordered_map<std::string, size_t> indexOf;
      for (size_t n = 0; n < std::min(_insts.size(), cost_max_instantiations); ++n) {
        if (!_insts[n]->getBody()) continue;
        std::vector<CostItem> items;
        add_body_costs(items, *_insts[n], _index, _ctx, _opts);
        const std::string name = instantiation_name(*_insts[n], _ctx);
        for (CostItem& item : items) {
          const std::string k = key(item);
          if (known.contains(k)) continue;
          if (const auto it = indexOf.find(k); it != indexOf.end()) {
            Added& a = added[it->second];
            if (!llvm::is_contained(a.names_, name)) a.names_.push_back(name);
            a.isSameDetail_ = a.isSameDetail_ && a.item_.detail_ == item.detail_;
            continue;
          }
          indexOf.emplace(k, added.size());
          added.push_back({std::move(item), {name}});
        }
      }

      for (Added& a : added) {
        const std::vector<std::string>& n = a.names_;
        std::string from;
        if (n.size() == 1)
          from = "the instantiation " + n[0];
        else if (n.size() <= 3)
          from = "the instantiations " + llvm::join(llvm::ArrayRef(n).drop_back(), ", ") + " and " + n.back();
        else
          from = std::to_string(n.size()) + " instantiations, for example " + n[0] + " and " + n[1];
        std::string& detail = a.item_.detail_;
        detail += (detail.empty() ? "" : " ") + std::string("This item comes from ") + from + ".";
        if (!a.isSameDetail_) detail += " The types can be different in each instantiation.";
        _out.push_back(std::move(a.item_));
      }
    }  // add_instantiation_costs
  }  // namespace Detail

  // the hidden c++ of the functions. a template also gets the items of its instantiations
  [[nodiscard]] inline std::vector<CostItem> build_costs(const std::vector<const clang::FunctionDecl*>& _fns,
                                                         const Instantiations& _insts, clang::ASTContext& _ctx,
                                                         const CostOptions& _opts) {
    const auto instantiations_of =
        [&](const clang::FunctionDecl* _f) -> const std::vector<const clang::FunctionDecl*>* {
      const auto it = _insts.find(_f->getCanonicalDecl());
      return it == _insts.end() ? nullptr : &it->second;
    };

    // the mutation analyzer needs the parents in these functions and their instantiations only
    std::vector<const clang::FunctionDecl*> scope_fns = _fns;
    for (const clang::FunctionDecl* f : _fns)
      if (const auto* insts = instantiations_of(f))
        scope_fns.insert(scope_fns.end(), insts->begin(),
                         insts->begin() + std::ptrdiff_t(std::min(insts->size(), cost_max_instantiations)));
    const TraversalScope scope(_ctx, scope_fns);

    std::vector<CostItem> out;
    for (int32_t i = 0; i < int32_t(_fns.size()); ++i) {
      const clang::FunctionDecl& fn = *_fns[i];
      if (!fn.getBody()) continue;
      const size_t first = out.size();
      Detail::add_body_costs(out, fn, i, _ctx, _opts);
      Detail::add_shadows(out, fn, i, _ctx);
      if (const auto* insts = instantiations_of(&fn))
        Detail::add_instantiation_costs(out, first, *insts, i, _ctx, _opts);
    }
    return out;
  }  // build_costs

  // lines start at 1. columns are utf-8 bytes and start at 1
  [[nodiscard]] inline JsonObject cost_to_json(const std::vector<CostItem>& _items,
                                               const std::vector<const clang::FunctionDecl*>& _fns,
                                               const clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    JsonArray items;
    for (const CostItem& i : _items) {
      JsonObject o = Detail::span_to_json(i.at_, sm);
      o["kind"]    = Detail::cost_kind_name(i.kind_);
      o["fn"]      = int64_t(i.fn_);
      o["text"]    = i.text_;
      o["detail"]  = i.detail_;
      o["pattern"] = i.pattern_;
      if (i.isHeuristic_) o["heuristic"] = true;
      if (!i.related_.empty()) {
        JsonArray related;
        for (const Span& s : i.related_) related.push_back(Detail::span_to_json(s, sm));
        o["related"] = std::move(related);
      }
      items.push_back(std::move(o));
    }
    JsonArray fns;
    for (const clang::FunctionDecl* f : _fns) fns.push_back(function_to_json(*f, sm));
    return JsonObject{{"items", std::move(items)}, {"functions", std::move(fns)}};
  }  // cost_to_json

}  // namespace DataFlow
