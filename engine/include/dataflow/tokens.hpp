#pragma once

#include <dataflow/analysis.hpp>

/*
  The tokens of the main file for the side view
    > the raw lexer of clang gives the tokens, also the comments and the preprocessor directives
    > an ast visitor gives the semantic kind of each name: namespaces, types, functions, variables, parameters, fields
    > a dependent name in a template has no declaration. its use gives the kind: a call, a member or a type
    > a name in a macro argument, or in the body of a macro of this file, gets the kind of its expansion
    > a name that the ast does not know and that is a macro gets the kind macro
    > a name in an attribute is an attribute, for example nodiscard in [[nodiscard]]. a name before :: is a namespace
    > the words after #pragma are one kind. the parameters of a macro are parameters, also in the body of the macro
    > a round, square or curly bracket gets its level of nesting, for the colors of the bracket pairs. it also gets
      its level among the brackets of its type, for the setting of vs code that gives each type its own colors
  The kinds of the names are the semantic token types of VS Code, so the extension can find their colors in the color
  theme. A keyword gets a group: control, type, modifier, constant, this or other.
*/

namespace DataFlow {

  enum class TokenKind : uint8_t {
    COMMENT,
    STRING,
    NUMBER,
    OPERATOR,
    PUNCTUATION,
    PREPROCESSOR,
    KEYWORD,
    KEYWORD_CONTROL,
    KEYWORD_TYPE,
    KEYWORD_MODIFIER,
    KEYWORD_CONSTANT,
    KEYWORD_THIS,
    NAMESPACE,
    CLASS,
    ENUM,
    ENUM_MEMBER,
    TYPE,
    TYPE_PARAMETER,
    FUNCTION,
    METHOD,
    PARAMETER,
    VARIABLE,
    PROPERTY,
    MACRO,
    LABEL,
    BRACKET,
    ATTRIBUTE,
    PRAGMA,
    COUNT
  };

  // the modifiers of a token, as bits
  constexpr uint32_t mod_declaration    = 1 << 0;
  constexpr uint32_t mod_readonly       = 1 << 1;
  constexpr uint32_t mod_static         = 1 << 2;
  constexpr uint32_t mod_library        = 1 << 3;  // a name from a system header, for example from the standard library

  // a bracket has its level of nesting in the place of the modifiers. a closing bracket that does not close the last
  // open bracket has this value
  constexpr uint32_t bracket_unexpected = UINT32_MAX;

  struct FileToken {
    uint32_t offset_     = 0;
    uint32_t len_        = 0;
    TokenKind kind_      = TokenKind::OPERATOR;
    uint16_t type_level_ = 0;  // a bracket: the level of nesting among the brackets of its type
    uint32_t mods_       = 0;
  };  // FileToken

  // the tokens of the main file of one parse
  struct FileTokens {
    std::string text_;
    std::vector<uint32_t> line_starts_;  // the offset of the first byte of each line
    std::vector<FileToken> tokens_;      // in the sequence of the file
  };  // FileTokens

  namespace Detail {
    // the name of a kind in the protocol
    [[nodiscard]] inline const char* token_kind_name(const TokenKind _kind) {
      switch (_kind) {
        case TokenKind::COMMENT:
          return "comment";
        case TokenKind::STRING:
          return "string";
        case TokenKind::NUMBER:
          return "number";
        case TokenKind::OPERATOR:
          return "operator";
        case TokenKind::PUNCTUATION:
          return "punctuation";
        case TokenKind::PREPROCESSOR:
          return "preprocessor";
        case TokenKind::KEYWORD:
          return "keyword";
        case TokenKind::KEYWORD_CONTROL:
          return "keyword.control";
        case TokenKind::KEYWORD_TYPE:
          return "keyword.type";
        case TokenKind::KEYWORD_MODIFIER:
          return "keyword.modifier";
        case TokenKind::KEYWORD_CONSTANT:
          return "keyword.constant";
        case TokenKind::KEYWORD_THIS:
          return "keyword.this";
        case TokenKind::NAMESPACE:
          return "namespace";
        case TokenKind::CLASS:
          return "class";
        case TokenKind::ENUM:
          return "enum";
        case TokenKind::ENUM_MEMBER:
          return "enumMember";
        case TokenKind::TYPE:
          return "type";
        case TokenKind::TYPE_PARAMETER:
          return "typeParameter";
        case TokenKind::FUNCTION:
          return "function";
        case TokenKind::METHOD:
          return "method";
        case TokenKind::PARAMETER:
          return "parameter";
        case TokenKind::VARIABLE:
          return "variable";
        case TokenKind::PROPERTY:
          return "property";
        case TokenKind::MACRO:
          return "macro";
        case TokenKind::LABEL:
          return "label";
        case TokenKind::BRACKET:
          return "bracket";
        case TokenKind::ATTRIBUTE:
          return "attribute";
        case TokenKind::PRAGMA:
          return "pragma";
        case TokenKind::COUNT:
          break;
      }
      return "operator";
    }  // token_kind_name

    // the group of a keyword, for the colors of the theme
    [[nodiscard]] inline TokenKind keyword_kind(const clang::tok::TokenKind _k) {
      switch (_k) {
        case clang::tok::kw_if:
        case clang::tok::kw_else:
        case clang::tok::kw_for:
        case clang::tok::kw_while:
        case clang::tok::kw_do:
        case clang::tok::kw_switch:
        case clang::tok::kw_case:
        case clang::tok::kw_default:
        case clang::tok::kw_break:
        case clang::tok::kw_continue:
        case clang::tok::kw_return:
        case clang::tok::kw_goto:
        case clang::tok::kw_try:
        case clang::tok::kw_catch:
        case clang::tok::kw_throw:
        case clang::tok::kw_co_await:
        case clang::tok::kw_co_return:
        case clang::tok::kw_co_yield:
          return TokenKind::KEYWORD_CONTROL;
        case clang::tok::kw_void:
        case clang::tok::kw_bool:
        case clang::tok::kw_char:
        case clang::tok::kw_wchar_t:
        case clang::tok::kw_char8_t:
        case clang::tok::kw_char16_t:
        case clang::tok::kw_char32_t:
        case clang::tok::kw_short:
        case clang::tok::kw_int:
        case clang::tok::kw_long:
        case clang::tok::kw_float:
        case clang::tok::kw_double:
        case clang::tok::kw_signed:
        case clang::tok::kw_unsigned:
        case clang::tok::kw_auto:
          return TokenKind::KEYWORD_TYPE;
        case clang::tok::kw_const:
        case clang::tok::kw_constexpr:
        case clang::tok::kw_consteval:
        case clang::tok::kw_constinit:
        case clang::tok::kw_static:
        case clang::tok::kw_inline:
        case clang::tok::kw_virtual:
        case clang::tok::kw_explicit:
        case clang::tok::kw_extern:
        case clang::tok::kw_mutable:
        case clang::tok::kw_volatile:
        case clang::tok::kw_friend:
        case clang::tok::kw_thread_local:
        case clang::tok::kw_register:
        case clang::tok::kw_noexcept:
          return TokenKind::KEYWORD_MODIFIER;
        case clang::tok::kw_true:
        case clang::tok::kw_false:
        case clang::tok::kw_nullptr:
          return TokenKind::KEYWORD_CONSTANT;
        case clang::tok::kw_this:
          return TokenKind::KEYWORD_THIS;
        default:
          return TokenKind::KEYWORD;
      }
    }  // keyword_kind

    // the semantic kind of a declaration. nothing for a declaration with no color. a template gives the kind of the
    // declaration in it, so the caller passes that declaration
    [[nodiscard]] inline std::optional<TokenKind> name_kind(const clang::NamedDecl* _d) {
      if (llvm::isa<clang::ConceptDecl>(_d)) return TokenKind::TYPE;
      if (llvm::isa<clang::TemplateTypeParmDecl, clang::TemplateTemplateParmDecl, clang::NonTypeTemplateParmDecl>(_d))
        return TokenKind::TYPE_PARAMETER;
      if (llvm::isa<clang::NamespaceBaseDecl>(_d)) return TokenKind::NAMESPACE;
      if (llvm::isa<clang::CXXConstructorDecl, clang::CXXDestructorDecl, clang::CXXDeductionGuideDecl>(_d))
        return TokenKind::CLASS;
      if (llvm::isa<clang::CXXMethodDecl>(_d)) return TokenKind::METHOD;
      if (llvm::isa<clang::FunctionDecl>(_d)) return TokenKind::FUNCTION;
      if (llvm::isa<clang::EnumDecl>(_d)) return TokenKind::ENUM;
      if (llvm::isa<clang::RecordDecl>(_d)) return TokenKind::CLASS;
      if (llvm::isa<clang::TypedefNameDecl>(_d)) return TokenKind::TYPE;
      if (llvm::isa<clang::EnumConstantDecl>(_d)) return TokenKind::ENUM_MEMBER;
      if (llvm::isa<clang::FieldDecl, clang::IndirectFieldDecl>(_d)) return TokenKind::PROPERTY;
      if (llvm::isa<clang::ParmVarDecl>(_d)) return TokenKind::PARAMETER;
      if (llvm::isa<clang::VarDecl, clang::BindingDecl>(_d)) return TokenKind::VARIABLE;
      if (llvm::isa<clang::LabelDecl>(_d)) return TokenKind::LABEL;
      return std::nullopt;
    }  // name_kind

    [[nodiscard]] inline uint32_t name_mods(const clang::NamedDecl* _d, const clang::SourceManager& _sm) {
      uint32_t out = _sm.isInSystemHeader(_d->getLocation()) ? mod_library : 0;
      if (const auto* v = llvm::dyn_cast<clang::VarDecl>(_d)) {
        if (v->isConstexpr() || v->getType().getNonReferenceType().isConstQualified()) out |= mod_readonly;
        if (v->isStaticLocal() || v->isStaticDataMember()) out |= mod_static;
      }
      if (const auto* f = llvm::dyn_cast<clang::FieldDecl>(_d); f && f->getType().isConstQualified())
        out |= mod_readonly;
      if (llvm::isa<clang::EnumConstantDecl>(_d)) out |= mod_readonly;
      if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(_d); m && m->isStatic()) out |= mod_static;
      return out;
    }  // name_mods

    // the semantic kinds of the names of the main file, by the file offset of the name
    class NameClassifier : public clang::RecursiveASTVisitor<NameClassifier> {
      using Base = clang::RecursiveASTVisitor<NameClassifier>;

      const clang::SourceManager& sm_;
      std::unordered_map<uint32_t, std::pair<TokenKind, uint32_t>>& out_;

     public:
      NameClassifier(const clang::SourceManager& _sm,
                     std::unordered_map<uint32_t, std::pair<TokenKind, uint32_t>>& _out)
          : sm_(_sm), out_(_out) {}

      bool VisitNamedDecl(clang::NamedDecl* _d) {
        if (!_d->isImplicit()) add(_d->getLocation(), _d, mod_declaration);
        return true;
      }

      bool VisitUsingDecl(clang::UsingDecl* _d) {
        if (_d->shadow_size() > 0) add(_d->getLocation(), (*_d->shadow_begin())->getTargetDecl(), 0);
        return true;
      }

      bool VisitUsingDirectiveDecl(clang::UsingDirectiveDecl* _d) {
        add(_d->getIdentLocation(), _d->getNominatedNamespaceAsWritten(), 0);
        return true;
      }

      bool VisitNamespaceAliasDecl(clang::NamespaceAliasDecl* _d) {
        add(_d->getTargetNameLoc(), _d->getAliasedNamespace(), 0);
        return true;
      }

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        add(_e->getLocation(), _e->getDecl(), 0);
        return true;
      }

      bool VisitMemberExpr(clang::MemberExpr* _e) {
        add(_e->getMemberLoc(), _e->getMemberDecl(), 0);
        return true;
      }

      // an overloaded name in a template. the first candidate gives the kind
      bool VisitOverloadExpr(clang::OverloadExpr* _e) {
        if (_e->getNumDecls() > 0) add(_e->getNameLoc(), (*_e->decls_begin())->getUnderlyingDecl(), 0);
        return true;
      }

      // a dependent name in a template has no declaration. a call gives a function or a method, the call comes first
      bool VisitCallExpr(clang::CallExpr* _e) {
        const clang::Expr* callee = _e->getCallee() ? _e->getCallee()->IgnoreParenImpCasts() : nullptr;
        if (const auto* m = llvm::dyn_cast_or_null<clang::CXXDependentScopeMemberExpr>(callee))
          add_kind(m->getMemberLoc(), TokenKind::METHOD, 0);
        else if (const auto* u = llvm::dyn_cast_or_null<clang::UnresolvedLookupExpr>(callee);
                 u && u->getNumDecls() == 0)
          add_kind(u->getNameLoc(), TokenKind::FUNCTION, 0);
        else if (const auto* d = llvm::dyn_cast_or_null<clang::DependentScopeDeclRefExpr>(callee))
          add_kind(d->getLocation(), TokenKind::FUNCTION, 0);
        return true;
      }

      bool VisitCXXDependentScopeMemberExpr(clang::CXXDependentScopeMemberExpr* _e) {
        add_kind(_e->getMemberLoc(), TokenKind::PROPERTY, 0);
        return true;
      }

      // a dependent name with a qualifier that is not a call, for example size in reflect<T>::size. it is usually a
      // static data member
      bool VisitDependentScopeDeclRefExpr(clang::DependentScopeDeclRefExpr* _e) {
        add_kind(_e->getLocation(), TokenKind::PROPERTY, mod_static);
        return true;
      }

      bool VisitSizeOfPackExpr(clang::SizeOfPackExpr* _e) {
        add(_e->getPackLoc(), _e->getPack(), 0);
        return true;
      }

      bool VisitDesignatedInitExpr(clang::DesignatedInitExpr* _e) {
        for (const clang::DesignatedInitExpr::Designator& d : _e->designators())
          if (d.isFieldDesignator()) add(d.getFieldLoc(), d.getFieldDecl(), 0);
        return true;
      }

      bool VisitConceptReference(clang::ConceptReference* _cr) {
        add(_cr->getConceptNameLoc(), _cr->getNamedConcept(), 0);
        return true;
      }

      bool VisitTypeLoc(clang::TypeLoc _tl) {
        if (const auto t = _tl.getAs<clang::TagTypeLoc>())
          add(t.getNameLoc(), t.getDecl(), 0);
        else if (const auto t = _tl.getAs<clang::TypedefTypeLoc>())
          add(t.getNameLoc(), t.getDecl(), 0);
        else if (const auto t = _tl.getAs<clang::UsingTypeLoc>())
          add(t.getNameLoc(), t.getDecl()->getTargetDecl(), 0);
        else if (const auto t = _tl.getAs<clang::TemplateTypeParmTypeLoc>())
          add(t.getNameLoc(), t.getDecl(), 0);
        else if (const auto t = _tl.getAs<clang::TemplateSpecializationTypeLoc>())
          add(t.getTemplateNameLoc(), t.getTypePtr()->getTemplateName().getAsTemplateDecl(), 0);
        else if (const auto t = _tl.getAs<clang::DeducedTemplateSpecializationTypeLoc>())
          add(t.getTemplateNameLoc(), t.getTypePtr()->getTemplateName().getAsTemplateDecl(), 0);
        else if (const auto t = _tl.getAs<clang::DependentNameTypeLoc>())
          add_kind(t.getNameLoc(), TokenKind::TYPE, 0);
        return true;
      }

      // the namespace of a qualifier, for example std in std::vector. the base class visits the prefix and the types
      bool TraverseNestedNameSpecifierLoc(clang::NestedNameSpecifierLoc _nns) {
        if (_nns && _nns.getNestedNameSpecifier().getKind() == clang::NestedNameSpecifier::Kind::Namespace)
          add(_nns.getLocalBeginLoc(), _nns.castAsNamespaceAndPrefix().Namespace, 0);
        return Base::TraverseNestedNameSpecifierLoc(_nns);
      }

      // a variable in the capture list of a lambda
      bool TraverseLambdaCapture(clang::LambdaExpr* _le, const clang::LambdaCapture* _c, clang::Expr* _init) {
        if (_c->capturesVariable() && !_c->isImplicit() && !_le->isInitCapture(_c))
          add(_c->getLocation(), _c->getCapturedVar(), 0);
        return Base::TraverseLambdaCapture(_le, _c, _init);
      }

      // a field in the member initializer list of a constructor
      bool TraverseConstructorInitializer(clang::CXXCtorInitializer* _init) {
        if (_init->isWritten() && _init->isAnyMemberInitializer())
          add(_init->getMemberLocation(), _init->getAnyMember(), 0);
        return Base::TraverseConstructorInitializer(_init);
      }

     private:
      void add(const clang::SourceLocation _loc, const clang::NamedDecl* _d, const uint32_t _mods) {
        if (!_d || _loc.isInvalid()) return;

        // a call of an operator or of a conversion function has no name. its location can be on a different name
        const clang::DeclarationName::NameKind name = _d->getDeclName().getNameKind();
        if (name == clang::DeclarationName::CXXOperatorName ||
            name == clang::DeclarationName::CXXConversionFunctionName)
          return;
        if (const auto* t = llvm::dyn_cast<clang::TemplateDecl>(_d); t && t->getTemplatedDecl())
          _d = t->getTemplatedDecl();

        if (const std::optional<TokenKind> kind = name_kind(_d)) add_kind(_loc, *kind, _mods | name_mods(_d, sm_));
      }  // add

      // a name from a macro has its spelling in a macro argument or in the body of a macro. only the spelling in the
      // main file is a token of the file
      void add_kind(const clang::SourceLocation _loc, const TokenKind _kind, const uint32_t _mods) {
        if (_loc.isInvalid()) return;
        const clang::SourceLocation at = sm_.getSpellingLoc(_loc);
        if (sm_.isWrittenInMainFile(at)) out_.try_emplace(sm_.getFileOffset(at), _kind, _mods);
      }  // add_kind

    };  // NameClassifier

    // an instantiation of a template is also a top-level declaration of the ast unit, with the locations of the
    // template. the instantiations of a consteval function template come before the namespace that contains it
    [[nodiscard]] inline bool is_instantiation(const clang::Decl* _d) {
      clang::TemplateSpecializationKind tsk = clang::TSK_Undeclared;
      if (const auto* f = llvm::dyn_cast<clang::FunctionDecl>(_d))
        tsk = f->getTemplateSpecializationKind();
      else if (const auto* v = llvm::dyn_cast<clang::VarDecl>(_d))
        tsk = v->getTemplateSpecializationKind();
      else if (const auto* r = llvm::dyn_cast<clang::CXXRecordDecl>(_d))
        tsk = r->getTemplateSpecializationKind();
      return clang::isTemplateInstantiation(tsk);
    }  // is_instantiation

    // the opening bracket of a round, square or curly bracket. unknown for other tokens
    [[nodiscard]] inline clang::tok::TokenKind opening_bracket(const clang::tok::TokenKind _k) {
      switch (_k) {
        case clang::tok::l_paren:
        case clang::tok::r_paren:
          return clang::tok::l_paren;
        case clang::tok::l_square:
        case clang::tok::r_square:
          return clang::tok::l_square;
        case clang::tok::l_brace:
        case clang::tok::r_brace:
          return clang::tok::l_brace;
        default:
          return clang::tok::unknown;
      }
    }  // opening_bracket

    // the kind of a token that is not a name. nothing for a token with no color
    [[nodiscard]] inline std::optional<TokenKind> lexical_kind(const clang::tok::TokenKind _k) {
      if (_k == clang::tok::comment) return TokenKind::COMMENT;
      if (_k == clang::tok::numeric_constant) return TokenKind::NUMBER;
      if (clang::tok::isLiteral(_k)) return TokenKind::STRING;
      if (!clang::tok::getPunctuatorSpelling(_k)) return std::nullopt;
      switch (_k) {
        case clang::tok::l_paren:
        case clang::tok::r_paren:
        case clang::tok::l_brace:
        case clang::tok::r_brace:
        case clang::tok::l_square:
        case clang::tok::r_square:
        case clang::tok::semi:
        case clang::tok::comma:
        case clang::tok::coloncolon:
        case clang::tok::period:
        case clang::tok::arrow:
          return TokenKind::PUNCTUATION;
        default:
          return TokenKind::OPERATOR;
      }
    }  // lexical_kind
  }  // namespace Detail

  // lexes the main file and gives each token its kind
  [[nodiscard]] inline FileTokens build_file_tokens(clang::ASTUnit& _ast) {
    const clang::ASTContext& ctx   = _ast.getASTContext();
    const clang::SourceManager& sm = _ast.getSourceManager();
    const clang::FileID fid        = sm.getMainFileID();
    const llvm::StringRef buffer   = sm.getBufferData(fid);

    FileTokens out;
    out.text_ = buffer.str();
    out.line_starts_.push_back(0);
    for (uint32_t i = 0; i < uint32_t(buffer.size()); ++i)
      if (buffer[i] == '\n') out.line_starts_.push_back(i + 1);

    // the kinds of the names
    std::unordered_map<uint32_t, std::pair<TokenKind, uint32_t>> names;
    Detail::NameClassifier classifier(sm, names);
    for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it)
      if (!Detail::is_instantiation(*it) && sm.isWrittenInMainFile(sm.getExpansionLoc((*it)->getLocation())))
        classifier.TraverseDecl(*it);

    // a preprocessor line: the # and the name of the directive are one kind. the file of an include is one string, also
    // for <a/b.hpp>. the first name after #define is a macro. a round bracket right after this name starts the
    // parameters of the macro, and the body of the macro uses them
    enum class Line { CODE, HASH, INCLUDE, DEFINE, PARAMS, BODY, PRAGMA, DIRECTIVE };
    Line line         = Line::CODE;
    uint32_t name_end = 0;  // the end of the name of the macro of a #define
    std::vector<llvm::StringRef> params;

    // the open brackets, for the levels of nesting. the side view gives a color to each level, as the text editor does.
    // the second count is for each type: round, square and curly
    std::vector<clang::tok::TokenKind> brackets;
    std::array<uint32_t, 3> open_of_type{};

    // an attribute: [[...]], __attribute__((...)) or __declspec(...). attr_opens is the number of brackets of the type
    // attr_bracket that must come next to open the attribute. the names of the attribute are at the level attr_level
    // of the brackets, or 0 outside of an attribute. a name in an argument of an attribute is deeper
    uint32_t attr_opens                = 0;
    clang::tok::TokenKind attr_bracket = clang::tok::unknown;
    size_t attr_level                  = 0;

    clang::Lexer lexer(fid, sm.getBufferOrFake(fid), sm, ctx.getLangOpts());
    lexer.SetCommentRetentionState(true);
    clang::Token tok;
    for (bool isEnd = false; !isEnd;) {
      isEnd = lexer.LexFromRawLexer(tok);
      if (tok.is(clang::tok::eof)) break;
      const uint32_t offset = sm.getFileOffset(tok.getLocation());
      const uint32_t len    = tok.getLength();

      if (tok.isAtStartOfLine()) {
        line = Line::CODE;
        params.clear();
        if (tok.is(clang::tok::hash)) {
          line = Line::HASH;
          out.tokens_.push_back({offset, len, TokenKind::PREPROCESSOR, 0, 0});
          continue;
        }
      }

      std::optional<TokenKind> kind;
      uint32_t mods       = 0;
      uint16_t type_level = 0;
      if (attr_opens > 0 && !tok.is(clang::tok::comment) && !tok.is(attr_bracket)) attr_opens = 0;

      // a function-like macro has no space between its name and the round bracket
      if (line == Line::BODY && params.empty() && tok.is(clang::tok::l_paren) && offset == name_end)
        line = Line::PARAMS;

      // the name of the directive
      if (line == Line::HASH) {
        line = Line::DIRECTIVE;
        if (tok.is(clang::tok::raw_identifier)) {
          const llvm::StringRef name = tok.getRawIdentifier();
          kind                       = TokenKind::PREPROCESSOR;
          if (name == "include" || name == "include_next" || name == "import") line = Line::INCLUDE;
          if (name == "define") line = Line::DEFINE;
          if (name == "pragma") line = Line::PRAGMA;
        }
      }

      // the file of an include. the string grows to the end of the last token
      else if (line == Line::INCLUDE && !tok.is(clang::tok::comment)) {
        FileToken& last = out.tokens_.back();
        if (last.kind_ == TokenKind::STRING) {
          last.len_ = offset + len - last.offset_;
          continue;
        }
        kind = TokenKind::STRING;
      }

      else if (line == Line::DEFINE && tok.is(clang::tok::raw_identifier)) {
        line     = Line::BODY;
        kind     = TokenKind::MACRO;
        mods     = mod_declaration;
        name_end = offset + len;
      }

      else if (line == Line::PARAMS && tok.is(clang::tok::raw_identifier)) {
        kind = TokenKind::PARAMETER;
        mods = mod_declaration;
        params.push_back(tok.getRawIdentifier());
      }

      // all words after #pragma, also keywords, as in the grammar of vs code
      else if (line == Line::PRAGMA && tok.is(clang::tok::raw_identifier)) {
        kind = TokenKind::PRAGMA;
      }

      // a keyword, a name of the ast, a macro or an attribute
      else if (tok.is(clang::tok::raw_identifier)) {
        const llvm::StringRef name      = tok.getRawIdentifier();
        const auto ident                = ctx.Idents.find(name);
        const clang::IdentifierInfo* ii = ident != ctx.Idents.end() ? ident->getValue() : nullptr;
        const auto named                = names.find(offset);
        const bool isMacroBody          = line == Line::BODY || line == Line::PARAMS;
        if (isMacroBody && (name == "__VA_ARGS__" || std::ranges::find(params, name) != params.end()))
          kind = TokenKind::PARAMETER;
        else if (ii && ii->isCPlusPlusOperatorKeyword())
          kind = TokenKind::OPERATOR;
        else if (ii && ii->isKeyword(ctx.getLangOpts()))
          kind = Detail::keyword_kind(ii->getTokenID());
        else if (named != names.end()) {
          kind = named->second.first;
          mods = named->second.second;
        } else if (name == "override" || name == "final")
          kind = TokenKind::KEYWORD_MODIFIER;
        else if ((line == Line::DIRECTIVE || isMacroBody) && (name == "defined" || name == "__VA_OPT__"))
          kind = TokenKind::PREPROCESSOR;
        else if (ii && ii->hasMacroDefinition())
          kind = TokenKind::MACRO;
        else if (attr_level != 0 && brackets.size() == attr_level)
          kind = TokenKind::ATTRIBUTE;
        // clang parses __declspec for a target of msvc, but the identifier is not a keyword of the language options
        else if (name == "__declspec")
          kind = TokenKind::KEYWORD;

        // the arguments of __declspec are in one round bracket, the arguments of __attribute__ in two
        if (name == "__declspec" || name == "__attribute__" || name == "__attribute") {
          attr_opens   = name == "__declspec" ? 1 : 2;
          attr_bracket = clang::tok::l_paren;
        }
      }

      // a bracket and its levels of nesting
      else if (const clang::tok::TokenKind open = Detail::opening_bracket(tok.getKind()); open != clang::tok::unknown) {
        kind              = TokenKind::BRACKET;
        uint32_t& of_type = open_of_type[open == clang::tok::l_paren ? 0 : open == clang::tok::l_square ? 1 : 2];
        if (tok.is(open)) {
          // [[ starts an attribute
          if (open == clang::tok::l_square && attr_level == 0 && attr_opens == 0 && offset + 1 < buffer.size() &&
              buffer[offset + 1] == '[') {
            attr_opens   = 2;
            attr_bracket = clang::tok::l_square;
          }
          mods       = uint32_t(brackets.size());
          type_level = uint16_t(std::min<uint32_t>(of_type++, UINT16_MAX));
          brackets.push_back(open);
          if (attr_opens > 0 && open == attr_bracket && --attr_opens == 0) attr_level = brackets.size();
        } else if (!brackets.empty() && brackets.back() == open) {
          brackets.pop_back();
          mods       = uint32_t(brackets.size());
          type_level = uint16_t(std::min<uint32_t>(--of_type, UINT16_MAX));
          if (brackets.size() < attr_level) attr_level = 0;
        } else {
          mods = bracket_unexpected;
        }
      }

      // a namespace of an attribute, for example gnu in [[gnu::always_inline]]
      else if (tok.is(clang::tok::coloncolon) && attr_level != 0 && brackets.size() == attr_level &&
               !out.tokens_.empty() && out.tokens_.back().kind_ == TokenKind::ATTRIBUTE) {
        out.tokens_.back().kind_ = TokenKind::NAMESPACE;
        kind                     = Detail::lexical_kind(tok.getKind());
      }

      else {
        kind = Detail::lexical_kind(tok.getKind());
      }
      if (line == Line::PARAMS && tok.is(clang::tok::r_paren)) line = Line::BODY;
      if (kind) out.tokens_.push_back({offset, len, *kind, type_level, mods});
    }
    return out;
  }  // build_file_tokens

  // the names of the kinds and of the modifier bits, in the sequence of their numbers
  [[nodiscard]] inline JsonObject token_legend_to_json() {
    JsonArray kinds;
    for (uint32_t k = 0; k < uint32_t(TokenKind::COUNT); ++k) kinds.push_back(Detail::token_kind_name(TokenKind(k)));
    return JsonObject{{"kinds", std::move(kinds)},
                      {"modifiers", JsonArray{"declaration", "readonly", "static", "defaultLibrary"}}};
  }  // token_legend_to_json

  // the lines _first to _last (from 1) with their text and their tokens. each token is 4 numbers: the column, the
  // length, the kind and the modifier bits. for a bracket, the last number is the level of nesting from 0, or -1 for a
  // closing bracket that does not close the last open bracket. with _isLevelPerType, the level counts only the
  // brackets of the same type. a token on more than one line, for example a block comment, gets a part on each line.
  // columns are utf-8 bytes and start at 1
  [[nodiscard]] inline JsonObject tokens_to_json(const FileTokens& _ft, const uint32_t _first, const uint32_t _last,
                                                 const bool _isLevelPerType = false) {
    const uint32_t count = uint32_t(_ft.line_starts_.size());
    const uint32_t first = std::max<uint32_t>(1, _first), last = std::min(_last, count);
    const auto line_end = [&](const uint32_t _line) {
      uint32_t end = _line < count ? _ft.line_starts_[_line] : uint32_t(_ft.text_.size());
      while (end > _ft.line_starts_[_line - 1] && (_ft.text_[end - 1] == '\n' || _ft.text_[end - 1] == '\r')) --end;
      return end;
    };

    // the first token that ends after the start of the first line
    auto next = _ft.tokens_.begin();
    if (first <= last)
      next = std::ranges::partition_point(
          _ft.tokens_, [&](const FileToken& _t) { return _t.offset_ + _t.len_ <= _ft.line_starts_[first - 1]; });

    JsonArray lines;
    for (uint32_t line = first; line <= last; ++line) {
      const uint32_t begin = _ft.line_starts_[line - 1], end = line_end(line);
      while (next != _ft.tokens_.end() && next->offset_ + next->len_ <= begin) ++next;

      JsonArray tokens;
      for (auto it = next; it != _ft.tokens_.end() && it->offset_ < end; ++it) {
        const uint32_t from = std::max(it->offset_, begin), to = std::min(it->offset_ + it->len_, end);
        if (to <= from) continue;
        tokens.push_back(int64_t(from - begin + 1));
        tokens.push_back(int64_t(to - from));
        tokens.push_back(int64_t(it->kind_));
        if (it->kind_ == TokenKind::BRACKET && it->mods_ != bracket_unexpected && _isLevelPerType)
          tokens.push_back(int64_t(it->type_level_));
        else
          tokens.push_back(it->mods_ == bracket_unexpected ? int64_t(-1) : int64_t(it->mods_));
      }
      lines.push_back(JsonObject{
          {"line", int64_t(line)}, {"text", _ft.text_.substr(begin, end - begin)}, {"tokens", std::move(tokens)}});
    }
    return JsonObject{{"lineCount", int64_t(count)}, {"legend", token_legend_to_json()}, {"lines", std::move(lines)}};
  }  // tokens_to_json

}  // namespace DataFlow
