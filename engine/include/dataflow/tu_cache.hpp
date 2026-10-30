#pragma once

#include <dataflow/compile_db.hpp>

namespace DataFlow {

  struct FileTokens;    // tokens.hpp
  struct IncludeModel;  // includes.hpp
  struct IncludePass;   // includes.hpp
  struct ThreadsModel;  // threads.hpp
  struct SliceCache;    // slice.hpp

  // counts the errors of a parse and keeps the first messages
  class ErrorCollector : public clang::DiagnosticConsumer {
    std::vector<std::string> messages_;
    uint32_t count_ = 0;

   public:
    void HandleDiagnostic(clang::DiagnosticsEngine::Level _level, const clang::Diagnostic& _info) override {
      clang::DiagnosticConsumer::HandleDiagnostic(_level, _info);
      if (_level < clang::DiagnosticsEngine::Error) return;
      ++count_;
      if (messages_.size() >= 5) return;

      llvm::SmallString<256> msg;
      _info.FormatDiagnostic(msg);
      std::string where;
      if (_info.hasSourceManager() && _info.getLocation().isValid()) {
        const clang::PresumedLoc loc = _info.getSourceManager().getPresumedLoc(_info.getLocation());
        if (loc.isValid()) where = std::string(loc.getFilename()) + ":" + std::to_string(loc.getLine()) + ": ";
      }
      messages_.push_back(where + std::string(msg));
    }  // HandleDiagnostic

    void reset() noexcept {
      messages_.clear();
      count_ = 0;
    }

    [[nodiscard]] const std::vector<std::string>& get_messages() const noexcept { return messages_; }

    [[nodiscard]] uint32_t get_count() const noexcept { return count_; }

  };  // ErrorCollector

  // the text of a file that is open in the editor. it can differ from the file on disk
  struct Buffer {
    std::string path_;  // the path as the client gave it
    std::string text_;
    int64_t version_ = 0;
  };  // Buffer

  class BufferStore {
    std::unordered_map<std::string, Buffer> files_;  // key: the normalized path
    mutable std::mutex mutex_;

   public:
    void set(const std::string& _path, std::string&& _text, const int64_t _version) {
      const std::lock_guard lock(mutex_);
      files_[normalize_path(_path)] = Buffer{_path, std::move(_text), _version};
    }

    void remove(const std::string& _path) {
      const std::lock_guard lock(mutex_);
      files_.erase(normalize_path(_path));
    }

    // the version of the buffer of a file. -1 means that the parse reads the file on disk
    [[nodiscard]] int64_t get_version(const std::string& _path) const {
      const std::lock_guard lock(mutex_);
      const auto it = files_.find(normalize_path(_path));
      return it == files_.end() ? -1 : it->second.version_;
    }

    // a copy of all buffers for one parse
    [[nodiscard]] std::vector<Buffer> snapshot() const {
      const std::lock_guard lock(mutex_);
      std::vector<Buffer> out;
      out.reserve(files_.size());
      for (const auto& [key, buf] : files_) out.push_back(buf);
      return out;
    }

    // the versions of the buffers of all files except _file, by the normalized path. a parse of _file uses these
    // buffers, so a new version of an included header makes the parse old
    [[nodiscard]] std::map<std::string, int64_t> get_other_versions(const std::string& _file) const {
      const std::string self = normalize_path(_file);
      const std::lock_guard lock(mutex_);
      std::map<std::string, int64_t> out;
      for (const auto& [key, buf] : files_)
        if (key != self) out.emplace(key, buf.version_);
      return out;
    }

  };  // BufferStore

  struct TuEntry {
    std::mutex mutex_;  // one parse or analysis at a time

    // IMPORTANT: diags_ comes before ast_. the ast keeps a pointer to diags_, so diags_ must live longer
    std::unique_ptr<ErrorCollector> diags_;
    std::shared_ptr<clang::DiagnosticOptions> diag_opts_;
    std::unique_ptr<clang::ASTUnit> ast_;

    int64_t version_      = -2;  // the buffer version of the last parse. -1 is the file on disk
    std::map<std::string, int64_t> others_;  // the versions of the buffers of the other files at the last parse
    double parse_ms_      = 0.0;
    uint32_t parse_count_ = 0;  // the number of the last parse, from last_parse_number
    std::string db_path_;

    // the tokens of the main file. they agree with the ast only if tokens_parse_ is parse_count_
    std::shared_ptr<const FileTokens> tokens_;
    uint32_t tokens_parse_ = 0;

    // the include hierarchy of the parse includes_parse_, for the project folders includes_roots_. the pass of the
    // preprocessor stays for the next parses while its key is the same
    std::shared_ptr<const IncludeModel> includes_;
    uint32_t includes_parse_ = 0;
    std::string includes_roots_;
    std::shared_ptr<const IncludePass> include_pass_;
    std::string include_pass_key_;

    // the call graph of the parse calls_parse_, as json, for the options calls_key_
    std::shared_ptr<const JsonObject> calls_;
    uint32_t calls_parse_ = 0;
    std::string calls_key_;

    // the threads and the shared data of the parse threads_parse_, as json, for the options threads_key_
    std::shared_ptr<const JsonObject> threads_;
    uint32_t threads_parse_ = 0;
    std::string threads_key_;
    double threads_ms_ = 0.0;

    // the flow models of the parse flows_parse_, as json. the key is the function and the options
    std::unordered_map<std::string, std::shared_ptr<const JsonObject>> flows_;
    uint32_t flows_parse_ = 0;

    // the threads model of the parse threads_model_parse_ for the options threads_model_key_. the threads lens and the
    // member traces use it
    std::shared_ptr<const ThreadsModel> threads_model_;
    uint32_t threads_model_parse_ = 0;
    std::string threads_model_key_;

    // the body models of the slices of the parse slices_parse_
    std::shared_ptr<SliceCache> slices_;
    uint32_t slices_parse_ = 0;
  };  // TuEntry

  // true if the ast of the entry is the parse of the current buffers: the buffer of the file and the buffers of the
  // other open files, because the file can include them
  [[nodiscard]] inline bool is_current(const TuEntry& _e, const std::string& _file, const BufferStore& _buffers) {
    return _e.ast_ && _e.version_ == _buffers.get_version(_file) && _e.others_ == _buffers.get_other_versions(_file);
  }  // is_current

  // keeps the parsed translation units. when it is full, it removes the unit that was used least recently
  class TuCache {
    std::unordered_map<std::string, std::shared_ptr<TuEntry>> entries_;
    std::unordered_map<std::string, uint64_t> last_use_;
    std::mutex mutex_;
    size_t capacity_ = 4;
    uint64_t tick_   = 0;

   public:
    explicit TuCache(const size_t _capacity) : capacity_(std::max<size_t>(1, _capacity)) {}

    // the entry of a file. a removed entry stays alive while a request uses it
    [[nodiscard]] std::shared_ptr<TuEntry> get(const std::string& _file) {
      const std::string key = normalize_path(_file);
      const std::lock_guard lock(mutex_);

      std::shared_ptr<TuEntry>& slot = entries_[key];
      if (!slot) slot = std::make_shared<TuEntry>();
      std::shared_ptr<TuEntry> out = slot;
      last_use_[key]               = ++tick_;

      while (entries_.size() > capacity_) {
        const auto oldest = std::ranges::min_element(last_use_, {}, [](const auto& _p) { return _p.second; });
        entries_.erase(oldest->first);
        last_use_.erase(oldest);
      }
      return out;
    }  // get

    [[nodiscard]] size_t get_size() {
      const std::lock_guard lock(mutex_);
      return entries_.size();
    }

    // removes the entry of a file, for example after a change of its command. the next request parses the file again
    void remove(const std::string& _file) {
      const std::string key = normalize_path(_file);
      const std::lock_guard lock(mutex_);
      entries_.erase(key);
      last_use_.erase(key);
    }  // remove

  };  // TuCache

  // the virtual file of a context: the lines of the source file before the #include. the text of the source file comes
  // from its buffer, or from the file on disk. nullopt if the engine cannot read the source file
  [[nodiscard]] inline std::optional<Buffer> context_buffer(const FileContext& _ctx, const std::string& _file,
                                                            const std::vector<Buffer>& _buffers) {
    const std::string unit = normalize_path(_ctx.unit_);
    std::string text;
    if (const auto it =
            std::ranges::find_if(_buffers, [&](const Buffer& _b) { return normalize_path(_b.path_) == unit; });
        it != _buffers.end())
      text = it->text_;
    else if (auto file = llvm::MemoryBuffer::getFile(_ctx.unit_))
      text = (*file)->getBuffer().str();
    else
      return std::nullopt;
    return Buffer{context_path(_ctx, _file), context_text(text, _ctx), 0};
  }  // context_buffer

  // the number of the last parse of all entries. each parse gets a new number. thus a client can tell two parses of a
  // file apart, also after the cache removed the entry of the file
  inline std::atomic<uint32_t> last_parse_number{0};

  // makes the ast of an entry current: a first parse, or a reparse when the text of the file or of a different open
  // file changed. the preamble of clang stays if no header of the preamble changed. returns true if it parsed. call it
  // only with the lock of the entry. with a context, the virtual file with the lines of the source file comes first
  [[nodiscard]] inline std::expected<bool, std::string> update_tu(TuEntry& _e, const std::string& _file,
                                                                  const std::vector<CompileDb>& _dbs,
                                                                  const BufferStore& _buffers,
                                                                  const std::string& _resource_dir,
                                                                  const FileContext* _ctx = nullptr) {
    if (is_current(_e, _file, _buffers)) return false;
    const int64_t version                       = _buffers.get_version(_file);
    const std::map<std::string, int64_t> others = _buffers.get_other_versions(_file);

    const auto start    = std::chrono::steady_clock::now();
    static auto pch_ops = std::make_shared<clang::PCHContainerOperations>();

    // the ast takes the ownership of these buffers
    std::vector<clang::ASTUnit::RemappedFile> remapped;
    const std::vector<Buffer> buffers = _buffers.snapshot();
    for (const Buffer& b : buffers)
      remapped.emplace_back(b.path_, llvm::MemoryBuffer::getMemBufferCopy(b.text_, b.path_).release());
    if (_ctx) {
      std::optional<Buffer> b = context_buffer(*_ctx, _file, buffers);
      if (!b) return std::unexpected("cannot read " + _ctx->unit_);
      remapped.emplace_back(b->path_, llvm::MemoryBuffer::getMemBufferCopy(b->text_, b->path_).release());
    }

    // reparse: the preamble stays, only the main file is parsed again
    if (_e.ast_) {
      _e.diags_->reset();
      if (_e.ast_->Reparse(pch_ops, remapped)) return std::unexpected("reparse failed: " + _file);
    }

    // first parse
    else {
      const auto cmd = get_command(_dbs, _file, _resource_dir, _ctx);
      if (!cmd) return std::unexpected(cmd.error());

      std::vector<const char*> argv;
      argv.reserve(cmd->args_.size());
      for (const std::string& a : cmd->args_) argv.push_back(a.c_str());

      // a file system with the working directory of the command. relative paths in the command need it
      llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem> fs(llvm::vfs::createPhysicalFileSystem().release());
      fs->setCurrentWorkingDirectory(cmd->directory_);

      _e.diags_     = std::make_unique<ErrorCollector>();
      _e.diag_opts_ = std::make_shared<clang::DiagnosticOptions>();
      auto diags    = clang::CompilerInstance::createDiagnostics(*fs, *_e.diag_opts_, _e.diags_.get(), false);

      constexpr bool preambles_in_memory     = true;
      constexpr uint32_t preamble_after      = 1;     // build the preamble with the first parse
      constexpr bool user_files_are_volatile = true;  // read the files, do not map them. windows locks mapped files
      _e.ast_                                = clang::CreateASTUnitFromCommandLine(
          argv.data(), argv.data() + argv.size(), pch_ops, _e.diag_opts_, diags, _resource_dir, preambles_in_memory, {},
          false, clang::CaptureDiagsKind::None, remapped, true, preamble_after, clang::TU_Complete, false, false, false,
          clang::SkipFunctionBodiesScope::None, false, user_files_are_volatile, false, false, std::nullopt, nullptr,
          fs);
      if (!_e.ast_) {
        const auto& msgs = _e.diags_->get_messages();
        return std::unexpected("parse failed: " + _file + (msgs.empty() ? "" : ": " + msgs.front()));
      }
      _e.db_path_ = cmd->db_path_;
    }

    _e.version_     = version;
    _e.others_      = others;
    _e.parse_ms_    = elapsed_ms(start);
    _e.parse_count_ = ++last_parse_number;
    _e.slices_.reset();  // the body models point into the old ast
    return true;
  }  // update_tu

}  // namespace DataFlow
