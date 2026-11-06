#pragma once

#include <dataflow/definition.hpp>
#include <dataflow/member.hpp>

/*
  The outline of a class, a struct, a union or an enum, for the menu "Outline" of the side view:
    > the type: the name at a position of the main file, also of a type alias or of a constructor, or a qualified name.
      the translation unit must have the definition of the type
    > the head: the kind, the template parameters, the bases with their access, final and abstract
    > the members in the sequence of the source: data members with their type and their initializer, functions with
      their signature and their marks, nested types, type aliases, friends, using declarations and enumerators. the
      members that the compiler adds, for example a default constructor, are not in the outline
    > a member that a macro makes, for example GENERATED_BODY of unreal engine or Q_OBJECT of qt, gets the name of the
      macro
    > annotations: the text of a macro such as UPROPERTY(EditAnywhere) of unreal engine before a member, and each
      Q_PROPERTY of qt. the compiler does not see these macros, because they expand to no code. a function after
      "signals:" or "slots:" of qt gets the section
    > the layout of a complete type that does not depend on a template parameter: the size, the alignment, the offset
      and the size of each base and data member, and the holes of padding
    > the members of the bases, as a group for each base, until the groups have max_inherited_members members
*/

namespace DataFlow {

  // the members of the bases in one outline. AActor of unreal engine and its bases have about 1,500
  constexpr size_t max_inherited_members = 2500;

  struct OutlinePlace {
    std::string file_;
    uint32_t line_ = 0;  // from 1
    uint32_t col_  = 0;  // from 1, in utf-8 bytes
  };  // OutlinePlace

  struct OutlineMember {
    // field, method, constructor, destructor, operator, conversion, type, enumerator, friend, using or property
    std::string kind_;
    std::string name_;
    std::string text_;    // the type of a data member, the signature of a function, the value of an enumerator
    std::string access_;  // public, protected or private. empty for an enumerator
    std::vector<std::string> marks_;  // for example static, virtual, override, pure, const, noexcept or = delete
    std::string section_;             // signals or slots of qt
    std::string annotation_;          // for example UPROPERTY(EditAnywhere)
    std::string macro_;               // the macro that makes the member, for example GENERATED_BODY
    OutlinePlace place_;
    std::optional<OutlinePlace> definition_;  // a function with its definition in a different place of the unit
    std::optional<uint64_t> offset_;          // a data member of a type with a layout, in bytes
    std::optional<uint64_t> size_;
  };  // OutlineMember

  struct OutlineBase {
    std::string name_;  // as the type prints, with its template arguments
    std::string access_;
    bool isVirtual_ = false;
    std::optional<OutlinePlace> place_;  // the definition of the base
    std::optional<uint64_t> offset_;
    std::optional<uint64_t> size_;
  };  // OutlineBase

  struct OutlineLayout {
    uint64_t size_    = 0;
    uint64_t align_   = 0;
    uint64_t padding_ = 0;                              // the bytes in holes
    bool hasVPtr_     = false;                          // the type has its own pointer to a virtual table at offset 0
    std::vector<std::pair<uint64_t, uint64_t>> holes_;  // the offset and the size of each hole
  };  // OutlineLayout

  struct TypeOutline {
    std::string name_;
    std::string qualified_;
    std::string kind_;        // class, struct, union, enum or enum class
    std::string template_;    // the template parameters, for example template <class T>
    std::string underlying_;  // the underlying type of an enum with a fixed type
    bool isFinal_     = false;
    bool isAbstract_  = false;
    bool isLibrary_   = false;  // the type is in a system header
    bool isTruncated_ = false;  // the bases have more members than the outline shows
    OutlinePlace place_;
    std::vector<OutlineBase> bases_;
    std::vector<OutlineMember> members_;
    std::optional<OutlineLayout> layout_;
    std::vector<std::pair<std::string, std::vector<OutlineMember>>> inherited_;  // the members of each base
  };  // TypeOutline

  namespace Detail {
    [[nodiscard]] inline OutlinePlace outline_place(const clang::SourceManager& _sm, const clang::SourceLocation _loc) {
      const clang::SourceLocation at = _sm.getFileLoc(_loc);
      return {file_of(_sm, at), _sm.getSpellingLineNumber(at), _sm.getSpellingColumnNumber(at)};
    }  // outline_place

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

    // the macro that makes a declaration: the macro call at its place in the file, for example GENERATED_BODY. empty if
    // the body of the class has the name, also as a macro argument. a name that a macro of a different file gives to an
    // inner macro, for example to DECLARE_FUNCTION of a generated header, is not in the body
    [[nodiscard]] inline std::string outer_macro(const clang::SourceManager& _sm, const clang::LangOptions& _lo,
                                                 const clang::SourceLocation _loc, const clang::SourceRange _body) {
      if (!_loc.isMacroID()) return {};
      const clang::SourceLocation spelling = _sm.getSpellingLoc(_loc);
      const clang::SourceLocation begin    = _sm.getFileLoc(_body.getBegin());
      const clang::SourceLocation end      = _sm.getFileLoc(_body.getEnd());
      if (_sm.getFileID(spelling) == _sm.getFileID(begin) && _sm.getFileOffset(spelling) > _sm.getFileOffset(begin) &&
          _sm.getFileOffset(spelling) < _sm.getFileOffset(end))
        return {};
      clang::Token tok;
      if (clang::Lexer::getRawToken(_sm.getExpansionLoc(_loc), tok, _sm, _lo, true) ||
          !tok.is(clang::tok::raw_identifier))
        return {};
      return tok.getRawIdentifier().str();
    }  // outer_macro

    [[nodiscard]] inline bool is_annotation(const llvm::StringRef _name) {
      static constexpr std::array<std::string_view, 9> names = {
          "UPROPERTY", "UFUNCTION", "UCLASS", "USTRUCT", "UENUM", "Q_INVOKABLE", "Q_SIGNAL", "Q_SLOT", "Q_SCRIPTABLE"};
      return std::ranges::find(names, std::string_view(_name.data(), _name.size())) != names.end();
    }  // is_annotation

    // the text between two members of a class: the last annotation macro and the Q_PROPERTY macros
    struct MemberGap {
      std::string annotation_;
      std::vector<OutlineMember> properties_;
    };  // MemberGap

    [[nodiscard]] inline MemberGap member_gap(const clang::ASTContext& _ctx, const clang::SourceLocation _from,
                                              const clang::SourceLocation _to) {
      MemberGap out;
      const clang::SourceManager& sm = _ctx.getSourceManager();
      const clang::SourceLocation a  = sm.getFileLoc(_from);
      const clang::SourceLocation b  = sm.getFileLoc(_to);
      if (a.isInvalid() || b.isInvalid() || sm.getFileID(a) != sm.getFileID(b)) return out;
      const clang::FileID fid    = sm.getFileID(a);
      const uint32_t begin       = sm.getFileOffset(a);
      const uint32_t end         = sm.getFileOffset(b);
      const llvm::StringRef text = sm.getBufferData(fid);
      if (end <= begin || end > text.size() || end - begin > 8000) return out;

      // the lexer stops only at a null character, so it lexes a copy of the gap. the tokens get their places in the
      // file
      const std::string gap = text.slice(begin, end).str();
      clang::Lexer lexer(sm.getComposedLoc(fid, begin), _ctx.getLangOpts(), gap.data(), gap.data(),
                         gap.data() + gap.size());
      clang::Token tok;
      // the round brackets after a macro name: the end of the closing bracket, or the end of the name
      const auto arguments_end = [&](const uint32_t _name_end) {
        clang::Token next;
        if (lexer.LexFromRawLexer(next) || !next.is(clang::tok::l_paren)) return _name_end;
        for (int depth = 1; depth > 0;) {
          if (lexer.LexFromRawLexer(next) && next.is(clang::tok::eof)) return _name_end;
          if (next.is(clang::tok::l_paren)) ++depth;
          if (next.is(clang::tok::r_paren)) --depth;
        }
        return sm.getFileOffset(next.getLocation()) + next.getLength();
      };
      for (bool isEnd = false; !isEnd;) {
        isEnd = lexer.LexFromRawLexer(tok);
        if (tok.is(clang::tok::eof) || !tok.is(clang::tok::raw_identifier)) continue;
        const llvm::StringRef name = tok.getRawIdentifier();
        const uint32_t start       = sm.getFileOffset(tok.getLocation());
        if (is_annotation(name)) {
          out.annotation_ = one_line(text.slice(start, arguments_end(start + tok.getLength())));
        } else if (name == "Q_PROPERTY") {
          OutlineMember p;
          p.kind_  = "property";
          p.text_  = one_line(text.slice(start, arguments_end(start + tok.getLength())));
          p.place_ = outline_place(sm, tok.getLocation());
          // the name of the property is the name before READ or MEMBER
          llvm::SmallVector<llvm::StringRef> words;
          llvm::SplitString(p.text_, words, " ()");
          for (size_t i = 1; i < words.size(); ++i)
            if (words[i] == "READ" || words[i] == "MEMBER") p.name_ = words[i - 1].str();
          out.properties_.push_back(std::move(p));
        }
      }
      return out;
    }  // member_gap

    // the return type, the name, the parameters and the qualifiers of a function
    [[nodiscard]] inline std::string signature_of(const clang::FunctionDecl& _f, const clang::PrintingPolicy& _pp) {
      std::string out;
      if (!llvm::isa<clang::CXXConstructorDecl, clang::CXXDestructorDecl, clang::CXXConversionDecl>(_f))
        out = _f.getReturnType().getAsString(_pp) + ' ';
      out += _f.getNameAsString() + '(';
      for (unsigned i = 0; i < _f.getNumParams(); ++i) {
        const clang::ParmVarDecl* p = _f.getParamDecl(i);
        if (i > 0) out += ", ";
        out += p->getType().getAsString(_pp);
        if (!p->getName().empty()) out += ' ' + p->getNameAsString();
      }
      if (_f.isVariadic()) out += _f.getNumParams() > 0 ? ", ..." : "...";
      out += ')';
      if (const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(&_f)) {
        if (m->isConst()) out += " const";
        if (m->isVolatile()) out += " volatile";
        if (m->getRefQualifier() == clang::RQ_LValue) out += " &";
        if (m->getRefQualifier() == clang::RQ_RValue) out += " &&";
      }
      return out;
    }  // signature_of

    // the marks of a function as the source has them. a defaulted function can be constexpr and noexcept with no word
    // in the source, so these two marks need their word
    [[nodiscard]] inline std::vector<std::string> function_marks(const clang::FunctionDecl& _f,
                                                                 const clang::ASTContext& _ctx) {
      std::vector<std::string> out;
      const auto* m = llvm::dyn_cast<clang::CXXMethodDecl>(&_f);
      if (_f.getDescribedFunctionTemplate()) out.push_back("template");
      if (m && m->isStatic()) out.push_back("static");
      if (m && m->isVirtualAsWritten()) out.push_back("virtual");
      if (_f.hasAttr<clang::OverrideAttr>()) out.push_back("override");
      if (_f.hasAttr<clang::FinalAttr>()) out.push_back("final");
      if (_f.isPureVirtual()) out.push_back("pure");
      if (const auto* c = llvm::dyn_cast<clang::CXXConstructorDecl>(&_f); c && c->isExplicit())
        out.push_back("explicit");
      if (const auto* c = llvm::dyn_cast<clang::CXXConversionDecl>(&_f); c && c->isExplicit())
        out.push_back("explicit");
      const std::string head = source_text(_ctx, {_f.getBeginLoc(), _f.getLocation()});
      if (_f.isConsteval())
        out.push_back("consteval");
      else if (_f.isConstexpr() && llvm::StringRef(head).contains("constexpr"))
        out.push_back("constexpr");
      if (const auto* fpt = _f.getType()->getAs<clang::FunctionProtoType>();
          fpt && _f.getExceptionSpecSourceRange().isValid()) {
        const clang::ExceptionSpecificationType est = fpt->getExceptionSpecType();
        if (est == clang::EST_BasicNoexcept || est == clang::EST_NoexceptTrue || est == clang::EST_DependentNoexcept)
          out.push_back("noexcept");
      }
      if (_f.isDeleted()) out.push_back("= delete");
      if (_f.isExplicitlyDefaulted()) out.push_back("= default");
      return out;
    }  // function_marks

    [[nodiscard]] inline std::string function_kind(const clang::FunctionDecl& _f) {
      if (llvm::isa<clang::CXXConstructorDecl>(_f)) return "constructor";
      if (llvm::isa<clang::CXXDestructorDecl>(_f)) return "destructor";
      if (llvm::isa<clang::CXXConversionDecl>(_f)) return "conversion";
      if (_f.isOverloadedOperator()) return "operator";
      return "method";
    }  // function_kind

    [[nodiscard]] inline std::string tag_kind(const clang::TagDecl& _tag) {
      if (const auto* e = llvm::dyn_cast<clang::EnumDecl>(&_tag))
        return e->isScoped() ? (e->isScopedUsingClassTag() ? "enum class" : "enum struct") : "enum";
      return _tag.getKindName().str();
    }  // tag_kind

    // the members of a class or an enum in the sequence of the source, with no members of its bases. _fields gets the
    // index of each data member, for its offset in the layout
    [[nodiscard]] inline std::vector<OutlineMember> outline_members(
        const clang::TagDecl& _tag, const clang::ASTContext& _ctx,
        std::vector<std::pair<const clang::FieldDecl*, size_t>>* _fields = nullptr) {
      const clang::SourceManager& sm = _ctx.getSourceManager();
      const clang::LangOptions& lo   = _ctx.getLangOpts();
      const clang::PrintingPolicy pp = _ctx.getPrintingPolicy();
      std::vector<OutlineMember> out;
      std::string section;  // signals or slots of qt
      clang::SourceLocation gap = _tag.getBraceRange().getBegin();

      for (const clang::Decl* d : _tag.decls()) {
        if (d->isImplicit()) continue;
        MemberGap before = member_gap(_ctx, gap, d->getBeginLoc());
        for (OutlineMember& p : before.properties_) out.push_back(std::move(p));
        gap = d->getEndLoc();
        if (const auto* as = llvm::dyn_cast<clang::AccessSpecDecl>(d)) {
          const std::string spelled = source_text(_ctx, as->getSourceRange());
          section = llvm::StringRef(spelled).contains("signals") || llvm::StringRef(spelled).contains("SIGNALS")
                        ? "signals"
                    : llvm::StringRef(spelled).contains("slots") || llvm::StringRef(spelled).contains("SLOTS") ? "slots"
                                                                                                               : "";
          continue;
        }

        OutlineMember m;
        const clang::Decl* item = d;
        if (const auto* t = llvm::dyn_cast<clang::TemplateDecl>(d); t && t->getTemplatedDecl())
          item = t->getTemplatedDecl();
        if (const auto* named = llvm::dyn_cast<clang::NamedDecl>(item)) m.name_ = named->getNameAsString();
        m.access_            = access_name(d->getAccess());
        m.place_             = outline_place(sm, item->getLocation());
        m.macro_             = outer_macro(sm, lo, item->getLocation(), _tag.getBraceRange());
        m.annotation_        = std::move(before.annotation_);
        // the text of the source is the text of the member only if the body of the class has the member
        const bool isWritten = m.macro_.empty();

        if (const auto* f = llvm::dyn_cast<clang::FieldDecl>(item)) {
          m.kind_ = "field";
          m.text_ = f->getType().getAsString(pp);
          if (f->isBitField()) m.text_ += " : " + std::to_string(f->getBitWidthValue());
          if (const clang::Expr* init = f->getInClassInitializer(); init && isWritten)
            m.text_ += " = " + one_line(source_text(_ctx, init->getSourceRange()), 60);
          if (f->isMutable()) m.marks_.push_back("mutable");
          if (_fields) _fields->push_back({f, out.size()});
        } else if (const auto* v = llvm::dyn_cast<clang::VarDecl>(item)) {
          m.kind_ = "field";
          m.text_ = v->getType().getAsString(pp);
          if (const clang::Expr* init = v->getInit(); init && isWritten)
            m.text_ += " = " + one_line(source_text(_ctx, init->getSourceRange()), 60);
          m.marks_.push_back("static");
          if (v->isConstexpr()) m.marks_.push_back("constexpr");
        } else if (const auto* fn = llvm::dyn_cast<clang::FunctionDecl>(item)) {
          m.kind_  = function_kind(*fn);
          m.text_  = signature_of(*fn, pp);
          m.marks_ = function_marks(*fn, _ctx);
          if (llvm::isa<clang::CXXMethodDecl>(fn)) m.section_ = section;
          if (const clang::FunctionDecl* def = fn->getDefinition(); def && def != fn)
            m.definition_ = outline_place(sm, def->getLocation());
        } else if (const auto* t = llvm::dyn_cast<clang::TagDecl>(item)) {
          m.kind_ = "type";
          m.text_ = tag_kind(*t);
          if (llvm::isa<clang::ClassTemplateDecl>(d)) m.marks_.push_back("template");
        } else if (const auto* a = llvm::dyn_cast<clang::TypedefNameDecl>(item)) {
          m.kind_ = "type";
          m.text_ = "= " + a->getUnderlyingType().getAsString(pp);
          if (llvm::isa<clang::TypeAliasTemplateDecl>(d)) m.marks_.push_back("template");
        } else if (const auto* fr = llvm::dyn_cast<clang::FriendDecl>(item)) {
          m.kind_ = "friend";
          if (const clang::TypeSourceInfo* type = fr->getFriendType()) {
            const clang::TagDecl* t = type->getType()->getAsTagDecl();
            m.name_                 = t ? t->getNameAsString() : type->getType().getAsString(pp);
            m.text_                 = "friend " + (t ? tag_kind(*t) + ' ' : std::string()) + m.name_;
          } else if (const clang::NamedDecl* friend_decl = fr->getFriendDecl()) {
            m.name_ = friend_decl->getNameAsString();
            if (const auto* ft = llvm::dyn_cast<clang::FunctionTemplateDecl>(friend_decl))
              friend_decl = ft->getTemplatedDecl();
            const auto* friend_fn = llvm::dyn_cast<clang::FunctionDecl>(friend_decl);
            m.text_               = "friend " + (friend_fn ? signature_of(*friend_fn, pp) : m.name_);
          }
        } else if (llvm::isa<clang::UsingDecl>(item)) {
          m.kind_ = "using";
          m.text_ = isWritten ? one_line(source_text(_ctx, item->getSourceRange())) : "using " + m.name_;
        } else if (const auto* e = llvm::dyn_cast<clang::EnumConstantDecl>(item)) {
          m.kind_   = "enumerator";
          m.text_   = llvm::toString(e->getInitVal(), 10);
          m.access_ = "";
        } else {
          continue;
        }
        out.push_back(std::move(m));
      }

      // the Q_PROPERTY macros after the last member
      MemberGap last = member_gap(_ctx, gap, _tag.getBraceRange().getEnd());
      for (OutlineMember& p : last.properties_) out.push_back(std::move(p));
      return out;
    }  // outline_members

    // the size, the alignment, the holes of padding, and the offsets and the sizes of the bases and data members
    [[nodiscard]] inline OutlineLayout outline_layout(
        const clang::CXXRecordDecl& _rd, const clang::ASTContext& _ctx, std::vector<OutlineBase>& _bases,
        std::vector<OutlineMember>& _members, const std::vector<std::pair<const clang::FieldDecl*, size_t>>& _fields) {
      const clang::ASTRecordLayout& layout = _ctx.getASTRecordLayout(&_rd);
      OutlineLayout out;
      out.size_  = uint64_t(layout.getSize().getQuantity());
      out.align_ = uint64_t(layout.getAlignment().getQuantity());

      // the parts of the object, as [begin, end) in bytes
      std::vector<std::pair<uint64_t, uint64_t>> parts;
      const uint64_t pointer = _ctx.getTypeSize(_ctx.VoidPtrTy) / 8;
      if (_ctx.getTargetInfo().getCXXABI().isMicrosoft()) {
        out.hasVPtr_ = layout.hasOwnVFPtr();
        if (layout.hasOwnVBPtr()) {
          const uint64_t at = uint64_t(layout.getVBPtrOffset().getQuantity());
          parts.push_back({at, at + pointer});
        }
      } else {
        out.hasVPtr_ = _rd.isDynamicClass() && !layout.getPrimaryBase();
      }
      if (out.hasVPtr_) parts.push_back({0, pointer});

      size_t base_index = 0;
      for (const clang::CXXBaseSpecifier& b : _rd.bases()) {
        OutlineBase& base               = _bases[base_index++];
        const clang::CXXRecordDecl* brd = b.getType()->getAsCXXRecordDecl();
        if (!brd || !brd->hasDefinition()) continue;
        brd = brd->getDefinition();
        const uint64_t at =
            uint64_t((b.isVirtual() ? layout.getVBaseClassOffset(brd) : layout.getBaseClassOffset(brd)).getQuantity());
        const uint64_t size = brd->isEmpty() ? 0 : uint64_t(_ctx.getASTRecordLayout(brd).getDataSize().getQuantity());
        base.offset_        = at;
        base.size_          = size;
        if (size > 0) parts.push_back({at, at + size});
      }

      for (const auto& [field, index] : _fields) {
        const uint64_t bits = layout.getFieldOffset(field->getFieldIndex());
        uint64_t size_bits  = 0;
        if (field->isBitField())
          size_bits = field->getBitWidthValue();
        else if (!field->isZeroSize(_ctx) && !field->getType()->isIncompleteType())
          size_bits = uint64_t(_ctx.getTypeSize(field->getType()));
        _members[index].offset_ = bits / 8;
        _members[index].size_   = (bits % 8 + size_bits + 7) / 8;
        if (size_bits > 0) parts.push_back({bits / 8, (bits + size_bits + 7) / 8});
      }

      // the holes between the parts and at the end
      std::ranges::sort(parts);
      uint64_t at = 0;
      for (const auto& [begin, end] : parts) {
        if (begin > at) out.holes_.push_back({at, begin - at});
        at = std::max(at, end);
      }
      if (out.size_ > at) out.holes_.push_back({at, out.size_ - at});
      for (const auto& [offset, size] : out.holes_) out.padding_ += size;
      return out;
    }  // outline_layout

    // a class or an enum by its qualified name, for example DataFlow::WorkerPool. the definition, or nullptr
    [[nodiscard]] inline const clang::TagDecl* tag_by_name(clang::ASTContext& _ctx, const std::string_view _name) {
      if (const clang::CXXRecordDecl* rd = class_by_name(_ctx, _name)) return rd;
      const size_t at              = _name.rfind("::");
      const std::string_view scope = at == std::string_view::npos ? std::string_view() : _name.substr(0, at);
      const std::string_view last  = at == std::string_view::npos ? _name : _name.substr(at + 2);
      const clang::DeclContext* dc = scope.empty() ? _ctx.getTranslationUnitDecl() : nullptr;
      if (!dc) dc = class_by_name(_ctx, scope);
      if (!dc) dc = namespace_by_name(_ctx, scope);
      if (!dc) return nullptr;
      for (const clang::NamedDecl* d : dc->lookup(&_ctx.Idents.get(llvm::StringRef(last.data(), last.size()))))
        if (const auto* e = llvm::dyn_cast<clang::EnumDecl>(d); e && e->getDefinition()) return e->getDefinition();
      return nullptr;
    }  // tag_by_name

  }  // namespace Detail

  // the class or the enum of a declaration: a class, an enum, a type alias of one of them, or a constructor or a
  // destructor of a class. nullptr for other declarations
  [[nodiscard]] inline const clang::TagDecl* outline_tag(const clang::NamedDecl* _d) {
    if (!_d) return nullptr;
    if (llvm::isa<clang::CXXConstructorDecl, clang::CXXDestructorDecl>(_d))
      return llvm::cast<clang::CXXMethodDecl>(_d)->getParent();
    if (const auto* t = llvm::dyn_cast<clang::TypedefNameDecl>(_d))
      return t->getUnderlyingType().getCanonicalType()->getAsTagDecl();
    return llvm::dyn_cast<clang::TagDecl>(_d);
  }  // outline_tag

  // the outline of the definition of a class, a struct, a union or an enum
  [[nodiscard]] inline TypeOutline build_outline(const clang::TagDecl& _tag, const clang::ASTContext& _ctx) {
    const clang::SourceManager& sm = _ctx.getSourceManager();
    const clang::PrintingPolicy pp = _ctx.getPrintingPolicy();
    TypeOutline out;
    out.name_      = _tag.getNameAsString();
    out.qualified_ = _tag.getQualifiedNameAsString();
    out.kind_      = Detail::tag_kind(_tag);
    out.place_     = Detail::outline_place(sm, _tag.getLocation());
    out.isLibrary_ = sm.isInSystemHeader(_tag.getLocation());
    if (const auto* e = llvm::dyn_cast<clang::EnumDecl>(&_tag); e && e->isFixed())
      out.underlying_ = e->getIntegerType().getAsString(pp);

    std::vector<std::pair<const clang::FieldDecl*, size_t>> fields;
    out.members_   = Detail::outline_members(_tag, _ctx, &fields);

    const auto* rd = llvm::dyn_cast<clang::CXXRecordDecl>(&_tag);
    if (!rd) return out;
    out.isFinal_    = rd->hasAttr<clang::FinalAttr>();
    out.isAbstract_ = rd->isAbstract();
    if (const clang::ClassTemplateDecl* ct = rd->getDescribedClassTemplate())
      out.template_ = Detail::one_line(Detail::source_text(_ctx, ct->getTemplateParameters()->getSourceRange()));
    for (const clang::CXXBaseSpecifier& b : rd->bases()) {
      OutlineBase base;
      base.name_      = b.getType().getAsString(pp);
      base.access_    = Detail::access_name(b.getAccessSpecifier());
      base.isVirtual_ = b.isVirtual();
      if (const clang::CXXRecordDecl* brd = b.getType()->getAsCXXRecordDecl(); brd && brd->hasDefinition())
        base.place_ = Detail::outline_place(sm, brd->getDefinition()->getLocation());
      out.bases_.push_back(std::move(base));
    }
    if (!rd->isDependentType() && !rd->isInvalidDecl())
      out.layout_ = Detail::outline_layout(*rd, _ctx, out.bases_, out.members_, fields);

    // the members of the bases, the nearest bases first. a base that a different path also reaches comes one time. the
    // own members of the type are always complete
    size_t count = 0;
    std::vector<const clang::CXXRecordDecl*> todo;
    std::unordered_set<const clang::CXXRecordDecl*> seen;
    const auto add_bases = [&](const clang::CXXRecordDecl* _of) {
      for (const clang::CXXBaseSpecifier& b : _of->bases())
        if (const clang::CXXRecordDecl* brd = b.getType()->getAsCXXRecordDecl(); brd && brd->hasDefinition())
          if (seen.insert(brd->getDefinition()).second) todo.push_back(brd->getDefinition());
    };
    add_bases(rd);
    for (size_t i = 0; i < todo.size(); ++i) {
      std::vector<OutlineMember> members = Detail::outline_members(*todo[i], _ctx);
      if (count + members.size() > max_inherited_members) {
        out.isTruncated_ = true;
        break;
      }
      count += members.size();
      out.inherited_.push_back({todo[i]->getQualifiedNameAsString(), std::move(members)});
      add_bases(todo[i]);
    }
    return out;
  }  // build_outline

  namespace Detail {
    [[nodiscard]] inline JsonObject outline_place_to_json(const OutlinePlace& _p) {
      return JsonObject{{"file", _p.file_}, {"line", int64_t(_p.line_)}, {"col", int64_t(_p.col_)}};
    }  // outline_place_to_json

    [[nodiscard]] inline JsonArray members_to_json(const std::vector<OutlineMember>& _members) {
      JsonArray out;
      for (const OutlineMember& m : _members) {
        JsonObject o = outline_place_to_json(m.place_);
        o["kind"]    = m.kind_;
        o["name"]    = m.name_;
        o["text"]    = m.text_;
        o["access"]  = m.access_;
        if (!m.marks_.empty()) {
          JsonArray marks;
          for (const std::string& mark : m.marks_) marks.push_back(mark);
          o["marks"] = std::move(marks);
        }
        if (!m.section_.empty()) o["section"] = m.section_;
        if (!m.annotation_.empty()) o["annotation"] = m.annotation_;
        if (!m.macro_.empty()) o["macro"] = m.macro_;
        if (m.definition_) o["definition"] = outline_place_to_json(*m.definition_);
        if (m.offset_) o["offset"] = int64_t(*m.offset_);
        if (m.size_) o["size"] = int64_t(*m.size_);
        out.push_back(std::move(o));
      }
      return out;
    }  // members_to_json
  }  // namespace Detail

  [[nodiscard]] inline JsonObject outline_to_json(const TypeOutline& _o) {
    JsonArray bases;
    for (const OutlineBase& b : _o.bases_) {
      JsonObject o{{"name", b.name_}, {"access", b.access_}, {"isVirtual", b.isVirtual_}};
      if (b.place_) o["place"] = Detail::outline_place_to_json(*b.place_);
      if (b.offset_) o["offset"] = int64_t(*b.offset_);
      if (b.size_) o["size"] = int64_t(*b.size_);
      bases.push_back(std::move(o));
    }
    JsonArray inherited;
    for (const auto& [base, members] : _o.inherited_)
      inherited.push_back(JsonObject{{"base", base}, {"members", Detail::members_to_json(members)}});
    JsonObject out       = Detail::outline_place_to_json(_o.place_);
    out["name"]          = _o.name_;
    out["qualifiedName"] = _o.qualified_;
    out["kind"]          = _o.kind_;
    out["template"]      = _o.template_;
    out["underlying"]    = _o.underlying_;
    out["isFinal"]       = _o.isFinal_;
    out["isAbstract"]    = _o.isAbstract_;
    out["isLibrary"]     = _o.isLibrary_;
    out["isTruncated"]   = _o.isTruncated_;
    out["bases"]         = std::move(bases);
    out["members"]       = Detail::members_to_json(_o.members_);
    out["inherited"]     = std::move(inherited);
    if (_o.layout_) {
      JsonArray holes;
      for (const auto& [offset, size] : _o.layout_->holes_)
        holes.push_back(JsonObject{{"offset", int64_t(offset)}, {"size", int64_t(size)}});
      out["layout"] = JsonObject{{"size", int64_t(_o.layout_->size_)},
                                 {"align", int64_t(_o.layout_->align_)},
                                 {"padding", int64_t(_o.layout_->padding_)},
                                 {"hasVPtr", _o.layout_->hasVPtr_},
                                 {"holes", std::move(holes)}};
    } else {
      out["layout"] = nullptr;
    }
    return out;
  }  // outline_to_json

}  // namespace DataFlow
