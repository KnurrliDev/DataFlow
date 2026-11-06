#pragma once

#include <dataflow/includes.hpp>
#include <dataflow/tokens.hpp>

/*
  The definition of the name at a position of the main file, for a ctrl+click in the side view:
    > a name: the declaration that the walk of the names of the tokens found for it. the target is the definition in
      the translation unit, else the first declaration. an instantiation of a template goes to its template
    > a macro: the #define of the macro at the position
    > the file of an #include: the file that the include pass found for the directive
  the definitions in other translation units are not in the ast. the extension asks the definition providers of the
  editor first, and the engine only if they give no answer
*/

namespace DataFlow {

  enum class DefinitionRole { DEFINITION, DECLARATION, FILE };

  struct DefinitionTarget {
    std::string file_;
    uint32_t line_       = 0;  // from 1
    uint32_t col_        = 0;  // from 1, in utf-8 bytes
    DefinitionRole role_ = DefinitionRole::DEFINITION;
  };  // DefinitionTarget

  struct DefinitionResult {
    std::string name_;  // the qualified name, the name of the macro or the spelled file of the include
    std::string kind_;  // the kind of the token, for example "method", "class", "macro" or "string" for an include
    std::vector<DefinitionTarget> targets_;
  };  // DefinitionResult

  namespace Detail {
    [[nodiscard]] inline const char* definition_role_name(const DefinitionRole _role) {
      switch (_role) {
        case DefinitionRole::DEFINITION:
          return "definition";
        case DefinitionRole::DECLARATION:
          return "declaration";
        case DefinitionRole::FILE:
          return "file";
      }
      return "definition";
    }  // definition_role_name

    [[nodiscard]] inline bool is_name_kind(const TokenKind _kind) {
      switch (_kind) {
        case TokenKind::NAMESPACE:
        case TokenKind::CLASS:
        case TokenKind::ENUM:
        case TokenKind::ENUM_MEMBER:
        case TokenKind::TYPE:
        case TokenKind::TYPE_PARAMETER:
        case TokenKind::FUNCTION:
        case TokenKind::METHOD:
        case TokenKind::PARAMETER:
        case TokenKind::VARIABLE:
        case TokenKind::PROPERTY:
        case TokenKind::MACRO:
        case TokenKind::LABEL:
          return true;
        default:
          return false;
      }
    }  // is_name_kind

    // the token that contains a byte offset of the main file, or nullptr
    [[nodiscard]] inline const FileToken* token_containing(const FileTokens& _tokens, const uint32_t _offset) {
      const auto it = std::ranges::upper_bound(_tokens.tokens_, _offset, {}, &FileToken::offset_);
      if (it == _tokens.tokens_.begin()) return nullptr;
      const FileToken& t = *std::prev(it);
      return _offset < t.offset_ + t.len_ ? &t : nullptr;
    }  // token_containing

    // the text of a line of the main file, from 1, with no line end
    [[nodiscard]] inline llvm::StringRef line_text(const FileTokens& _tokens, const uint32_t _line) {
      if (_line == 0 || _line > _tokens.line_starts_.size()) return {};
      const uint32_t begin = _tokens.line_starts_[_line - 1];
      const uint32_t end =
          _line < _tokens.line_starts_.size() ? _tokens.line_starts_[_line] : uint32_t(_tokens.text_.size());
      return llvm::StringRef(_tokens.text_).slice(begin, end).rtrim("\r\n");
    }  // line_text

    // true if the line is an #include, #include_next or #import directive
    [[nodiscard]] inline bool is_include_line(llvm::StringRef _text) {
      _text = _text.ltrim();
      if (!_text.consume_front("#")) return false;
      _text = _text.ltrim();
      return _text.starts_with("include") || _text.starts_with("import");
    }  // is_include_line

    // the definition of a declaration in the translation unit, or nullptr. an instantiation of a template goes to its
    // template. a declaration with no separate definition, for example a data member, is its own definition
    [[nodiscard]] inline const clang::NamedDecl* definition_of(const clang::NamedDecl* _d) {
      if (const auto* f = llvm::dyn_cast<clang::FunctionDecl>(_d)) {
        if (const clang::FunctionDecl* pattern = f->getTemplateInstantiationPattern()) f = pattern;
        return f->getDefinition();
      }
      if (const auto* v = llvm::dyn_cast<clang::VarDecl>(_d)) {
        if (const clang::VarDecl* pattern = v->getTemplateInstantiationPattern()) v = pattern;
        return v->getDefinition();
      }
      if (const auto* r = llvm::dyn_cast<clang::CXXRecordDecl>(_d)) {
        if (const clang::CXXRecordDecl* pattern = r->getTemplateInstantiationPattern()) r = pattern;
        return r->getDefinition();
      }
      if (const auto* t = llvm::dyn_cast<clang::TagDecl>(_d)) return t->getDefinition();
      return _d;
    }  // definition_of

    // the place of a location in its file. a name in a macro argument gets its place in the source, a name in the body
    // of a macro the place of the macro call. nothing for a location with no file, for example a builtin
    [[nodiscard]] inline std::optional<DefinitionTarget> target_at(const clang::SourceManager& _sm,
                                                                   const clang::SourceLocation _loc,
                                                                   const DefinitionRole _role) {
      if (_loc.isInvalid()) return std::nullopt;
      const clang::SourceLocation at = _sm.getFileLoc(_loc);
      std::string file               = file_of(_sm, at);
      if (file.empty()) return std::nullopt;
      return DefinitionTarget{std::move(file), _sm.getSpellingLineNumber(at), _sm.getSpellingColumnNumber(at), _role};
    }  // target_at

  }  // namespace Detail

  // the token at a line and a column of the main file, from 1. a click on the right half of the last letter of a name
  // gives the position after the name, so the token before the position also counts if it is a name
  [[nodiscard]] inline const FileToken* definition_token(const FileTokens& _tokens, const uint32_t _line,
                                                         const uint32_t _col) {
    if (_line == 0 || _line > _tokens.line_starts_.size() || _col == 0) return nullptr;
    const uint32_t offset  = _tokens.line_starts_[_line - 1] + _col - 1;
    const FileToken* token = Detail::token_containing(_tokens, offset);
    if (token && (Detail::is_name_kind(token->kind_) || token->kind_ == TokenKind::STRING)) return token;
    const FileToken* before = offset > 0 ? Detail::token_containing(_tokens, offset - 1) : nullptr;
    return before && Detail::is_name_kind(before->kind_) ? before : token;
  }  // definition_token

  // true if the token is the file of an #include directive
  [[nodiscard]] inline bool is_include_file(const FileTokens& _tokens, const FileToken& _token) {
    if (_token.kind_ != TokenKind::STRING) return false;
    const auto line = std::ranges::upper_bound(_tokens.line_starts_, _token.offset_) - _tokens.line_starts_.begin();
    return Detail::is_include_line(Detail::line_text(_tokens, uint32_t(line)));
  }  // is_include_file

  // the file of the #include directive of a line of the main file, from the include pass. no target if the
  // preprocessor did not find the file
  [[nodiscard]] inline DefinitionResult include_definition(const IncludePass& _pass, const uint32_t _line) {
    DefinitionResult out;
    out.kind_                 = "string";
    const IncludeModel& model = _pass.model_;
    for (const IncludeNode& n : model.nodes_) {
      if (n.parent_ != 0 || n.line_ != _line) continue;
      out.name_ = n.spelled_;
      if (n.file_ >= 0 && size_t(n.file_) < model.files_.size())
        out.targets_.push_back({model.files_[size_t(n.file_)].path_, 1, 1, DefinitionRole::FILE});
      break;
    }
    return out;
  }  // include_definition

  // the definition of a name or of a macro of the main file
  [[nodiscard]] inline DefinitionResult name_definition(clang::ASTUnit& _ast, const FileTokens& _tokens,
                                                        const FileToken& _token) {
    const clang::SourceManager& sm = _ast.getSourceManager();
    DefinitionResult out;
    out.kind_ = Detail::token_kind_name(_token.kind_);

    // a macro: its definition at the place of the name. the name after #define is the definition itself
    if (_token.kind_ == TokenKind::MACRO) {
      out.name_                      = _tokens.text_.substr(_token.offset_, _token.len_);
      const clang::SourceLocation at = sm.getComposedLoc(sm.getMainFileID(), _token.offset_);
      if (_token.mods_ & mod_declaration) {
        if (auto t = Detail::target_at(sm, at, DefinitionRole::DEFINITION)) out.targets_.push_back(std::move(*t));
        return out;
      }
      clang::Preprocessor& pp         = _ast.getPreprocessor();
      const clang::IdentifierInfo* ii = pp.getIdentifierInfo(out.name_);
      const clang::MacroInfo* mi      = pp.getMacroDefinitionAtLoc(ii, at).getMacroInfo();
      if (!mi) mi = pp.getMacroInfo(ii);
      if (mi)
        if (auto t = Detail::target_at(sm, mi->getDefinitionLoc(), DefinitionRole::DEFINITION))
          out.targets_.push_back(std::move(*t));
      return out;
    }

    const auto it = _tokens.decls_.find(_token.offset_);
    if (it == _tokens.decls_.end()) return out;
    const clang::NamedDecl* d = it->second;
    out.name_                 = d->getQualifiedNameAsString();

    // the definition in the translation unit, else the first declaration, for example in a header
    if (const clang::NamedDecl* def = Detail::definition_of(d)) {
      if (auto t = Detail::target_at(sm, def->getLocation(), DefinitionRole::DEFINITION))
        out.targets_.push_back(std::move(*t));
    } else if (const auto* first = llvm::dyn_cast<clang::NamedDecl>(d->getCanonicalDecl())) {
      if (auto t = Detail::target_at(sm, first->getLocation(), DefinitionRole::DECLARATION))
        out.targets_.push_back(std::move(*t));
    }
    return out;
  }  // name_definition

  [[nodiscard]] inline JsonObject definition_to_json(const DefinitionResult& _result) {
    JsonArray targets;
    for (const DefinitionTarget& t : _result.targets_)
      targets.push_back(JsonObject{{"file", t.file_},
                                   {"line", int64_t(t.line_)},
                                   {"col", int64_t(t.col_)},
                                   {"role", Detail::definition_role_name(t.role_)}});
    return JsonObject{{"name", _result.name_}, {"kind", _result.kind_}, {"targets", std::move(targets)}};
  }  // definition_to_json

}  // namespace DataFlow
