#pragma once

#include <dataflow/analysis.hpp>
#include <dataflow/tu_cache.hpp>

/*
  The include hierarchy of a translation unit, for Include Hierarchy:
    > a pass of the preprocessor with the command and the unsaved text of the parse. the parse keeps the includes in a
      preamble, so its own preprocessor does not read them again. a later parse uses the pass again while the
      directives of the main file, the preamble and the other open files are the same
    > nodes: the main file and each #include directive. a directive enters its file, skips it because the file came
      in before and has an include guard or #pragma once, or does not find it. a directive of the command line, for
      example -include, belongs to the main file with line 0
    > files: the files that the preprocessor entered, with their lines and their group, for example the project
      headers, the C++ standard library or Qt
    > uses: an include of the main file is used if the main file uses a declaration or a macro of the header or of a
      header that it exports. a name of the standard library also belongs to its public header, for example
      std::string to <string>. the declarations come from the ast of the parse. the macros come from the names in the
      text of the main file and the macros of the headers in the pass
    > a used header that no used include brings in: the first include that brings it in is used too, because the main
      file needs it
    > exports: a header that gives no tokens after the preprocessor, only directives and macros, exports all its
      includes, for example <QTimer>. an include with the comment "IWYU pragma: export", or in a block of
      "IWYU pragma: begin_exports" and "IWYU pragma: end_exports", is also an export
    > no check: an include of the main file with "IWYU pragma: keep" or "IWYU pragma: export", a header with code and
      with no include guard, for example an X macro file, and a source file, for example moc_x.cpp
    > forward declarations: forward declarations can replace a used include of a project or a library if each name that
      the main file uses from it is a type with a forward declaration, and no place of the main file needs the full
      type. a place that needs the full type is, for example, a variable or a data member by value, a base class, a
      member access, a construction, a call that returns the type by value, sizeof, new and delete. the check is
      conservative: a template argument of a template that is not on a short list needs the full type
*/

namespace DataFlow {

  enum class IncludeState { MAIN, ENTERED, SKIPPED, MISSING };

  struct IncludeFile {
    std::string path_;  // absolute, with native separators and without dots
    uint32_t lines_ = 0;
    bool isSystem_  = false;
    bool isGuarded_ = false;  // the file has an include guard or #pragma once
    std::string group_;       // for example "project headers", "C++ standard library" or "Qt"
  };  // IncludeFile

  // the first use of a declaration or a macro of a file in the main file
  struct IncludeUse {
    std::string name_;
    uint32_t line_ = 0;
    int32_t node_  = -1;  // the node of the file of the name, for the result of an include
  };  // IncludeUse

  // the includes with a pragma of IWYU in the text of a file
  struct HeaderExports {
    std::vector<uint32_t> lines_;  // the lines of the includes with an export pragma
    std::vector<uint32_t> keep_;   // the lines of the includes with "IWYU pragma: keep"
  };  // HeaderExports

  // the result of the forward declaration check of an include of the main file
  struct IncludeForward {
    bool isPossible_ = false;  // forward declarations can replace the include
    std::string text_;         // possible: the forward declarations, for example namespace power { class Battery; }
    std::vector<std::pair<std::string, std::vector<uint32_t>>> types_;  // possible: each type and the lines of its uses
    std::string blockerName_;  // needed: the first name or type that needs the include
    std::string blockerKind_;  // needed: why, for example "a member access"
    uint32_t blockerLine_ = 0;
  };  // IncludeForward

  struct IncludeNode {
    int32_t file_   = -1;  // -1 for a file that the preprocessor did not find
    int32_t parent_ = -1;
    uint32_t line_  = 0;   // the line of the directive in the file of the parent
    std::string spelled_;  // for example <vector> or "types.hpp"
    IncludeState state_ = IncludeState::MAIN;
    int32_t first_      = -1;     // a skipped node: the node that entered the file first
    bool hasCode_       = false;  // an entered node: the file gave tokens after the preprocessor in this entry
    bool isOwn_         = false;  // the header of the main file, for example a.h for a.cpp
    std::optional<bool> isUsed_;  // an entered include of the main file: the main file uses a name of it
    IncludeUse use_;
    std::optional<IncludeForward> forward_;  // a used include of the main file of a project or a library
  };  // IncludeNode

  struct IncludeModel {
    std::vector<IncludeFile> files_;
    std::vector<IncludeNode> nodes_;
    double preprocess_ms_ = 0.0;    // the time of the pass of the preprocessor. 0 if the model uses an earlier pass
    bool isPassReused_    = false;  // the model uses the pass of an earlier parse
  };  // IncludeModel

  struct IncludeOptions {
    std::vector<std::string> roots_;  // the folders of the project. a file in them is a project header
    bool hasErrors_ = false;          // the parse has errors, so the ast is not complete: no forward declaration check
  };  // IncludeOptions

  // the result of a pass of the preprocessor. a later parse can use it again while the directives of the main file, the
  // preamble and the other open files are the same
  struct IncludePass {
    IncludeModel model_;                                  // the files and the nodes, with no uses and no groups
    std::vector<std::string> dirs_;                       // the include folders, as keys of normalize_path
    llvm::StringMap<std::string> macros_;                 // a macro of a header -> the key of the path of the header
    std::vector<std::pair<uint32_t, uint32_t>> skipped_;  // the first and the last line of each block of the main file
                                                          // that a condition skips, with no directive lines
    std::unordered_map<std::string, HeaderExports> exports_;  // the exports of the open files, by the key of the path
    double ms_ = 0.0;
  };  // IncludePass

  namespace Detail {
    using UseMap = std::unordered_map<std::string, IncludeUse>;  // the key of a path -> the first use of the file

    [[nodiscard]] inline uint32_t line_count(const llvm::StringRef _text) {
      if (_text.empty()) return 0;
      return uint32_t(_text.count('\n')) + (_text.back() == '\n' ? 0 : 1);
    }  // line_count

    // true for a header: no extension, as <vector>, or the extension of a header. a source file, as moc_x.cpp, an
    // .inc file of a unity build or an X macro file gives definitions, not names
    [[nodiscard]] inline bool is_header(const llvm::StringRef _path) {
      const llvm::StringRef ext = llvm::sys::path::extension(_path);
      return ext.empty() || llvm::is_contained({".h", ".hh", ".hpp", ".hxx", ".h++"}, ext.lower());
    }  // is_header

    // keeps the earliest use of each file
    inline void add_use(UseMap& _uses, const std::string& _key, IncludeUse&& _use) {
      const auto [it, isNew] = _uses.try_emplace(_key, _use);
      if (!isNew && _use.line_ < it->second.line_) it->second = std::move(_use);
    }  // add_use

    // the line after the directive at a # sign. a backslash at the end of a line continues the directive
    [[nodiscard]] inline uint32_t line_after_directive(const clang::SourceManager& _sm,
                                                       const clang::SourceLocation _hash) {
      const auto [fid, offset]   = _sm.getDecomposedSpellingLoc(_hash);
      const llvm::StringRef text = _sm.getBufferData(fid);
      uint32_t line              = _sm.getSpellingLineNumber(_hash);
      for (size_t pos = offset;; ++line) {
        const size_t eol = text.find('\n', pos);
        if (eol == llvm::StringRef::npos || !text.slice(pos, eol).rtrim().ends_with("\\")) return line + 1;
        pos = eol + 1;
      }
    }  // line_after_directive

    //----------------------------------
    // Preprocessor

    // records the include directives, the files that the preprocessor enters, the macros of the headers and the
    // skipped ranges of the main file
    class IncludeRecorder : public clang::PPCallbacks {
      clang::SourceManager& sm_;
      const clang::HeaderSearch& search_;
      IncludePass& pass_;
      IncludeModel& model_;
      std::unordered_map<std::string, int32_t> index_;  // the key of a path -> the file
      std::vector<clang::FileEntryRef> entries_;        // the entry of each file
      std::vector<int32_t> first_;                      // the first node that entered each file
      std::vector<int32_t> stack_;  // the node of each buffer of the lexer. -1 for a buffer with no file, as <built-in>

      // the directive of the next file that the preprocessor enters or skips
      struct Pending {
        int32_t parent_ = -1;
        uint32_t line_  = 0;
        std::string spelled_;
      };  // Pending
      std::optional<Pending> pending_;

     public:
      IncludeRecorder(clang::SourceManager& _sm, const clang::HeaderSearch& _search, IncludePass& _pass)
          : sm_(_sm), search_(_search), pass_(_pass), model_(_pass.model_) {}

      // a token after the preprocessor belongs to the file that the lexer reads. a macro expands in the file of its use
      void on_token() {
        if (!stack_.empty() && stack_.back() >= 0) model_.nodes_[stack_.back()].hasCode_ = true;
      }  // on_token

      // at the end of the main file, the preprocessor knows the include guard of each file
      void EndOfMainFile() override {
        for (size_t f = 0; f < entries_.size(); ++f)
          model_.files_[f].isGuarded_ = search_.isFileMultipleIncludeGuarded(entries_[f]);
      }  // EndOfMainFile

      void LexedFileChanged(clang::FileID _fid, const LexedFileChangeReason _reason,
                            const clang::SrcMgr::CharacteristicKind _type, clang::FileID,
                            clang::SourceLocation) override {
        if (_reason == LexedFileChangeReason::ExitFile) {
          if (!stack_.empty()) stack_.pop_back();
          return;
        }
        const clang::OptionalFileEntryRef entry = sm_.getFileEntryRefForID(_fid);
        if (!entry) {
          stack_.push_back(-1);
          return;
        }

        IncludeNode node;
        node.file_ = add_file(*entry, _type, sm_.getBufferData(_fid));
        if (!model_.nodes_.empty()) {
          node.state_ = IncludeState::ENTERED;
          if (pending_) {
            node.parent_  = pending_->parent_;
            node.line_    = pending_->line_;
            node.spelled_ = std::move(pending_->spelled_);
          } else {
            node.parent_ = parent();
          }
        }
        pending_.reset();

        const int32_t id = int32_t(model_.nodes_.size());
        if (first_[node.file_] < 0) first_[node.file_] = id;
        model_.nodes_.push_back(std::move(node));
        stack_.push_back(id);
      }  // LexedFileChanged

      void InclusionDirective(clang::SourceLocation _hash, const clang::Token&, const llvm::StringRef _name,
                              const bool _isAngled, clang::CharSourceRange, const clang::OptionalFileEntryRef _file,
                              llvm::StringRef, llvm::StringRef, const clang::Module*, bool,
                              clang::SrcMgr::CharacteristicKind) override {
        // a directive of the command line has no line
        const bool isForced = stack_.empty() || stack_.back() < 0;
        Pending p{parent(), isForced ? 0u : sm_.getSpellingLineNumber(_hash),
                  (_isAngled ? "<" : "\"") + _name.str() + (_isAngled ? ">" : "\"")};
        if (_file) {
          pending_ = std::move(p);
          return;
        }

        // the preprocessor did not find the file
        IncludeNode node;
        node.parent_  = p.parent_;
        node.line_    = p.line_;
        node.spelled_ = std::move(p.spelled_);
        node.state_   = IncludeState::MISSING;
        model_.nodes_.push_back(std::move(node));
        pending_.reset();
      }  // InclusionDirective

      void FileSkipped(const clang::FileEntryRef& _file, const clang::Token&,
                       const clang::SrcMgr::CharacteristicKind _type) override {
        if (!pending_) return;
        IncludeNode node;
        node.file_    = add_file(_file, _type, std::nullopt);
        node.parent_  = pending_->parent_;
        node.line_    = pending_->line_;
        node.spelled_ = std::move(pending_->spelled_);
        node.state_   = IncludeState::SKIPPED;
        node.first_   = first_[node.file_];
        pending_.reset();
        model_.nodes_.push_back(std::move(node));
      }  // FileSkipped

      // the macros of the headers by their names. a definition in the main file hides the definition of a header
      void MacroDefined(const clang::Token& _name, const clang::MacroDirective* _md) override {
        const clang::IdentifierInfo* id = _name.getIdentifierInfo();
        const clang::MacroInfo* mi      = _md ? _md->getMacroInfo() : nullptr;
        if (!id) return;
        const clang::SourceLocation at = mi ? mi->getDefinitionLoc() : clang::SourceLocation();
        const clang::OptionalFileEntryRef entry =
            at.isValid() && !sm_.isInMainFile(at) ? sm_.getFileEntryRefForID(sm_.getFileID(at)) : std::nullopt;
        if (entry)
          pass_.macros_[id->getName()] = normalize_path(path_of(*entry, sm_.getFileManager()));
        else
          pass_.macros_.erase(id->getName());  // a builtin macro, or a macro of the command line or of the main file
      }  // MacroDefined

      void MacroUndefined(const clang::Token& _name, const clang::MacroDefinition&,
                          const clang::MacroDirective*) override {
        if (const clang::IdentifierInfo* id = _name.getIdentifierInfo()) pass_.macros_.erase(id->getName());
      }  // MacroUndefined

      // a range of the main file that a condition skips. its names are no uses
      void SourceRangeSkipped(const clang::SourceRange _range, const clang::SourceLocation _end_directive) override {
        if (!sm_.isInMainFile(_range.getBegin())) return;
        // the range of clang ends after the directive at its end: #endif, #else or #elif. after an #elif with a true
        // condition, it ends on the next line. the location of the name of the directive gives its own line
        const clang::SourceLocation end = _end_directive.isValid() ? _end_directive : _range.getEnd();
        pass_.skipped_.emplace_back(line_after_directive(sm_, _range.getBegin()), sm_.getSpellingLineNumber(end) - 1);
      }  // SourceRangeSkipped

     private:
      // the node of the innermost buffer with a file. a directive of the command line belongs to the main file
      [[nodiscard]] int32_t parent() const {
        for (auto it = stack_.rbegin(); it != stack_.rend(); ++it)
          if (*it >= 0) return *it;
        return model_.nodes_.empty() ? -1 : 0;
      }  // parent

      [[nodiscard]] int32_t add_file(const clang::FileEntryRef _entry, const clang::SrcMgr::CharacteristicKind _type,
                                     const std::optional<llvm::StringRef> _text) {
        std::string path       = path_of(_entry, sm_.getFileManager());
        const auto [it, isNew] = index_.try_emplace(normalize_path(path), int32_t(model_.files_.size()));
        if (isNew) {
          IncludeFile file;
          file.path_     = std::move(path);
          file.lines_    = _text ? line_count(*_text) : 0;
          file.isSystem_ = clang::SrcMgr::isSystem(_type);
          model_.files_.push_back(std::move(file));
          entries_.push_back(_entry);
          first_.push_back(-1);
        }
        return it->second;
      }  // add_file

    };  // IncludeRecorder

    // runs the preprocessor with the recorder, and keeps the include folders of the command
    class IncludeAction : public clang::PreprocessOnlyAction {
      IncludePass& pass_;

     public:
      explicit IncludeAction(IncludePass& _pass) : pass_(_pass) {}

     protected:
      bool BeginSourceFileAction(clang::CompilerInstance& _ci) override {
        clang::Preprocessor& pp = _ci.getPreprocessor();
        for (const clang::DirectoryLookup& d : pp.getHeaderSearchInfo().search_dir_range()) {
          const clang::OptionalDirectoryEntryRef dir = d.getDirRef();
          if (!dir) continue;
          llvm::SmallString<256> path(dir->getName());
          _ci.getFileManager().makeAbsolutePath(path);
          llvm::sys::path::remove_dots(path, true);
          llvm::sys::path::native(path);
          pass_.dirs_.push_back(normalize_path(std::string(path)));
        }
        auto recorder = std::make_unique<IncludeRecorder>(_ci.getSourceManager(), pp.getHeaderSearchInfo(), pass_);
        IncludeRecorder* rec = recorder.get();
        pp.addPPCallbacks(std::move(recorder));
        pp.setTokenWatcher([rec](const clang::Token&) { rec->on_token(); });
        return true;
      }  // BeginSourceFileAction

    };  // IncludeAction

    // makes the action, and gives the preprocessor the unsaved text of the open files, as in the parse
    class IncludeFactory : public clang::tooling::FrontendActionFactory {
      IncludePass& pass_;
      const std::vector<Buffer>& buffers_;

     public:
      IncludeFactory(IncludePass& _pass, const std::vector<Buffer>& _buffers) : pass_(_pass), buffers_(_buffers) {}

      std::unique_ptr<clang::FrontendAction> create() override { return std::make_unique<IncludeAction>(pass_); }

      bool runInvocation(std::shared_ptr<clang::CompilerInvocation> _inv, clang::FileManager* _files,
                         std::shared_ptr<clang::PCHContainerOperations> _pch,
                         clang::DiagnosticConsumer* _diags) override {
        clang::PreprocessorOptions& opts = _inv->getPreprocessorOpts();
        for (const Buffer& b : buffers_)
          opts.addRemappedFile(b.path_, llvm::MemoryBuffer::getMemBufferCopy(b.text_, b.path_).release());
        opts.RetainRemappedFileBuffers = false;  // the compiler instance deletes the buffers
        return clang::tooling::FrontendActionFactory::runInvocation(std::move(_inv), _files, std::move(_pch), _diags);
      }  // runInvocation

    };  // IncludeFactory

    //----------------------------------
    // Uses

    // collects the files of the declarations that the main file uses, with the first use in each file. a name of the
    // standard library also gives its public headers, for example <string> for std::string, which an internal header of
    // the library declares
    class UseCollector : public clang::RecursiveASTVisitor<UseCollector> {
      using Base = clang::RecursiveASTVisitor<UseCollector>;
      const clang::SourceManager& sm_;
      UseMap& out_;
      UseMap& std_;  // the spelled name of a header of the standard library -> the first use
      clang::tooling::stdlib::Recognizer recognizer_;
      std::unordered_set<const clang::Decl*> seen_;
      std::unordered_map<uint32_t, std::string> keys_;  // the key of the path of each file id

     public:
      UseCollector(const clang::SourceManager& _sm, UseMap& _out, UseMap& _std) : sm_(_sm), out_(_out), std_(_std) {}

      // the code that the user wrote: no instantiations of templates
      bool TraverseDecl(clang::Decl* _d) {
        if (const auto* fn = llvm::dyn_cast_or_null<clang::FunctionDecl>(_d); fn && fn->isTemplateInstantiation())
          return true;
        const auto* spec = llvm::dyn_cast_or_null<clang::ClassTemplateSpecializationDecl>(_d);
        if (spec && spec->getSpecializationKind() == clang::TSK_ImplicitInstantiation) return true;
        return Base::TraverseDecl(_d);
      }  // TraverseDecl

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        add(_e->getDecl(), _e->getLocation());
        return true;
      }

      bool VisitMemberExpr(clang::MemberExpr* _e) {
        add(_e->getMemberDecl(), _e->getMemberLoc());
        return true;
      }

      bool VisitCXXConstructExpr(clang::CXXConstructExpr* _e) {
        add(_e->getConstructor(), _e->getLocation());
        return true;
      }

      bool VisitOverloadExpr(clang::OverloadExpr* _e) {
        for (const clang::NamedDecl* d : _e->decls()) add(d, _e->getNameLoc());
        return true;
      }

      bool VisitUsingDecl(clang::UsingDecl* _d) {
        for (const clang::UsingShadowDecl* s : _d->shadows()) add(s->getTargetDecl(), _d->getLocation());
        return true;
      }

      // a definition in the main file of a function that a header declares, for example WorkerPool::destroy
      bool VisitFunctionDecl(clang::FunctionDecl* _d) {
        add(_d, _d->getLocation());
        return true;
      }

      bool VisitTypeLoc(clang::TypeLoc _tl) {
        const clang::SourceLocation at = _tl.getBeginLoc();
        if (const auto t = _tl.getAs<clang::TagTypeLoc>())
          add(t.getDecl(), at);
        else if (const auto t = _tl.getAs<clang::TypedefTypeLoc>())
          add(t.getDecl(), at);
        else if (const auto t = _tl.getAs<clang::UsingTypeLoc>())
          add(t.getDecl()->getTargetDecl(), at);
        else if (const auto t = _tl.getAs<clang::TemplateSpecializationTypeLoc>())
          add(t.getTypePtr()->getTemplateName().getAsTemplateDecl(), at);
        else if (const auto t = _tl.getAs<clang::DeducedTemplateSpecializationTypeLoc>())
          add(t.getTypePtr()->getTemplateName().getAsTemplateDecl(), at);
        return true;
      }  // VisitTypeLoc

     private:
      // the files of all declarations of _d, for a use at _at in the main file. the first use of a declaration is also
      // the first use of its files, because the visitor goes through the main file from the top
      void add(const clang::Decl* _d, const clang::SourceLocation _at) {
        if (!_d || !seen_.insert(_d->getCanonicalDecl()).second) return;
        const clang::SourceLocation at = sm_.getFileLoc(_at);
        if (at.isInvalid() || !sm_.isInMainFile(at)) {
          seen_.erase(_d->getCanonicalDecl());
          return;
        }
        const auto* named = llvm::dyn_cast<clang::NamedDecl>(_d);
        for (const clang::Decl* r : _d->redecls()) {
          const clang::SourceLocation loc = sm_.getFileLoc(r->getLocation());
          if (loc.isInvalid() || sm_.isInMainFile(loc)) continue;
          const clang::FileID fid = sm_.getFileID(loc);
          const auto [it, isNew]  = keys_.try_emplace(fid.getHashValue());
          if (isNew) it->second = normalize_path(file_of(sm_, loc));
          if (it->second.empty()) continue;
          add_use(
              out_, it->second,
              IncludeUse{named ? named->getQualifiedNameAsString() : std::string(), sm_.getExpansionLineNumber(at)});
        }
        if (const std::optional<clang::tooling::stdlib::Symbol> symbol = recognizer_(_d))
          for (const clang::tooling::stdlib::Header& h : symbol->headers())
            add_use(std_, h.name().str(),
                    IncludeUse{std::string(symbol->qualifiedName()), sm_.getExpansionLineNumber(at)});
      }  // add

    };  // UseCollector

    //----------------------------------
    // Exports

    // the includes with a pragma of IWYU in the text of a file. a line that starts with # is a directive. a backslash
    // at the end of a line continues the line
    [[nodiscard]] inline HeaderExports header_exports(llvm::StringRef _text) {
      HeaderExports out;
      if (!_text.contains("IWYU pragma:")) return out;
      _text.consume_front("\xEF\xBB\xBF");  // the byte order mark of UTF-8
      bool isBlock = false, isInComment = false, isContinued = false;
      std::string code, comment;  // the code and the comments of the logical line
      uint32_t line = 0, start = 0;
      for (llvm::StringRef rest = _text; !rest.empty();) {
        auto [physical, next] = rest.split('\n');
        rest                  = next;
        ++line;
        if (!isContinued) {
          start = line;
          code.clear();
          comment.clear();
        }

        // the comments and the literals of the line. a comment in a literal is no comment
        const llvm::StringRef l = physical.rtrim('\r');
        for (size_t i = 0; i < l.size(); ++i) {
          const llvm::StringRef at = l.substr(i);
          if (isInComment) {
            if (at.starts_with("*/")) {
              isInComment = false;
              comment += ' ';
              ++i;
            } else {
              comment += l[i];
            }
          } else if (at.starts_with("//")) {
            comment += at.drop_front(2);
            break;
          } else if (at.starts_with("/*")) {
            isInComment = true;
            ++i;
          } else if (l[i] == '"' || l[i] == '\'') {
            const char quote = l[i];
            code += l[i];
            for (++i; i < l.size() && l[i] != quote; ++i) {
              code += l[i];
              if (l[i] == '\\' && i + 1 < l.size()) code += l[++i];
            }
            if (i < l.size()) code += l[i];
          } else {
            code += l[i];
          }
        }
        isContinued = !isInComment && l.ends_with("\\");
        if (isContinued) continue;

        // the pragmas, then the directive. an include on the line of "begin_exports" is in the block
        bool isExport = false, isKeep = false;
        for (llvm::StringRef c = comment;;) {
          const size_t at = c.find("IWYU pragma:");
          if (at == llvm::StringRef::npos) break;
          c = c.substr(at + llvm::StringRef("IWYU pragma:").size()).ltrim();
          if (c.starts_with("begin_exports"))
            isBlock = true;
          else if (c.starts_with("end_exports"))
            isBlock = false;
          else if (c.starts_with("export"))
            isExport = true;
          else if (c.starts_with("keep"))
            isKeep = true;
        }
        llvm::StringRef directive = llvm::StringRef(code).trim();
        if (!directive.consume_front("#")) continue;
        directive = directive.ltrim();
        if (!directive.starts_with("include") && !directive.starts_with("import")) continue;
        if (isBlock || isExport) out.lines_.push_back(start);
        if (isKeep) out.keep_.push_back(start);
      }
      return out;
    }  // header_exports

    //----------------------------------
    // Groups

    // the context of the groups: the main file, the project folders, the include folders and the builtin headers.
    // all are keys of normalize_path. the include folders are sorted, the longest first
    struct GroupContext {
      std::string main_;
      std::vector<std::string> roots_;
      std::vector<std::string> dirs_;
      std::string builtins_;
    };  // GroupContext

    [[nodiscard]] inline bool is_under(const std::string& _key, const std::string& _dir) {
      return !_dir.empty() && _key.size() > _dir.size() && _key.starts_with(_dir) &&
             llvm::sys::path::is_separator(_key[_dir.size()]);
    }  // is_under

    // the group of a file for the bar "Where the lines come from". normalize_path changes only the case of ASCII
    // letters, so a position in the key is the same position in the path
    [[nodiscard]] inline std::string group_of(const IncludeFile& _file, const GroupContext& _ctx) {
      const std::string key = normalize_path(_file.path_);
      if (key == _ctx.main_) return "this file";
      if (std::ranges::any_of(_ctx.roots_, [&](const std::string& _r) { return is_under(key, _r); }))
        return "project headers";
      if (!_file.isSystem_ && _ctx.roots_.empty()) return "project headers";
      if (is_under(key, _ctx.builtins_)) return "Clang built-ins";

      // the standard libraries by their folders
      const auto has = [&](const llvm::StringRef _part) {
        llvm::SmallString<64> part(_part);
        llvm::sys::path::native(part);
        return llvm::StringRef(key).contains(part.str());
      };
      if (has("/windows kits/")) return "Windows SDK";
      if (has("/vc/tools/msvc/") || has("/c++/")) return "C++ standard library";

      // the include folder that contains the file: the first folder after it, else the name of the include folder
      for (const std::string& dir : _ctx.dirs_) {
        if (!is_under(key, dir)) continue;
        const llvm::StringRef rest(_file.path_.data() + dir.size() + 1, _file.path_.size() - dir.size() - 1);
        const size_t sep = rest.find_first_of("/\\");
        std::string label;
        if (sep != llvm::StringRef::npos) {
          label = rest.substr(0, sep).str();
        } else {
          const llvm::StringRef folder(_file.path_.data(), dir.size());
          label = llvm::sys::path::filename(folder).str();
          if (llvm::StringRef(label).equals_insensitive("include"))
            label = llvm::sys::path::filename(llvm::sys::path::parent_path(folder)).str();
        }
        if (llvm::StringRef(label).starts_with("Qt")) return "Qt";
        if (label.empty() || label == "usr" || label == "local") break;
        return label;
      }
      return _file.isSystem_ ? "system headers" : "project headers";
    }  // group_of
  }  // namespace Detail

  // the pass of the preprocessor for the include hierarchy of a command. _buffers is the unsaved text of the parse
  [[nodiscard]] inline IncludePass run_include_pass(const Command& _cmd, const std::vector<Buffer>& _buffers,
                                                    const std::string& _resource_dir) {
    const auto start = std::chrono::steady_clock::now();
    IncludePass out;

    // the builtin headers of the engine, as in the parse
    std::vector<std::string> args = _cmd.args_;
    if (!_resource_dir.empty() && !args.empty()) args.insert(args.begin() + 1, "-resource-dir=" + _resource_dir);
    llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem> fs(llvm::vfs::createPhysicalFileSystem().release());
    fs->setCurrentWorkingDirectory(_cmd.directory_);
    clang::FileSystemOptions fso;
    fso.WorkingDir   = _cmd.directory_;
    const auto files = llvm::makeIntrusiveRefCnt<clang::FileManager>(fso, fs);
    Detail::IncludeFactory factory(out, _buffers);
    clang::tooling::ToolInvocation tool(std::move(args), &factory, files.get(),
                                        std::make_shared<clang::PCHContainerOperations>());
    clang::IgnoringDiagConsumer ignore;
    tool.setDiagnosticConsumer(&ignore);
    tool.run();

    // the exports of the open files come from the text of the pass. the other files are on disk
    for (const Buffer& b : _buffers) out.exports_.try_emplace(normalize_path(b.path_), Detail::header_exports(b.text_));
    out.ms_ = elapsed_ms(start);
    return out;
  }  // run_include_pass

  // true if a text has a condition of the preprocessor: #if, #ifdef or #ifndef
  [[nodiscard]] inline bool has_conditions(const llvm::StringRef _text) {
    llvm::SmallVector<llvm::StringRef> lines;
    _text.split(lines, '\n');
    return llvm::any_of(lines, [](const llvm::StringRef _line) {
      llvm::StringRef rest = _line.ltrim();
      if (!rest.consume_front("#")) return false;
      return rest.ltrim().starts_with("if");
    });
  }  // has_conditions

  // the key of a pass: the command, the number of the preamble of the parse, the versions of the other open files and
  // the directives of the main file with their lines. a new preamble comes after a change of a header, also on disk
  [[nodiscard]] inline std::string include_pass_key(const Command& _cmd, clang::ASTUnit& _ast,
                                                    const std::map<std::string, int64_t>& _others) {
    std::string out;
    for (const std::string& a : _cmd.args_) out += a + '\n';
    out += _cmd.directory_ + "\n#" + std::to_string(_ast.getPreambleCounterForTests()) + '\n';
    for (const auto& [file, version] : _others) out += file + '=' + std::to_string(version) + '\n';

    // a directive can continue on the next line after a backslash
    const clang::SourceManager& sm = _ast.getSourceManager();
    llvm::SmallVector<llvm::StringRef> lines;
    sm.getBufferData(sm.getMainFileID()).split(lines, '\n');
    bool isContinued = false;
    for (size_t i = 0; i < lines.size(); ++i) {
      const llvm::StringRef line = lines[i].rtrim('\r');
      if (!isContinued && !line.ltrim().starts_with("#")) continue;
      out += std::to_string(i + 1) + ':' + line.str() + '\n';
      isContinued = line.ends_with("\\");
    }
    return out;
  }  // include_pass_key

  namespace Detail {
    // the uses of the macros of the headers in the main file: the names in its text. a name in a range that a condition
    // skips, and a name in a directive other than a condition, for example #define or #include, is no use. a raw lexer
    // finds the names, so the uses of a new text need no new pass. a macro of the standard library, for example
    // INT32_MAX, also gives its public headers to _std
    [[nodiscard]] inline UseMap main_macro_uses(clang::ASTUnit& _ast, const IncludePass& _pass, UseMap& _std) {
      UseMap out;
      if (_pass.macros_.empty()) return out;
      const auto lang =
          _ast.getLangOpts().CPlusPlus ? clang::tooling::stdlib::Lang::CXX : clang::tooling::stdlib::Lang::C;
      const clang::SourceManager& sm = _ast.getSourceManager();
      const clang::FileID main       = sm.getMainFileID();
      const llvm::StringRef text     = sm.getBufferData(main);
      clang::Lexer lexer(sm.getLocForStartOfFile(main), _ast.getLangOpts(), text.begin(), text.begin(), text.end());

      const auto is_skipped = [&](const uint32_t _line) {
        return llvm::any_of(_pass.skipped_, [&](const auto& _r) { return _line >= _r.first && _line <= _r.second; });
      };
      bool isUse           = true;   // the names of the line are uses
      bool isDirectiveName = false;  // the next name is the name of a directive
      clang::Token tok;
      for (bool isEnd = false; !isEnd;) {
        isEnd = lexer.LexFromRawLexer(tok);
        if (tok.isAtStartOfLine()) isUse = true;
        if (tok.is(clang::tok::hash) && tok.isAtStartOfLine()) {
          isDirectiveName = true;
          continue;
        }
        if (!tok.is(clang::tok::raw_identifier)) {
          isDirectiveName = false;
          continue;
        }
        const llvm::StringRef name = tok.getRawIdentifier();
        if (isDirectiveName) {
          isUse           = llvm::is_contained({"if", "elif", "ifdef", "ifndef", "elifdef", "elifndef"}, name);
          isDirectiveName = false;
          continue;
        }
        const auto it = isUse ? _pass.macros_.find(name) : _pass.macros_.end();
        if (it == _pass.macros_.end()) continue;
        const uint32_t line = sm.getSpellingLineNumber(tok.getLocation());
        if (is_skipped(line)) continue;
        add_use(out, it->second, IncludeUse{name.str(), line});
        if (const std::optional<clang::tooling::stdlib::Symbol> symbol =
                clang::tooling::stdlib::Symbol::named("", name, lang))
          for (const clang::tooling::stdlib::Header& h : symbol->headers())
            add_use(_std, h.name().str(), IncludeUse{name.str(), line});
      }
      return out;
    }  // main_macro_uses
  }  // namespace Detail

  //----------------------------------
  // Forward declarations

  namespace Detail {
    // a reference of the main file to a declaration, and a place of the main file that needs the full type of a class
    struct ForwardRef {
      const clang::Decl* decl_ = nullptr;  // the canonical declaration
      uint32_t line_           = 0;
    };  // ForwardRef

    struct ForwardNeed {
      const clang::CXXRecordDecl* record_ = nullptr;
      uint32_t line_                      = 0;
      const char* kind_                   = "";  // for example "a member access"
    };  // ForwardNeed

    // a template whose instantiation with a type argument does not need the full type of the argument. a different
    // template is conservative: its type arguments need their full types
    [[nodiscard]] inline bool is_incomplete_ok_template(const clang::ClassTemplateSpecializationDecl& _spec) {
      const clang::ClassTemplateDecl* tpl = _spec.getSpecializedTemplate();
      const llvm::StringRef name          = tpl->getName();
      if (tpl->isInStdNamespace()) return name == "shared_ptr" || name == "weak_ptr";
      return llvm::is_contained({"TObjectPtr", "TWeakObjectPtr", "TSoftObjectPtr", "TSubclassOf", "QPointer"}, name);
    }  // is_incomplete_ok_template

    // the classes whose full types a declaration or an expression of a type needs: the class of the type, and the type
    // arguments of a template that needs them. a pointer or a reference needs no full type
    inline void full_types(clang::QualType _t, std::vector<const clang::CXXRecordDecl*>& _out,
                           const uint32_t _depth = 0) {
      if (_t.isNull() || _depth > 8) return;
      _t = _t.getCanonicalType();
      if (_t->isReferenceType() || _t->isPointerType() || _t->isMemberPointerType() || _t->isFunctionType()) return;
      if (const clang::ArrayType* a = _t->getAsArrayTypeUnsafe()) {
        full_types(a->getElementType(), _out, _depth + 1);
        return;
      }
      // an enum: its opaque declaration makes the enum complete
      const clang::CXXRecordDecl* rd = _t->getAsCXXRecordDecl();
      if (!rd) return;
      _out.push_back(rd);
      if (const auto* spec = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(rd);
          spec && !is_incomplete_ok_template(*spec))
        for (const clang::TemplateArgument& arg : spec->getTemplateArgs().asArray())
          if (arg.getKind() == clang::TemplateArgument::Type) full_types(arg.getAsType(), _out, _depth + 1);
    }  // full_types

    // the references of the main file to declarations, and the places that need full types
    class ForwardUseCollector : public clang::RecursiveASTVisitor<ForwardUseCollector> {
      using Base = clang::RecursiveASTVisitor<ForwardUseCollector>;
      const clang::ASTContext& ctx_;
      const clang::SourceManager& sm_;

     public:
      std::vector<ForwardRef> refs_;
      std::vector<ForwardNeed> needs_;

      explicit ForwardUseCollector(const clang::ASTContext& _ctx) : ctx_(_ctx), sm_(_ctx.getSourceManager()) {}

      // the code that the user wrote: no instantiations of templates
      bool TraverseDecl(clang::Decl* _d) {
        if (const auto* fn = llvm::dyn_cast_or_null<clang::FunctionDecl>(_d); fn && fn->isTemplateInstantiation())
          return true;
        const auto* spec = llvm::dyn_cast_or_null<clang::ClassTemplateSpecializationDecl>(_d);
        if (spec && spec->getSpecializationKind() == clang::TSK_ImplicitInstantiation) return true;
        return Base::TraverseDecl(_d);
      }  // TraverseDecl

      bool VisitDeclRefExpr(clang::DeclRefExpr* _e) {
        ref(_e->getDecl(), _e->getLocation());
        // an explicit template argument, for example of std::make_shared<T>()
        for (const clang::TemplateArgumentLoc& arg : _e->template_arguments())
          if (arg.getArgument().getKind() == clang::TemplateArgument::Type)
            need(arg.getArgument().getAsType(), _e->getLocation(), "a template argument");
        need_template_args(_e->getDecl(), _e->getLocation());
        return true;
      }

      bool VisitMemberExpr(clang::MemberExpr* _e) {
        ref(_e->getMemberDecl(), _e->getMemberLoc());
        const clang::QualType base = _e->getBase()->getType();
        need(_e->isArrow() ? base->getPointeeType() : base, _e->getMemberLoc(), "a member access");
        need_template_args(_e->getMemberDecl(), _e->getMemberLoc());
        return true;
      }

      bool VisitCXXConstructExpr(clang::CXXConstructExpr* _e) {
        ref(_e->getConstructor(), _e->getLocation());
        need(_e->getType(), _e->getLocation(), "an object of the type");
        return true;
      }

      bool VisitOverloadExpr(clang::OverloadExpr* _e) {
        for (const clang::NamedDecl* d : _e->decls()) ref(d, _e->getNameLoc());
        return true;
      }

      bool VisitUsingDecl(clang::UsingDecl* _d) {
        for (const clang::UsingShadowDecl* s : _d->shadows()) ref(s->getTargetDecl(), _d->getLocation());
        return true;
      }

      // a definition of a function needs the full types of its parameters and of its return value. a definition of a
      // function that a header declares, for example a member function, uses that declaration
      bool VisitFunctionDecl(clang::FunctionDecl* _d) {
        ref(_d, _d->getLocation());
        need_class(_d, "a definition of a member function");
        if (_d->doesThisDeclarationHaveABody()) need_signature(*_d, _d->getLocation());
        return true;
      }

      // the visitor does not visit the call operator of a lambda
      bool VisitLambdaExpr(clang::LambdaExpr* _e) {
        if (const clang::CXXMethodDecl* op = _e->getCallOperator()) need_signature(*op, _e->getBeginLoc());
        return true;
      }

      // a variable needs the full type, but not a declaration with extern and not a static data member in its class
      bool VisitVarDecl(clang::VarDecl* _d) {
        need_class(_d, "a definition of a static data member");
        if (llvm::isa<clang::ParmVarDecl>(_d) || _d->isThisDeclarationADefinition() == clang::VarDecl::DeclarationOnly)
          return true;
        need(_d->getType(), _d->getLocation(), "a variable of the type");
        return true;
      }

      bool VisitFieldDecl(clang::FieldDecl* _d) {
        need(_d->getType(), _d->getLocation(), "a data member of the type");
        return true;
      }

      bool VisitCXXRecordDecl(clang::CXXRecordDecl* _d) {
        if (_d->isThisDeclarationADefinition())
          for (const clang::CXXBaseSpecifier& b : _d->bases()) need(b.getType(), b.getBeginLoc(), "a base class");
        return true;
      }

      bool VisitTypeLoc(clang::TypeLoc _tl) {
        const clang::SourceLocation at = _tl.getBeginLoc();
        if (const auto t = _tl.getAs<clang::TagTypeLoc>())
          ref(t.getDecl(), at);
        else if (const auto t = _tl.getAs<clang::TypedefTypeLoc>())
          ref(t.getDecl(), at);
        else if (const auto t = _tl.getAs<clang::UsingTypeLoc>())
          ref(t.getDecl()->getTargetDecl(), at);
        else if (const auto t = _tl.getAs<clang::TemplateSpecializationTypeLoc>())
          ref(t.getTypePtr()->getTemplateName().getAsTemplateDecl(), at);
        else if (const auto t = _tl.getAs<clang::DeducedTemplateSpecializationTypeLoc>())
          ref(t.getTypePtr()->getTemplateName().getAsTemplateDecl(), at);
        return true;
      }

      // a call that returns a class by value makes an object of the class. the call is a prvalue. getCallReturnType
      // is not safe in templates
      bool VisitCallExpr(clang::CallExpr* _e) {
        if (_e->isPRValue()) need(_e->getType(), _e->getBeginLoc(), "a call that returns the type by value");
        return true;
      }

      bool VisitMaterializeTemporaryExpr(clang::MaterializeTemporaryExpr* _e) {
        need(_e->getType(), _e->getBeginLoc(), "a temporary object");
        return true;
      }

      // an aggregate initialization, for example X{1, 2}, makes an object with no call of a constructor
      bool VisitInitListExpr(clang::InitListExpr* _e) {
        need(_e->getType(), _e->getBeginLoc(), "an object of the type");
        return true;
      }

      // sizeof(X&) is the size of X
      bool VisitUnaryExprOrTypeTraitExpr(clang::UnaryExprOrTypeTraitExpr* _e) {
        need(_e->getTypeOfArgument().getNonReferenceType(), _e->getBeginLoc(), "sizeof or alignof");
        return true;
      }

      bool VisitCXXNewExpr(clang::CXXNewExpr* _e) {
        need(_e->getAllocatedType(), _e->getBeginLoc(), "a new expression");
        return true;
      }

      bool VisitCXXDeleteExpr(clang::CXXDeleteExpr* _e) {
        need_pointee(_e->getArgument()->getType(), _e->getBeginLoc(), "a delete expression");
        return true;
      }

      bool VisitCXXTypeidExpr(clang::CXXTypeidExpr* _e) {
        need(_e->isTypeOperand() ? _e->getTypeOperand(ctx_) : _e->getExprOperand()->getType(), _e->getBeginLoc(),
             "a typeid expression");
        return true;
      }

      // a cast between a class and its base needs the full types of both
      bool VisitCastExpr(clang::CastExpr* _e) {
        switch (_e->getCastKind()) {
          case clang::CK_DerivedToBase:
          case clang::CK_UncheckedDerivedToBase:
          case clang::CK_BaseToDerived:
          case clang::CK_Dynamic:
          case clang::CK_DerivedToBaseMemberPointer:
          case clang::CK_BaseToDerivedMemberPointer:
            need_pointee(_e->getType(), _e->getBeginLoc(), "a cast between classes");
            need_pointee(_e->getSubExpr()->getType(), _e->getBeginLoc(), "a cast between classes");
            break;
          default:
            break;
        }
        return true;
      }

      // pointer arithmetic needs the size of the type
      bool VisitBinaryOperator(clang::BinaryOperator* _e) {
        if (_e->isAdditiveOp() || _e->getOpcode() == clang::BO_AddAssign || _e->getOpcode() == clang::BO_SubAssign)
          for (const clang::Expr* side : {_e->getLHS(), _e->getRHS()})
            if (side->getType()->isPointerType())
              need_pointee(side->getType(), _e->getOperatorLoc(), "pointer arithmetic");
        return true;
      }

      bool VisitUnaryOperator(clang::UnaryOperator* _e) {
        if (_e->isIncrementDecrementOp() && _e->getSubExpr()->getType()->isPointerType())
          need_pointee(_e->getSubExpr()->getType(), _e->getOperatorLoc(), "pointer arithmetic");
        return true;
      }

      bool VisitArraySubscriptExpr(clang::ArraySubscriptExpr* _e) {
        need_pointee(_e->getBase()->getType(), _e->getBeginLoc(), "pointer arithmetic");
        return true;
      }

      // a throw and a catch need the full type, also through a pointer or a reference
      bool VisitCXXThrowExpr(clang::CXXThrowExpr* _e) {
        if (const clang::Expr* sub = _e->getSubExpr()) need_pointee(sub->getType(), _e->getBeginLoc(), "a throw");
        return true;
      }

      bool VisitCXXCatchStmt(clang::CXXCatchStmt* _s) {
        need_pointee(_s->getCaughtType(), _s->getBeginLoc(), "a catch");
        return true;
      }

     private:
      // the line of a place in the main file, or 0
      [[nodiscard]] uint32_t main_line(const clang::SourceLocation _loc) const {
        const clang::SourceLocation at = sm_.getFileLoc(_loc);
        return at.isValid() && sm_.isInMainFile(at) ? sm_.getExpansionLineNumber(at) : 0;
      }  // main_line

      void ref(const clang::Decl* _d, const clang::SourceLocation _loc) {
        if (!_d) return;
        if (const uint32_t line = main_line(_loc)) refs_.push_back({_d->getCanonicalDecl(), line});
      }  // ref

      void need(const clang::QualType _t, const clang::SourceLocation _loc, const char* _kind) {
        const uint32_t line = main_line(_loc);
        if (!line || _t.isNull() || _t->isDependentType()) return;
        std::vector<const clang::CXXRecordDecl*> records;
        full_types(_t, records);
        for (const clang::CXXRecordDecl* rd : records) needs_.push_back({rd, line, _kind});
      }  // need

      void need_pointee(const clang::QualType _t, const clang::SourceLocation _loc, const char* _kind) {
        if (_t.isNull()) return;
        need(_t->isPointerType() || _t->isReferenceType() ? _t->getPointeeType() : _t, _loc, _kind);
      }  // need_pointee

      // a definition out of its class, for example of a member function, needs the class
      void need_class(const clang::Decl* _d, const char* _kind) {
        const auto* rd = llvm::dyn_cast<clang::CXXRecordDecl>(_d->getDeclContext());
        if (!rd || !_d->isOutOfLine()) return;
        if (const uint32_t line = main_line(_d->getLocation())) needs_.push_back({rd, line, _kind});
      }  // need_class

      void need_signature(const clang::FunctionDecl& _fn, const clang::SourceLocation _loc) {
        for (const clang::ParmVarDecl* p : _fn.parameters())
          need(p->getType(), p->getLocation(), "a parameter by value");
        need(_fn.getReturnType(), _loc, "a return value by value");
      }  // need_signature

      // a call of a function template with a class as a type argument, for example std::swap(a, b), probably needs the
      // full type of the class. a reference counts as the class, because a forwarding reference deduces a reference
      void need_template_args(const clang::ValueDecl* _d, const clang::SourceLocation _loc) {
        const auto* fn                          = llvm::dyn_cast_or_null<clang::FunctionDecl>(_d);
        const clang::TemplateArgumentList* args = fn ? fn->getTemplateSpecializationArgs() : nullptr;
        if (!args || !main_line(_loc)) return;
        const auto need_arg = [&](const clang::TemplateArgument& _arg) {
          if (_arg.getKind() == clang::TemplateArgument::Type)
            need(_arg.getAsType().getNonReferenceType(), _loc, "a template argument");
        };
        for (const clang::TemplateArgument& arg : args->asArray()) {
          if (arg.getKind() != clang::TemplateArgument::Pack) {
            need_arg(arg);
            continue;
          }
          for (const clang::TemplateArgument& element : arg.pack_elements()) need_arg(element);
        }
      }  // need_template_args

    };  // ForwardUseCollector

    // a forward declaration and its namespace, for example "class Battery;" in "power"
    struct ForwardDecl {
      std::string scope_;
      std::string text_;
    };  // ForwardDecl

    // a template parameter that a forward declaration can give again: no default argument, no constraint, and the type
    // of a non-type parameter is a builtin type or auto. a constraint or a different type can need the header
    [[nodiscard]] inline bool is_simple_parameter(const clang::NamedDecl* _p) {
      if (const auto* t = llvm::dyn_cast<clang::TemplateTypeParmDecl>(_p))
        return !t->hasDefaultArgument() && !t->hasTypeConstraint();
      if (const auto* n = llvm::dyn_cast<clang::NonTypeTemplateParmDecl>(_p))
        return !n->hasDefaultArgument() && (n->getType()->isBuiltinType() || n->getType()->getContainedAutoType());
      if (const auto* tt = llvm::dyn_cast<clang::TemplateTemplateParmDecl>(_p)) return !tt->hasDefaultArgument();
      return false;
    }  // is_simple_parameter

    // the forward declaration of a type, or nothing: a class, a struct, a union or a class template at namespace
    // scope, or an enum with a fixed underlying type. a type in an anonymous, an inline or a reserved namespace, for
    // example std, has none. a class template with default arguments has none, because a forward declaration cannot
    // give them again. a class template with a constraint has none, because the concept can be in the same header. the
    // keyword is the keyword of the definition, because msvc gives class and struct different names
    [[nodiscard]] inline std::optional<ForwardDecl> forward_declaration(const clang::Decl* _d,
                                                                        const clang::ASTContext& _ctx) {
      const clang::TagDecl* tag           = nullptr;
      const clang::ClassTemplateDecl* tpl = nullptr;
      if (const auto* t = llvm::dyn_cast<clang::ClassTemplateDecl>(_d)) {
        tpl = t;
        tag = t->getTemplatedDecl();
      } else if (const auto* s = llvm::dyn_cast<clang::ClassTemplateSpecializationDecl>(_d)) {
        // a specialization needs the declaration of its template
        tpl = s->getSpecializedTemplate();
        tag = tpl->getTemplatedDecl();
      } else if (const auto* r = llvm::dyn_cast<clang::CXXRecordDecl>(_d)) {
        tpl = r->getDescribedClassTemplate();
        tag = r;
      } else {
        tag = llvm::dyn_cast<clang::TagDecl>(_d);
      }
      if (!tag || tag->getName().empty()) return std::nullopt;
      if (const clang::TagDecl* def = tag->getDefinition()) tag = def;

      std::vector<std::string> parts;
      for (const clang::DeclContext* dc = tag->getDeclContext(); !dc->isTranslationUnit(); dc = dc->getParent()) {
        if (llvm::isa<clang::LinkageSpecDecl>(dc)) continue;
        const auto* ns = llvm::dyn_cast<clang::NamespaceDecl>(dc);
        if (!ns || ns->isAnonymousNamespace() || ns->isInline()) return std::nullopt;
        const llvm::StringRef name = ns->getName();
        if (name == "std" || name.starts_with("__") ||
            (name.size() > 1 && name[0] == '_' && std::isupper(static_cast<unsigned char>(name[1]))))
          return std::nullopt;
        parts.push_back(name.str());
      }
      ForwardDecl out;
      for (auto it = parts.rbegin(); it != parts.rend(); ++it) out.scope_ += (out.scope_.empty() ? "" : "::") + *it;

      if (const auto* e = llvm::dyn_cast<clang::EnumDecl>(tag)) {
        if (!e->isFixed()) return std::nullopt;
        out.text_ = e->isScoped() ? (e->isScopedUsingClassTag() ? "enum class " : "enum struct ") : "enum ";
        out.text_ += e->getName().str();
        // a builtin type gets its name, because the source range of "unsigned char" has only the first keyword. the
        // text of a declaration is never cut
        if (const clang::TypeSourceInfo* written = e->getIntegerTypeSourceInfo()) {
          const clang::QualType type = written->getType();
          out.text_ +=
              " : " + (llvm::isa<clang::BuiltinType>(type.getTypePtr())
                           ? type.getAsString(_ctx.getPrintingPolicy())
                           : one_line(source_text(_ctx, written->getTypeLoc().getSourceRange()), std::string::npos));
        }
        out.text_ += ';';
        return out;
      }
      if (tpl) {
        // a later declaration can add default arguments. the most recent declaration has all of them
        const clang::TemplateParameterList& list = *tpl->getMostRecentDecl()->getTemplateParameters();
        if (list.getRequiresClause()) return std::nullopt;
        std::string params;
        for (const clang::NamedDecl* p : list) {
          if (!is_simple_parameter(p)) return std::nullopt;
          params += (params.empty() ? "" : ", ") + one_line(source_text(_ctx, p->getSourceRange()), std::string::npos);
        }
        out.text_ = "template <" + params + "> ";
      }
      out.text_ += tag->getKindName().str() + ' ' + tag->getName().str() + ';';
      return out;
    }  // forward_declaration

    // why a name of an include has no forward declaration
    [[nodiscard]] inline const char* forward_blocker_kind(const clang::Decl* _d) {
      if (llvm::isa<clang::CXXConstructorDecl>(_d)) return "a constructor";
      if (llvm::isa<clang::CXXMethodDecl, clang::FieldDecl>(_d)) return "a member";
      if (llvm::isa<clang::FunctionDecl, clang::FunctionTemplateDecl>(_d)) return "a function";
      if (llvm::isa<clang::VarDecl, clang::VarTemplateDecl>(_d)) return "a variable";
      if (llvm::isa<clang::EnumConstantDecl>(_d)) return "an enumerator";
      if (llvm::isa<clang::TypedefNameDecl, clang::TypeAliasTemplateDecl>(_d)) return "a type alias";
      if (llvm::isa<clang::ConceptDecl>(_d)) return "a concept";
      if (llvm::isa<clang::TagDecl, clang::ClassTemplateDecl>(_d)) return "a type with no forward declaration";
      return "a declaration";
    }  // forward_blocker_kind

    [[nodiscard]] inline std::string decl_name(const clang::Decl* _d) {
      const auto* named = llvm::dyn_cast<clang::NamedDecl>(_d);
      return named ? named->getQualifiedNameAsString() : std::string();
    }  // decl_name

    // the forward declaration check of the used includes of the main file. _names[top] has the files whose names count
    // for the include top: its file, the files that it exports, and the files with a used name that only it brings in
    inline void add_forward_checks(IncludeModel& _model, clang::ASTUnit& _ast, const std::vector<int32_t>& _tops,
                                   const std::vector<bool>& _checked, const std::vector<std::vector<int32_t>>& _names,
                                   const UseMap& _macroUses) {
      clang::ASTContext& ctx         = _ast.getASTContext();
      const clang::SourceManager& sm = _ast.getSourceManager();
      // only the declarations of the main file: the code of the headers is not necessary, and it is slow
      ForwardUseCollector collector(ctx);
      for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it) {
        const clang::SourceRange range = (*it)->getSourceRange();
        if (sm.isInMainFile(sm.getFileLoc(range.getBegin())) || sm.isInMainFile(sm.getFileLoc(range.getEnd())))
          collector.TraverseDecl(*it);
      }

      // the files of the model by the key of their path
      std::unordered_map<std::string, int32_t> fileOf;
      for (int32_t f = 0; f < int32_t(_model.files_.size()); ++f)
        fileOf.try_emplace(normalize_path(_model.files_[f].path_), f);
      std::unordered_map<uint32_t, int32_t> fileOfId;  // by the hash of a file id
      const auto file_at = [&](const clang::SourceLocation _loc) -> int32_t {
        const clang::SourceLocation at = sm.getFileLoc(_loc);
        if (at.isInvalid() || sm.isInMainFile(at)) return -1;
        const clang::FileID fid = sm.getFileID(at);
        const auto [it, isNew]  = fileOfId.try_emplace(fid.getHashValue(), -1);
        if (isNew)
          if (const auto f = fileOf.find(normalize_path(file_of(sm, at))); f != fileOf.end()) it->second = f->second;
        return it->second;
      };
      // the file of the definition of a class. an instantiation of a template has the file of its template
      const auto definition_file = [&](const clang::CXXRecordDecl* _rd) -> int32_t {
        if (const clang::CXXRecordDecl* pattern = _rd->getTemplateInstantiationPattern()) _rd = pattern;
        const clang::CXXRecordDecl* def = _rd->getDefinition();
        return file_at((def ? def : _rd)->getLocation());
      };

      for (const int32_t top : _tops) {
        IncludeNode& node = _model.nodes_[top];
        if (!_checked[top] || !node.isUsed_.value_or(false) || node.isOwn_) continue;
        const std::string& group = _model.files_[node.file_].group_;
        if (llvm::is_contained({"C++ standard library", "Windows SDK", "Clang built-ins", "system headers"}, group))
          continue;
        const std::unordered_set<int32_t> files(_names[top].begin(), _names[top].end());

        // the names of the include, in the sequence of their first use
        std::vector<std::pair<const clang::Decl*, std::vector<uint32_t>>> names;
        std::unordered_map<const clang::Decl*, size_t> nameIndex;
        for (const ForwardRef& r : collector.refs_) {
          if (const auto it = nameIndex.find(r.decl_); it != nameIndex.end()) {
            if (names[it->second].second.back() != r.line_) names[it->second].second.push_back(r.line_);
            continue;
          }
          const bool isOfInclude = llvm::any_of(
              r.decl_->redecls(), [&](const clang::Decl* _d) { return files.contains(file_at(_d->getLocation())); });
          if (!isOfInclude) continue;
          nameIndex.emplace(r.decl_, names.size());
          names.push_back({r.decl_, {r.line_}});
        }
        for (auto& [decl, lines] : names) {
          std::ranges::sort(lines);
          lines.erase(std::ranges::unique(lines).begin(), lines.end());
        }

        // the first use that needs the include: a macro, a name with no forward declaration, or a full type
        IncludeForward out;
        const auto block = [&](std::string _name, const char* _kind, const uint32_t _line) {
          if (out.blockerLine_ != 0 && out.blockerLine_ <= _line) return;
          out.blockerName_ = std::move(_name);
          out.blockerKind_ = _kind;
          out.blockerLine_ = _line;
        };
        for (const ForwardNeed& n : collector.needs_)
          if (files.contains(definition_file(n.record_))) block(decl_name(n.record_), n.kind_, n.line_);
        for (const int32_t f : files)
          if (const auto it = _macroUses.find(normalize_path(_model.files_[f].path_)); it != _macroUses.end())
            block(it->second.name_, "a macro", it->second.line_);
        std::vector<std::pair<std::string, std::vector<std::string>>> scopes;  // the declarations of each namespace
        for (const auto& [decl, lines] : names) {
          const std::optional<ForwardDecl> fd = forward_declaration(decl, ctx);
          if (!fd) {
            block(decl_name(decl), forward_blocker_kind(decl), lines.front());
            continue;
          }
          out.types_.push_back({decl_name(decl), lines});
          auto scope = llvm::find_if(scopes, [&](const auto& _s) { return _s.first == fd->scope_; });
          if (scope == scopes.end()) scope = scopes.insert(scopes.end(), {fd->scope_, {}});
          if (!llvm::is_contained(scope->second, fd->text_)) scope->second.push_back(fd->text_);
        }
        if (names.empty() && out.blockerLine_ == 0) continue;

        out.isPossible_ = out.blockerLine_ == 0 && !out.types_.empty();
        if (out.isPossible_) {
          for (const auto& [scope, decls] : scopes) {
            // "namespace a::b { ... }" needs C++17. before, each namespace gets its own braces
            std::string line, close;
            if (!scope.empty() && ctx.getLangOpts().CPlusPlus17) {
              line  = "namespace " + scope + " { ";
              close = " }";
            } else if (!scope.empty()) {
              for (const llvm::StringRef part : llvm::split(scope, "::")) {
                line += "namespace " + part.str() + " { ";
                close += " }";
              }
            }
            for (size_t i = 0; i < decls.size(); ++i) line += (i > 0 ? " " : "") + decls[i];
            out.text_ += (out.text_.empty() ? "" : "\n") + line + close;
          }
        } else {
          out.types_.clear();
        }
        node.forward_ = std::move(out);
      }
    }  // add_forward_checks
  }  // namespace Detail

  // the include hierarchy of a pass and of the parse of the same main file: the uses, the groups and the used includes
  [[nodiscard]] inline IncludeModel build_includes(const IncludePass& _pass, clang::ASTUnit& _ast,
                                                   const std::string& _resource_dir, const IncludeOptions& _opts) {
    IncludeModel out = _pass.model_;
    if (out.nodes_.empty()) return out;
    Detail::UseMap stdUses;  // the spelled name of a public header of the standard library -> the first use
    Detail::UseMap uses            = Detail::main_macro_uses(_ast, _pass, stdUses);
    const Detail::UseMap macroUses = uses;

    // the declarations that the main file uses, from the ast of the parse
    Detail::UseCollector collector(_ast.getSourceManager(), uses, stdUses);
    for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it) collector.TraverseDecl(*it);

    // the groups of the files
    Detail::GroupContext ctx;
    ctx.main_ = normalize_path(out.files_[out.nodes_.front().file_].path_);
    for (const std::string& r : _opts.roots_) ctx.roots_.push_back(normalize_path(r));
    std::vector<std::string> dirs = _pass.dirs_;
    std::ranges::sort(dirs, [](const std::string& _a, const std::string& _b) { return _a.size() > _b.size(); });
    ctx.dirs_ = std::move(dirs);
    if (!_resource_dir.empty()) {
      llvm::SmallString<256> builtins(_resource_dir);
      llvm::sys::path::append(builtins, "include");
      ctx.builtins_ = normalize_path(std::string(builtins));
    }
    for (IncludeFile& f : out.files_) f.group_ = Detail::group_of(f, ctx);

    // the uses of the includes of the main file. a name belongs to the header that declares it, and a name of the
    // standard library also to its public header, for example std::string to <string>. a header also gives the names
    // of the headers that it exports, also if such a header came in before through a different include. a header that
    // gives no tokens after the preprocessor, only directives and macros, exports all its includes. an included source
    // file, as moc_x.cpp, gives definitions, not names, so it gets no check
    std::vector<std::vector<int32_t>> children(out.nodes_.size());
    for (int32_t i = 1; i < int32_t(out.nodes_.size()); ++i)
      if (out.nodes_[i].parent_ >= 0) children[out.nodes_[i].parent_].push_back(i);
    const std::vector<int32_t>& tops = children.front();
    std::vector<const IncludeUse*> fileUses(out.files_.size(), nullptr);
    for (size_t f = 0; f < out.files_.size(); ++f)
      if (const auto it = uses.find(normalize_path(out.files_[f].path_)); it != uses.end()) fileUses[f] = &it->second;

    // the exports of each file, from the text of the pass or from the disk
    std::vector<std::optional<HeaderExports>> exports(out.files_.size());
    const auto exports_of = [&](const int32_t _file) -> const HeaderExports& {
      std::optional<HeaderExports>& e = exports[_file];
      if (e) return *e;
      const std::string& path = out.files_[_file].path_;
      if (const auto it = _pass.exports_.find(normalize_path(path)); it != _pass.exports_.end())
        e = it->second;
      else if (const auto buf = llvm::MemoryBuffer::getFile(path, false, false, true))
        e = Detail::header_exports((*buf)->getBuffer());
      else
        e = HeaderExports{};
      return *e;
    };

    // visits the entered nodes from _start: _visit(the node as the walk reaches it, the entered node). a skipped node
    // goes to the node that entered its file first. _follow selects the children to visit
    std::vector<int32_t> seenBy(out.nodes_.size(), -1);
    int32_t walks   = 0;
    const auto walk = [&](const int32_t _start, const auto& _visit, const auto& _follow) {
      const int32_t id = walks++;
      for (std::vector<int32_t> todo{_start}; !todo.empty();) {
        const int32_t i = todo.back();
        todo.pop_back();
        const int32_t n = out.nodes_[i].state_ == IncludeState::SKIPPED ? out.nodes_[i].first_ : i;
        if (n < 0 || seenBy[n] == id || out.nodes_[n].state_ != IncludeState::ENTERED) continue;
        seenBy[n] = id;
        _visit(i, n);
        for (const int32_t c : children[n])
          if (_follow(n, c)) todo.push_back(c);
      }
    };
    const auto all = [](int32_t, int32_t) { return true; };

    // the includes of the main file that bring in each file with a used name, in the sequence of the preprocessor, and
    // a node of the file
    std::vector<std::vector<int32_t>> reachers(out.files_.size());
    std::vector<int32_t> nodeOf(out.files_.size(), -1);
    for (const int32_t top : tops)
      walk(
          top,
          [&](int32_t, const int32_t _n) {
            const int32_t f = out.nodes_[_n].file_;
            if (!fileUses[f] || (!reachers[f].empty() && reachers[f].back() == top)) return;
            reachers[f].push_back(top);
            if (nodeOf[f] < 0) nodeOf[f] = _n;
          },
          all);

    // the includes that stay: an include with a use, and an include with no check. an include of the main file with
    // "IWYU pragma: keep" or "IWYU pragma: export" gets no check. a header with code and with no include guard gets no
    // check, because it can add code to the main file, for example an X macro file
    std::vector<bool> stays(out.nodes_.size(), true);
    std::vector<bool> checked(out.nodes_.size(), false);             // the includes with a check of their uses
    std::vector<std::vector<int32_t>> nameFiles(out.nodes_.size());  // the files whose names count for each include
    const clang::SourceManager& sm  = _ast.getSourceManager();
    const HeaderExports kept        = Detail::header_exports(sm.getBufferData(sm.getMainFileID()));
    const llvm::StringRef main_stem = llvm::sys::path::stem(out.files_[out.nodes_.front().file_].path_);
    for (const int32_t top : tops) {
      IncludeNode& node = out.nodes_[top];
      if (node.state_ != IncludeState::ENTERED) continue;
      const std::string& path = out.files_[node.file_].path_;
      node.isOwn_             = llvm::sys::path::stem(path).equals_insensitive(main_stem);
      if (!Detail::is_header(path)) continue;
      if (llvm::is_contained(kept.keep_, node.line_) || llvm::is_contained(kept.lines_, node.line_)) continue;
      if (!out.files_[node.file_].isGuarded_ && node.hasCode_) continue;
      checked[top] = true;

      // the names of the header, of the headers that it exports and of the public headers of the standard library
      std::optional<IncludeUse> first;
      walk(
          top,
          [&](const int32_t _i, const int32_t _n) {
            nameFiles[top].push_back(out.nodes_[_n].file_);
            const IncludeUse* u = fileUses[out.nodes_[_n].file_];
            if (const auto it = stdUses.find(out.nodes_[_i].spelled_);
                it != stdUses.end() && (!u || it->second.line_ < u->line_))
              u = &it->second;
            if (!u || (first && first->line_ <= u->line_)) return;
            first        = *u;
            first->node_ = _n;
          },
          [&](const int32_t _n, const int32_t _c) {
            return !out.nodes_[_n].hasCode_ ||
                   llvm::is_contained(exports_of(out.nodes_[_n].file_).lines_, out.nodes_[_c].line_);
          });
      node.isUsed_ = first.has_value();
      if (first) node.use_ = std::move(*first);
      stays[top] = node.isUsed_.value() || node.isOwn_;
    }

    // a file with a used name that no staying include brings in: the first include that brings it in stays too. thus
    // of two includes that bring in the same header, one stays. the files that only one include brings in come first
    std::vector<int32_t> needed;
    for (int32_t f = 0; f < int32_t(out.files_.size()); ++f)
      if (!reachers[f].empty()) needed.push_back(f);
    std::ranges::stable_sort(needed, [&](const int32_t _a, const int32_t _b) {
      return std::pair(reachers[_a].size(), fileUses[_a]->line_) < std::pair(reachers[_b].size(), fileUses[_b]->line_);
    });
    for (const int32_t f : needed) {
      if (std::ranges::any_of(reachers[f], [&](const int32_t _t) { return stays[_t]; })) continue;
      IncludeNode& node          = out.nodes_[reachers[f].front()];
      stays[reachers[f].front()] = true;
      node.isUsed_               = true;
      node.use_                  = *fileUses[f];
      node.use_.node_            = nodeOf[f];
      nameFiles[reachers[f].front()].push_back(f);
    }

    if (!_opts.hasErrors_) Detail::add_forward_checks(out, _ast, tops, checked, nameFiles, macroUses);
    return out;
  }  // build_includes

  //----------------------------------
  // Check of forward declarations

  // an error of the parse of a check. an error in a different file gets the line of its first note in the file of the
  // check, for example of "in instantiation of ... requested here"
  struct ForwardCheckError {
    std::string file_;  // the path of the error, empty for the file of the check
    uint32_t line_ = 0;
    std::string message_;
    uint32_t at_ = 0;
  };  // ForwardCheckError

  struct ForwardCheck {
    std::vector<ForwardCheckError> errors_;  // the first errors
    uint32_t errorCount_ = 0;
    double ms_           = 0.0;
  };  // ForwardCheck

  namespace Detail {
    constexpr size_t max_check_errors = 20;

    // a parse with no code generation, with the unsaved text of the open files
    class CheckFactory : public clang::tooling::FrontendActionFactory {
      const std::vector<Buffer>& buffers_;

     public:
      explicit CheckFactory(const std::vector<Buffer>& _buffers) : buffers_(_buffers) {}

      std::unique_ptr<clang::FrontendAction> create() override { return std::make_unique<clang::SyntaxOnlyAction>(); }

      bool runInvocation(std::shared_ptr<clang::CompilerInvocation> _inv, clang::FileManager* _files,
                         std::shared_ptr<clang::PCHContainerOperations> _pch,
                         clang::DiagnosticConsumer* _diags) override {
        clang::PreprocessorOptions& opts = _inv->getPreprocessorOpts();
        for (const Buffer& b : buffers_)
          opts.addRemappedFile(b.path_, llvm::MemoryBuffer::getMemBufferCopy(b.text_, b.path_).release());
        opts.RetainRemappedFileBuffers = false;  // the compiler instance deletes the buffers
        return clang::tooling::FrontendActionFactory::runInvocation(std::move(_inv), _files, std::move(_pch), _diags);
      }  // runInvocation

    };  // CheckFactory

    // collects the errors of a check, and the line of the first note of an error in the file of the check
    class CheckErrorCollector : public clang::DiagnosticConsumer {
      const std::string key_;  // the normalized path of the file of the check
      ForwardCheck& out_;
      bool isKept_ = false;  // the last error is in out_.errors_

     public:
      CheckErrorCollector(std::string _key, ForwardCheck& _out) : key_(std::move(_key)), out_(_out) {}

      void HandleDiagnostic(const clang::DiagnosticsEngine::Level _level, const clang::Diagnostic& _info) override {
        clang::DiagnosticConsumer::HandleDiagnostic(_level, _info);
        const auto [path, line] = place_of(_info);
        const bool isInFile     = !path.empty() && normalize_path(path) == key_;
        if (_level == clang::DiagnosticsEngine::Note) {
          ForwardCheckError* last = isKept_ ? &out_.errors_.back() : nullptr;
          if (last && !last->file_.empty() && last->at_ == 0 && isInFile) last->at_ = line;
          return;
        }
        if (_level < clang::DiagnosticsEngine::Error) return;
        ++out_.errorCount_;
        isKept_ = out_.errors_.size() < max_check_errors;
        if (!isKept_) return;
        llvm::SmallString<256> text;
        _info.FormatDiagnostic(text);
        out_.errors_.push_back({isInFile ? std::string() : path, line, std::string(text), 0});
      }  // HandleDiagnostic

     private:
      [[nodiscard]] static std::pair<std::string, uint32_t> place_of(const clang::Diagnostic& _info) {
        if (!_info.hasSourceManager() || _info.getLocation().isInvalid()) return {"", 0};
        const clang::SourceManager& sm = _info.getSourceManager();
        const clang::PresumedLoc at    = sm.getPresumedLoc(sm.getFileLoc(_info.getLocation()));
        if (at.isInvalid()) return {"", 0};
        return {at.getFilename(), at.getLine()};
      }  // place_of

    };  // CheckErrorCollector
  }  // namespace Detail

  // parses a copy of a file with a text in the place of an #include line, for example the forward declarations that can
  // replace the include. the text goes on one line, so the other lines keep their numbers. the copy is only in memory.
  // _buffers is the unsaved text of the open files
  [[nodiscard]] inline std::expected<ForwardCheck, std::string> check_forward(const Command& _cmd,
                                                                              std::vector<Buffer> _buffers,
                                                                              const std::string& _file,
                                                                              const uint32_t _line, std::string _text,
                                                                              const std::string& _resource_dir) {
    const auto start      = std::chrono::steady_clock::now();
    const std::string key = normalize_path(_file);

    // the unsaved text of the file, else the text on disk
    auto buffer           = llvm::find_if(_buffers, [&](const Buffer& _b) { return normalize_path(_b.path_) == key; });
    std::string text;
    if (buffer != _buffers.end()) {
      text = buffer->text_;
    } else if (const auto disk = llvm::MemoryBuffer::getFile(_file, false, false, true)) {
      text = (*disk)->getBuffer().str();
    } else {
      return std::unexpected("cannot read " + _file);
    }

    // the include line, with no \r at its end
    size_t begin = 0;
    for (uint32_t l = 1; l < _line && begin != std::string::npos; ++l) {
      begin = text.find('\n', begin);
      if (begin != std::string::npos) ++begin;
    }
    if (begin == std::string::npos || begin > text.size())
      return std::unexpected("the file has no line " + std::to_string(_line));
    size_t end = std::min(text.find('\n', begin), text.size());
    if (end > begin && text[end - 1] == '\r') --end;
    llvm::StringRef directive = llvm::StringRef(text).slice(begin, end).ltrim();
    if (!directive.consume_front("#") || !directive.ltrim().starts_with("include"))
      return std::unexpected("line " + std::to_string(_line) + " has no #include");
    std::ranges::replace(_text, '\n', ' ');
    std::ranges::replace(_text, '\r', ' ');
    text.replace(begin, end - begin, _text);
    if (buffer != _buffers.end())
      buffer->text_ = std::move(text);
    else
      _buffers.push_back({_file, std::move(text), 0});

    // the parse, with the builtin headers of the engine as in the parse of the file
    std::vector<std::string> args = _cmd.args_;
    if (!_resource_dir.empty() && !args.empty()) args.insert(args.begin() + 1, "-resource-dir=" + _resource_dir);
    llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem> fs(llvm::vfs::createPhysicalFileSystem().release());
    fs->setCurrentWorkingDirectory(_cmd.directory_);
    clang::FileSystemOptions fso;
    fso.WorkingDir   = _cmd.directory_;
    const auto files = llvm::makeIntrusiveRefCnt<clang::FileManager>(fso, fs);
    Detail::CheckFactory factory(_buffers);
    clang::tooling::ToolInvocation tool(std::move(args), &factory, files.get(),
                                        std::make_shared<clang::PCHContainerOperations>());
    ForwardCheck out;
    Detail::CheckErrorCollector collector(key, out);
    tool.setDiagnosticConsumer(&collector);
    tool.run();
    out.ms_ = elapsed_ms(start);
    return out;
  }  // check_forward

  //----------------------------------
  // Json

  namespace Detail {
    [[nodiscard]] inline const char* include_state_name(const IncludeState _state) {
      switch (_state) {
        case IncludeState::MAIN:
          return "main";
        case IncludeState::ENTERED:
          return "entered";
        case IncludeState::SKIPPED:
          return "skipped";
        case IncludeState::MISSING:
          return "missing";
      }
      return "missing";
    }  // include_state_name
  }  // namespace Detail

  [[nodiscard]] inline JsonObject includes_to_json(const IncludeModel& _model) {
    JsonArray files;
    for (const IncludeFile& f : _model.files_)
      files.push_back(
          JsonObject{{"path", f.path_}, {"lines", int64_t(f.lines_)}, {"group", f.group_}, {"isSystem", f.isSystem_}});

    JsonArray nodes;
    for (const IncludeNode& n : _model.nodes_) {
      JsonObject o{{"file", int64_t(n.file_)},
                   {"parent", int64_t(n.parent_)},
                   {"line", int64_t(n.line_)},
                   {"spelled", n.spelled_},
                   {"state", Detail::include_state_name(n.state_)}};
      if (n.first_ >= 0) o["first"] = int64_t(n.first_);
      if (n.isOwn_) o["isOwn"] = true;
      if (n.isUsed_) o["isUsed"] = *n.isUsed_;
      if (n.isUsed_.value_or(false))
        o["use"] = JsonObject{{"name", n.use_.name_}, {"line", int64_t(n.use_.line_)}, {"node", int64_t(n.use_.node_)}};
      if (const std::optional<IncludeForward>& f = n.forward_; f && f->isPossible_) {
        JsonArray types;
        for (const auto& [name, lines] : f->types_) {
          JsonArray at;
          for (const uint32_t line : lines) at.push_back(int64_t(line));
          types.push_back(JsonObject{{"name", name}, {"lines", std::move(at)}});
        }
        o["forward"] = JsonObject{{"state", "possible"}, {"text", f->text_}, {"types", std::move(types)}};
      } else if (f) {
        o["forward"] = JsonObject{
            {"state", "needed"},
            {"blocker",
             JsonObject{{"name", f->blockerName_}, {"kind", f->blockerKind_}, {"line", int64_t(f->blockerLine_)}}}};
      }
      nodes.push_back(std::move(o));
    }

    return JsonObject{{"files", std::move(files)},
                      {"nodes", std::move(nodes)},
                      {"preprocessMs", _model.preprocess_ms_},
                      {"passReused", _model.isPassReused_}};
  }  // includes_to_json

  // an error in a different file has its path, and "at": the line of its first note in the file of the check
  [[nodiscard]] inline JsonObject forward_check_to_json(const ForwardCheck& _check) {
    JsonArray errors;
    for (const ForwardCheckError& e : _check.errors_) {
      JsonObject o{{"line", int64_t(e.line_)}, {"message", e.message_}};
      if (!e.file_.empty()) o["file"] = e.file_;
      if (e.at_ > 0) o["at"] = int64_t(e.at_);
      errors.push_back(std::move(o));
    }
    return JsonObject{{"errorCount", int64_t(_check.errorCount_)}, {"errors", std::move(errors)}, {"ms", _check.ms_}};
  }  // forward_check_to_json

}  // namespace DataFlow
