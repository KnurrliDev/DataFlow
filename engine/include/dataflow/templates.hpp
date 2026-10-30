#pragma once

#include <dataflow/analysis.hpp>

/*
  Helpers for the code of templates. In a template, clang does not resolve an expression that depends on a template
  parameter: a member access gives a CXXDependentScopeMemberExpr, and a call gives no callee. The engine analyzes the
  template itself, because a header-only library often has no instantiation in its own translation unit. These helpers
  find the declarations that the name lookup of the template finds:
    > the class of a dependent type: the pattern of a class template, also through an alias template or a nested class
    > a data member or the member functions of that class, also in its bases
    > the candidates of a call: the functions of the overload set of the name that take the number of arguments
  The mutation analyzer of clang reports each operand of a dependent operator and each argument of an unresolved call
  as a possible change. is_template_read checks these reports with the declarations of the candidates.
*/

namespace DataFlow {

  namespace Detail {
    // the class of a type in a template: a class, the pattern of a class template, or a nested class of such a
    // pattern. with _isArrow, the type is a pointer to the class. null for a template parameter and other types
    [[nodiscard]] inline const clang::CXXRecordDecl* class_of_type(clang::QualType _t, const bool _isArrow,
                                                                   const int32_t _depth = 0) {
      if (_t.isNull() || _depth > 8) return nullptr;
      _t = _t.getNonReferenceType();
      if (_isArrow) {
        const auto* p = _t->getAs<clang::PointerType>();
        if (!p) return nullptr;  // operator-> of a class, for example of std::unique_ptr
        _t = p->getPointeeType();
      }
      const auto definition = [](const clang::CXXRecordDecl* _rd) -> const clang::CXXRecordDecl* {
        return _rd && _rd->hasDefinition() ? _rd->getDefinition() : _rd;
      };
      if (const clang::CXXRecordDecl* rd = _t->getAsCXXRecordDecl()) return definition(rd);
      if (const auto* tst = _t->getAs<clang::TemplateSpecializationType>()) {
        if (tst->isTypeAlias()) return class_of_type(tst->getAliasedType(), false, _depth + 1);
        const auto* ct = llvm::dyn_cast_or_null<clang::ClassTemplateDecl>(tst->getTemplateName().getAsTemplateDecl());
        return ct ? definition(ct->getTemplatedDecl()) : nullptr;
      }
      if (const auto* dn = _t->getAs<clang::DependentNameType>()) {
        const clang::NestedNameSpecifier q = dn->getQualifier();
        if (q.getKind() != clang::NestedNameSpecifier::Kind::Type) return nullptr;
        const clang::CXXRecordDecl* outer = class_of_type(clang::QualType(q.getAsType(), 0), false, _depth + 1);
        if (!outer) return nullptr;
        for (const clang::NamedDecl* d : outer->lookup(dn->getIdentifier())) {
          if (const auto* rd = llvm::dyn_cast<clang::CXXRecordDecl>(d)) return definition(rd);
          if (const auto* td = llvm::dyn_cast<clang::TypedefNameDecl>(d))
            return class_of_type(td->getUnderlyingType(), false, _depth + 1);
        }
      }
      return nullptr;
    }  // class_of_type

    // the declarations of a member name in a class. if the class has none, the declarations in its bases
    inline void lookup_member(const clang::CXXRecordDecl* _rd, const clang::DeclarationName _name,
                              std::vector<const clang::NamedDecl*>& _out, const int32_t _depth = 0) {
      if (!_rd || _name.isEmpty() || _depth > 8) return;
      const size_t before = _out.size();
      for (const clang::NamedDecl* d : _rd->lookup(_name)) _out.push_back(d->getUnderlyingDecl());
      if (_out.size() > before || !_rd->hasDefinition()) return;  // a name in the class hides the names of its bases
      for (const clang::CXXBaseSpecifier& b : _rd->getDefinition()->bases())
        lookup_member(class_of_type(b.getType(), false), _name, _out, _depth + 1);
    }  // lookup_member

    // the declarations of the member of an access in a template whose object has a dependent type
    [[nodiscard]] inline std::vector<const clang::NamedDecl*> dependent_members(
        const clang::CXXDependentScopeMemberExpr* _e) {
      std::vector<const clang::NamedDecl*> out;
      if (_e) lookup_member(class_of_type(_e->getBaseType(), _e->isArrow()), _e->getMember(), out);
      return out;
    }  // dependent_members

    // the data member of an access in a template whose object has a dependent type, for example _b.vals_ with _b of
    // type Bucket<T, N>&. null if the name is not a data member of the class or of its bases
    [[nodiscard]] inline const clang::FieldDecl* dependent_field(const clang::CXXDependentScopeMemberExpr* _e) {
      for (const clang::NamedDecl* d : dependent_members(_e))
        if (const auto* f = llvm::dyn_cast<clang::FieldDecl>(d)) return f;
      return nullptr;
    }  // dependent_field

    // the member functions of an access in a template whose object has a dependent type, for example front for
    // _b.vals_.front(). empty if the name is not a member function of the class or of its bases
    [[nodiscard]] inline std::vector<const clang::CXXMethodDecl*> dependent_methods(
        const clang::CXXDependentScopeMemberExpr* _e) {
      std::vector<const clang::CXXMethodDecl*> out;
      for (const clang::NamedDecl* d : dependent_members(_e)) {
        if (const auto* t = llvm::dyn_cast<clang::FunctionTemplateDecl>(d)) d = t->getTemplatedDecl();
        if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(d)) out.push_back(m);
      }
      return out;
    }  // dependent_methods

    // the callee of a call of front(), back(), at() or value() on an object of a dependent type. these accessors give
    // an element or the value of the object. null for other calls
    [[nodiscard]] inline const clang::CXXDependentScopeMemberExpr* dependent_accessor(const clang::CallExpr* _c) {
      const clang::Expr* callee =
          _c && !_c->getDirectCallee() && _c->getCallee() ? _c->getCallee()->IgnoreParenImpCasts() : nullptr;
      const auto* d                     = llvm::dyn_cast_or_null<clang::CXXDependentScopeMemberExpr>(callee);
      const clang::IdentifierInfo* name = d && !d->isImplicitAccess() ? d->getMember().getAsIdentifierInfo() : nullptr;
      return name && llvm::is_contained({"front", "back", "at", "value"}, name->getName()) ? d : nullptr;
    }  // dependent_accessor

    // the type of the parameter that gets the argument _arg. a pack gives the pattern of its type, for example T&& for
    // Ts&&... null for an argument of a c variadic function or for too many arguments
    [[nodiscard]] inline clang::QualType param_type_of(const clang::FunctionDecl* _fn, const uint32_t _arg) {
      const uint32_t n = _fn->getNumParams();
      for (uint32_t i = 0; i < n; ++i) {
        const clang::ParmVarDecl* p = _fn->getParamDecl(i);
        if (p->isParameterPack() && i <= _arg) {
          const clang::QualType t = p->getType();
          const auto* pack        = t->getAs<clang::PackExpansionType>();
          return pack ? pack->getPattern() : t;
        }
        if (i == _arg) return p->getType();
      }
      return {};
    }  // param_type_of

    // true if a function can take _args arguments
    [[nodiscard]] inline bool takes_args(const clang::FunctionDecl* _fn, const uint32_t _args) {
      if (_args < _fn->getMinRequiredArguments()) return false;
      if (_args <= _fn->getNumParams() || _fn->isVariadic()) return true;
      return _fn->getNumParams() > 0 && _fn->getParamDecl(_fn->getNumParams() - 1)->isParameterPack();
    }  // takes_args

    // adds the namespaces of a type for an argument dependent lookup: the namespace of its class or of its class
    // template, and the namespaces of its template arguments. for example std and MQT2::Detail for
    // std::vector<Detail::Bucket<T, N>>
    inline void add_namespaces(clang::QualType _t, std::vector<const clang::DeclContext*>& _out,
                               const int32_t _depth = 0) {
      if (_t.isNull() || _depth > 6) return;
      _t = _t.getNonReferenceType();
      while (const auto* p = _t->getAs<clang::PointerType>()) _t = p->getPointeeType();
      const auto add = [&](const clang::Decl* _d) -> void {
        const clang::DeclContext* ns = _d ? _d->getDeclContext()->getEnclosingNamespaceContext() : nullptr;
        if (ns && !llvm::is_contained(_out, ns)) _out.push_back(ns);
      };
      if (const auto* tst = _t->getAs<clang::TemplateSpecializationType>()) {
        add(tst->getTemplateName().getAsTemplateDecl());
        for (const clang::TemplateArgument& a : tst->template_arguments())
          if (a.getKind() == clang::TemplateArgument::Type) add_namespaces(a.getAsType(), _out, _depth + 1);
        return;
      }
      if (const clang::TagDecl* tag = _t->getAsTagDecl()) {
        add(tag);
        if (const auto* spec = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(tag))
          for (const clang::TemplateArgument& a : spec->getTemplateArgs().asArray())
            if (a.getKind() == clang::TemplateArgument::Type) add_namespaces(a.getAsType(), _out, _depth + 1);
      }
    }  // add_namespaces

    // true if a class has a constructor that can convert one argument, for example std::string from const char*
    [[nodiscard]] inline bool has_converting_ctor(const clang::CXXRecordDecl* _rd) {
      if (!_rd || !_rd->hasDefinition()) return true;  // unknown
      for (const clang::Decl* d : _rd->decls()) {
        if (const auto* t = llvm::dyn_cast<clang::FunctionTemplateDecl>(d)) d = t->getTemplatedDecl();
        const auto* c = llvm::dyn_cast<clang::CXXConstructorDecl>(d);
        if (c && !c->isExplicit() && !c->isCopyOrMoveConstructor() && c->getNumParams() >= 1 &&
            c->getMinRequiredArguments() <= 1)
          return true;
      }
      return false;
    }  // has_converting_ctor

    // how well an argument with no dependent type fits a parameter: 2 for the same type, 1 for a standard conversion
    // or a base class, 0 for a parameter of a dependent type or a conversion that the engine cannot check, -1 if the
    // parameter cannot take the argument
    [[nodiscard]] inline int32_t argument_fit(const clang::QualType _param, const clang::Expr* _arg,
                                              const clang::ASTContext& _ctx) {
      if (_param.isNull() || _param->isDependentType() || !_arg || _arg->isTypeDependent() ||
          _arg->getType().isNull() || llvm::isa<clang::InitListExpr>(_arg->IgnoreParens()))
        return 0;

      // a reference to non-const takes an lvalue of the same type or of a derived class. a reference to an rvalue
      // takes no lvalue
      const clang::QualType p = _param.getNonReferenceType().getCanonicalType();
      clang::QualType a       = _arg->getType().getNonReferenceType().getCanonicalType();
      const bool isRefToVar   = _param->isLValueReferenceType() && !p.isConstQualified();
      if ((isRefToVar && !_arg->isLValue()) || (_param->isRValueReferenceType() && _arg->isLValue())) return -1;
      if (_ctx.hasSameUnqualifiedType(p, a)) return 2;

      const auto* prd      = p->getAsCXXRecordDecl();
      const auto* ard      = a->getAsCXXRecordDecl();
      const bool isDerived = prd && ard && ard->hasDefinition() && prd->hasDefinition() && ard->isDerivedFrom(prd);
      if (isRefToVar) return isDerived ? 1 : -1;

      // an array or a function becomes a pointer
      if (a->isArrayType())
        a = _ctx.getPointerType(_ctx.getAsArrayType(a)->getElementType()).getCanonicalType();
      else if (a->isFunctionType())
        a = _ctx.getPointerType(a).getCanonicalType();
      if (_ctx.hasSameUnqualifiedType(p, a)) return 2;

      // a class: a derived class, a converting constructor, or a conversion function of the argument
      const bool hasConversionFunction =
          ard && (!ard->hasDefinition() ||
                  ard->getVisibleConversionFunctions().begin() != ard->getVisibleConversionFunctions().end());
      if (prd) {
        if (isDerived) return 1;
        return has_converting_ctor(prd) || hasConversionFunction ? 0 : -1;
      }
      if (ard) return hasConversionFunction ? 0 : -1;

      // an enum takes only its own type. an unscoped enum converts to a number
      if (p->isEnumeralType()) return -1;
      if (a->isScopedEnumeralType()) return -1;

      // numbers, pointers and bool
      if (p->isPointerType() || p->isMemberPointerType()) {
        if (a->isNullPtrType() ||
            _arg->isNullPointerConstant(const_cast<clang::ASTContext&>(_ctx), clang::Expr::NPC_ValueDependentIsNotNull))
          return 1;
        if (!a->isPointerType()) return -1;
        const clang::QualType pp = p->getPointeeType();
        const clang::QualType ap = a->getPointeeType();
        if (_ctx.hasSameUnqualifiedType(pp, ap)) return pp.isAtLeastAsQualifiedAs(ap, _ctx) ? 2 : -1;
        if (pp->isVoidType()) return 1;
        const auto* ppd = pp->getAsCXXRecordDecl();
        const auto* apd = ap->getAsCXXRecordDecl();
        return ppd && apd && ppd->hasDefinition() && apd->hasDefinition() && apd->isDerivedFrom(ppd) ? 1 : -1;
      }
      if (p->isBooleanType() && (a->isPointerType() || a->isNullPtrType())) return 1;
      if (p->isArithmeticType() && a->isArithmeticType()) return 1;
      return a->isPointerType() || a->isNullPtrType() ? -1 : 0;
    }  // argument_fit

    // the functions that a call can call. a call with a callee gives the callee. in a template, a call with a
    // dependent argument or object has no callee. then the candidates are the functions that the name lookup of the
    // template finds and that take the number of arguments of the call. a name with no namespace also gets the
    // functions of the namespaces of the arguments, as the argument dependent lookup of the instantiation does.
    // the arguments with no dependent type sort the candidates: a candidate that cannot take one of them goes away,
    // and the best fit comes first
    [[nodiscard]] inline std::vector<const clang::FunctionDecl*> call_candidates(const clang::CallExpr* _c) {
      std::vector<const clang::FunctionDecl*> out;
      if (!_c) return out;
      if (const clang::FunctionDecl* fn = _c->getDirectCallee()) {
        out.push_back(fn);
        return out;
      }
      const clang::Expr* callee = _c->getCallee() ? _c->getCallee()->IgnoreParenImpCasts() : nullptr;
      std::vector<const clang::NamedDecl*> found;
      if (const auto* o = llvm::dyn_cast_or_null<clang::OverloadExpr>(callee))
        for (const clang::NamedDecl* d : o->decls()) found.push_back(d->getUnderlyingDecl());
      else if (const auto* d = llvm::dyn_cast_or_null<clang::CXXDependentScopeMemberExpr>(callee))
        found = dependent_members(d);
      if (const auto* u = llvm::dyn_cast_or_null<clang::UnresolvedLookupExpr>(callee); u && u->requiresADL()) {
        std::vector<const clang::DeclContext*> spaces;
        for (const clang::Expr* a : _c->arguments()) add_namespaces(a->getType(), spaces);
        for (const clang::DeclContext* ns : spaces)
          for (const clang::NamedDecl* d : ns->lookup(u->getName()))
            if (!llvm::is_contained(found, d->getUnderlyingDecl())) found.push_back(d->getUnderlyingDecl());
      }

      // an operator call has the object of a member operator as its first argument
      const uint32_t args = _c->getNumArgs();
      std::vector<std::pair<int32_t, const clang::FunctionDecl*>> ranked;  // the fit and the candidate
      for (const clang::NamedDecl* d : found) {
        if (const auto* t = llvm::dyn_cast<clang::FunctionTemplateDecl>(d)) d = t->getTemplatedDecl();
        const auto* fn = llvm::dyn_cast<clang::FunctionDecl>(d);
        if (!fn) continue;
        const bool isMemberOperator = llvm::isa<clang::CXXOperatorCallExpr>(_c) && llvm::isa<clang::CXXMethodDecl>(fn);
        const uint32_t first        = isMemberOperator && args > 0 ? 1 : 0;
        if (!takes_args(fn, args - first)) continue;

        int32_t fit = 0;
        for (uint32_t i = first; i < args && fit >= 0; ++i) {
          const int32_t f = argument_fit(param_type_of(fn, i - first), _c->getArg(i), fn->getASTContext());
          fit             = f < 0 ? -1 : fit + f;
        }
        ranked.emplace_back(fit, fn);
      }

      // with no candidate that fits, the engine keeps all of them
      if (llvm::any_of(ranked, [](const auto& _r) -> bool { return _r.first >= 0; }))
        std::erase_if(ranked, [](const auto& _r) -> bool { return _r.first < 0; });
      std::stable_sort(ranked.begin(), ranked.end(),
                       [](const auto& _a, const auto& _b) -> bool { return _a.first > _b.first; });
      for (const auto& [fit, fn] : ranked) out.push_back(fn);
      return out;
    }  // call_candidates

    // the function of a call: the callee, or in a template the candidate with the best fit. null if there is none
    [[nodiscard]] inline const clang::FunctionDecl* called_function(const clang::CallExpr* _c) {
      const std::vector<const clang::FunctionDecl*> fns = call_candidates(_c);
      return fns.empty() ? nullptr : fns.front();
    }  // called_function

    // the data member of the pattern of a class template for a data member of one of its specializations, for example
    // Bucket::isFlat_ for Bucket<float, 10>::isFlat_. thus the accesses in the template and the accesses in the code
    // that uses a specialization have the same member. a member of an explicit specialization stays
    [[nodiscard]] inline const clang::FieldDecl* pattern_field(const clang::FieldDecl* _f) {
      const auto* rd = _f ? llvm::dyn_cast<clang::CXXRecordDecl>(_f->getParent()) : nullptr;
      if (!rd || !_f->getIdentifier()) return _f;
      const clang::CXXRecordDecl* pattern = rd->getInstantiatedFromMemberClass();
      if (const auto* spec = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(rd)) {
        if (spec->getSpecializationKind() == clang::TSK_ExplicitSpecialization) return _f;
        const auto from = spec->getSpecializedTemplateOrPartial();
        if (const auto* p = llvm::dyn_cast_if_present<clang::ClassTemplatePartialSpecializationDecl*>(from))
          pattern = p;
        else if (const auto* t = llvm::dyn_cast_if_present<clang::ClassTemplateDecl*>(from))
          pattern = t->getTemplatedDecl();
      }
      if (!pattern) return _f;
      for (const clang::NamedDecl* d : pattern->lookup(_f->getDeclName()))
        if (const auto* f = llvm::dyn_cast<clang::FieldDecl>(d)) return f;
      return _f;
    }  // pattern_field

    // true for the type of a parameter that the function can change its argument through: a reference to non-const, a
    // forwarding reference or a pointer to non-const
    [[nodiscard]] inline bool is_changing_type(const clang::QualType _t) {
      if (_t.isNull()) return true;
      if (_t->isLValueReferenceType()) return !_t.getNonReferenceType().isConstQualified();
      if (_t->isRValueReferenceType()) return true;  // a forwarding reference can bind an lvalue
      if (_t->isPointerType()) return !_t->getPointeeType().isConstQualified();
      return false;  // a copy
    }  // is_changing_type

    // true if _e is the expression _of, or a data member or an element of it, for example _b.vals_[k] of _b
    [[nodiscard]] inline bool is_part_of(const clang::Expr* _e, const clang::Expr* _of) {
      for (int32_t i = 0; _e && i < 16; ++i) {
        _e = _e->IgnoreParenImpCasts();
        if (_e == _of) return true;
        if (const auto* m = llvm::dyn_cast<clang::MemberExpr>(_e))
          _e = m->getBase();
        else if (const auto* d = llvm::dyn_cast<clang::CXXDependentScopeMemberExpr>(_e))
          _e = d->isImplicitAccess() ? nullptr : d->getBase();
        else if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(_e))
          _e = a->getBase();
        else
          return false;
      }
      return false;
    }  // is_part_of

    // true if _e is the index of a subscript in the statement, for example k in _b.vals_[k] = x
    [[nodiscard]] inline bool is_index_in(const clang::Stmt* _s, const clang::Expr* _e, const int32_t _depth = 0) {
      if (!_s || _depth > 12) return false;
      if (const auto* a = llvm::dyn_cast<clang::ArraySubscriptExpr>(_s); a && a->getIdx()->IgnoreParenImpCasts() == _e)
        return true;
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(_s);
          op && op->getOperator() == clang::OO_Subscript && op->getNumArgs() == 2 &&
          op->getArg(1)->IgnoreParenImpCasts() == _e)
        return true;
      for (const clang::Stmt* child : _s->children())
        if (is_index_in(child, _e, _depth + 1)) return true;
      return false;
    }  // is_index_in

    // true if the change that the mutation analyzer of clang reports for _e is a read in a template: the index of a
    // subscript, an operand of a dependent operator that is not an assignment, an argument of a dependent
    // construction, an argument of an unresolved call that no candidate can change, or the object of an unresolved
    // call of const member functions. the analyzer cannot resolve these, so it reports each one as a possible change
    [[nodiscard]] inline bool is_template_read(const clang::Stmt* _m, const clang::Expr* _e) {
      if (!_m || !_e) return false;
      const clang::Expr* e = _e->IgnoreParenImpCasts();
      const auto is        = [&](const clang::Expr* _x) -> bool { return is_part_of(_x, e); };
      if (is_index_in(_m, e)) return true;

      if (const auto* b = llvm::dyn_cast<clang::BinaryOperator>(_m);
          b && b->isTypeDependent() && !b->isAssignmentOp()) {
        if (is(b->getRHS())) return true;
        return is(b->getLHS()) && b->getOpcode() != clang::BO_Shl && b->getOpcode() != clang::BO_Shr;  // a stream
      }
      if (const auto* u = llvm::dyn_cast<clang::CXXUnresolvedConstructExpr>(_m))
        return llvm::any_of(u->arguments(), is);

      const auto* call = llvm::dyn_cast<clang::CallExpr>(_m);
      if (!call || call->getDirectCallee()) return false;

      // a dependent operator. the right operand is a read, and the left operand of an operator that does not change
      if (const auto* op = llvm::dyn_cast<clang::CXXOperatorCallExpr>(call)) {
        if (op->getNumArgs() == 0) return false;
        const clang::OverloadedOperatorKind k = op->getOperator();
        if (!is(op->getArg(0))) return llvm::any_of(llvm::drop_begin(op->arguments()), is);
        if (op->getNumArgs() == 1 && (k == clang::OO_Star || k == clang::OO_Amp)) return false;  // *p and &x
        return !op->isAssignmentOp() && k != clang::OO_PlusPlus && k != clang::OO_MinusMinus &&
               k != clang::OO_LessLess && k != clang::OO_GreaterGreater && k != clang::OO_Call &&
               k != clang::OO_Subscript && k != clang::OO_Arrow;
      }

      const std::vector<const clang::FunctionDecl*> fns = call_candidates(call);
      if (fns.empty()) return false;

      // the object of a member function: all candidates are const
      const clang::Expr* callee = call->getCallee() ? call->getCallee()->IgnoreParenImpCasts() : nullptr;
      const clang::Expr* object = nullptr;
      if (const auto* d = llvm::dyn_cast_or_null<clang::CXXDependentScopeMemberExpr>(callee))
        object = d->isImplicitAccess() ? nullptr : d->getBase();
      else if (const auto* u = llvm::dyn_cast_or_null<clang::UnresolvedMemberExpr>(callee))
        object = u->isImplicitAccess() ? nullptr : u->getBase();
      if (object && is(object))
        return llvm::all_of(fns, [](const clang::FunctionDecl* _f) -> bool {
          const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(_f);
          return m && m->isConst();
        });

      // an argument: no candidate takes it by a reference to non-const or by a pointer to non-const
      for (uint32_t i = 0; i < call->getNumArgs(); ++i) {
        if (!is(call->getArg(i))) continue;
        return llvm::none_of(fns, [&](const clang::FunctionDecl* _f) -> bool {
          const clang::QualType t = param_type_of(_f, i);
          return t.isNull() ? !_f->isVariadic() : is_changing_type(t);
        });
      }
      return false;
    }  // is_template_read
  }  // namespace Detail

}  // namespace DataFlow
