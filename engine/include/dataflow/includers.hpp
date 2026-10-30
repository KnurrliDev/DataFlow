#pragma once

#include <dataflow/includes.hpp>

/*
  The source files of the compile databases that include a file, for Included by of Include Hierarchy:
    > the dependency scanner of clang runs the preprocessor of each source file with only the directives of each file.
      thus #if, the include folders and the macros of each command count, and a scan of all source files takes seconds
    > the scanner reads the unsaved text of the open files and the other files on disk
    > the index keeps the files of each source file. a file in the project folders that changed on disk after the scan,
      or a change of the directives of an open file, makes the index old, and the next request scans again
*/

namespace DataFlow {

  // the files that the source files of the compile databases include
  struct UnitIndex {
    std::vector<std::string> units_;                  // the source files, as the compile databases give them
    std::vector<std::string> unitKeys_;               // the key of the path of each source file
    std::vector<std::string> paths_;                  // the files that the source files include
    std::unordered_map<std::string, int32_t> files_;  // the key of a path -> the file in paths_
    std::vector<std::vector<int32_t>> includers_;     // the source files that include each file in paths_
    std::vector<std::string> failed_;                 // the source files that the scanner could not scan
    std::string buffersKey_;                          // the directives of the open files at the scan
    llvm::sys::TimePoint<> time_;                     // the start of the scan
    double ms_ = 0.0;
  };  // UnitIndex

  namespace Detail {
    // the paths of an open file for the file system of the scanner. on windows, the client and a compile database can
    // write the drive letter in different case
    [[nodiscard]] inline std::vector<std::string> buffer_paths(const std::string& _path) {
      std::vector<std::string> out{_path};
      if (_path.size() > 1 && _path[1] == ':' && std::isalpha(uint8_t(_path[0]))) {
        std::string other = _path;
        other[0]          = std::isupper(uint8_t(other[0])) ? char(std::tolower(uint8_t(other[0])))
                                                            : char(std::toupper(uint8_t(other[0])));
        out.push_back(std::move(other));
      }
      return out;
    }  // buffer_paths
  }  // namespace Detail

  // the key of the open files for the index: the path and the directive lines of each open file. a directive can
  // continue on the next line after a backslash
  [[nodiscard]] inline std::string buffers_key(const std::vector<Buffer>& _buffers) {
    std::vector<std::pair<std::string, const Buffer*>> sorted;
    for (const Buffer& b : _buffers) sorted.emplace_back(normalize_path(b.path_), &b);
    std::ranges::sort(sorted, {}, &std::pair<std::string, const Buffer*>::first);
    std::string out;
    for (const auto& [key, b] : sorted) {
      out += key + '\n';
      bool isContinued = false;
      for (llvm::StringRef rest = b->text_; !rest.empty();) {
        auto [line, next] = rest.split('\n');
        rest              = next;
        line              = line.rtrim('\r');
        if (!isContinued && !line.ltrim().starts_with("#")) continue;
        out += line.str() + '\n';
        isContinued = line.ends_with("\\");
      }
    }
    return out;
  }  // buffers_key

  // scans the source files of the compile databases with the unsaved text of the open files. _parallel(_fn) runs _fn on
  // one or more threads at the same time. the calls of _fn take the source files from a shared counter
  template <class Parallel>
  [[nodiscard]] inline UnitIndex build_unit_index(const std::vector<CompileDb>& _dbs, const std::string& _resource_dir,
                                                  const std::vector<Buffer>& _buffers, Parallel&& _parallel) {
    const auto start = std::chrono::steady_clock::now();
    UnitIndex out;
    out.time_       = std::chrono::time_point_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now());
    out.buffersKey_ = buffers_key(_buffers);

    // each source file one time, with its database
    std::vector<const CompileDb*> dbOf;
    std::unordered_set<std::string> seen;
    for (const CompileDb& db : _dbs)
      for (const std::string& f : db.db_->getAllFiles()) {
        std::string key = normalize_path(f);
        if (!seen.insert(key).second) continue;
        out.units_.push_back(f);
        out.unitKeys_.push_back(std::move(key));
        dbOf.push_back(&db);
      }

    // the files of each source file. each thread has its own tool. the service keeps the directives of each file for
    // all threads, so the scan reads a header one time
    std::vector<std::optional<std::vector<std::string>>> deps(out.units_.size());
    clang::dependencies::DependencyScanningServiceOptions opts;
    opts.EmitWarnings = false;
    opts.MakeVFS      = [buffers = std::make_shared<const std::vector<Buffer>>(_buffers)]() {
      const auto overlay = llvm::makeIntrusiveRefCnt<llvm::vfs::OverlayFileSystem>(
          llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem>(llvm::vfs::createPhysicalFileSystem().release()));
      const auto memory = llvm::makeIntrusiveRefCnt<llvm::vfs::InMemoryFileSystem>();
      for (const Buffer& b : *buffers)
        for (const std::string& p : Detail::buffer_paths(b.path_))
          memory->addFile(p, 0, llvm::MemoryBuffer::getMemBufferCopy(b.text_, p));
      overlay->pushOverlay(memory);
      return llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem>(overlay);
    };
    clang::dependencies::DependencyScanningService service(std::move(opts));
    std::atomic<size_t> next = 0;
    _parallel([&]() {
      clang::tooling::DependencyScanningTool tool(service);
      clang::IgnoringDiagConsumer ignore;
      const llvm::DenseSet<clang::dependencies::ModuleID> modules;
      const auto no_output = [](const clang::dependencies::ModuleDeps&, clang::dependencies::ModuleOutputKind) {
        return std::string();
      };
      for (size_t i = next++; i < out.units_.size(); i = next++) {
        auto cmd = db_command(*dbOf[i], out.units_[i], _resource_dir);
        if (!cmd || cmd->args_.empty()) continue;
        if (!_resource_dir.empty()) cmd->args_.insert(cmd->args_.begin() + 1, "-resource-dir=" + _resource_dir);
        auto res = tool.getTranslationUnitDependencies(cmd->args_, cmd->directory_, ignore, modules, no_output);
        if (res) deps[i] = std::move(res->FileDeps);
      }
    });

    // the source files of each file
    for (size_t u = 0; u < out.units_.size(); ++u) {
      if (!deps[u]) {
        out.failed_.push_back(out.units_[u]);
        continue;
      }
      for (const std::string& f : *deps[u]) {
        const auto [it, isNew] = out.files_.try_emplace(normalize_path(f), int32_t(out.paths_.size()));
        if (isNew) {
          out.paths_.push_back(f);
          out.includers_.emplace_back();
        }
        out.includers_[it->second].push_back(int32_t(u));
      }
    }
    out.ms_ = elapsed_ms(start);
    return out;
  }  // build_unit_index

  // true if the directives of the open files changed, or if a file of the index in the project folders changed on disk
  // after the scan. the files out of the project folders, for example the headers of the standard library, stay the
  // same. with no folders, all files count. the index also has the headers that a source file includes but the scanner
  // did not find. such a header that came later is newer than the scan, and so is a source file that the scanner did
  // not find. _buffersKey: the key of the open files now
  [[nodiscard]] inline bool is_index_old(const UnitIndex& _index, const std::vector<std::string>& _roots,
                                         const std::string& _buffersKey) {
    if (_buffersKey != _index.buffersKey_) return true;
    std::vector<std::string> roots;
    for (const std::string& r : _roots) roots.push_back(normalize_path(r));
    const auto is_changed = [&](const std::string& _path, const std::string& _key) {
      if (!roots.empty() &&
          std::ranges::none_of(roots, [&](const std::string& _r) { return Detail::is_under(_key, _r); }))
        return false;
      llvm::sys::fs::file_status st;
      return !llvm::sys::fs::status(_path, st) && st.getLastModificationTime() > _index.time_;
    };
    for (size_t u = 0; u < _index.units_.size(); ++u)
      if (is_changed(_index.units_[u], _index.unitKeys_[u])) return true;
    for (const auto& [key, i] : _index.files_)
      if (is_changed(_index.paths_[i], key)) return true;
    return false;
  }  // is_index_old

  //----------------------------------
  // Json

  // the source files that include a file, sorted. a source file does not include itself
  [[nodiscard]] inline JsonObject includers_to_json(const UnitIndex& _index, const std::string& _file) {
    const std::string key = normalize_path(_file);
    std::vector<std::string> units;
    if (const auto it = _index.files_.find(key); it != _index.files_.end())
      for (const int32_t u : _index.includers_[it->second])
        if (_index.unitKeys_[u] != key) units.push_back(_index.units_[u]);
    std::ranges::sort(units);
    return JsonObject{{"units", JsonArray(units)},
                      {"unitCount", int64_t(_index.units_.size())},
                      {"failed", JsonArray(_index.failed_)},
                      {"isUnit", llvm::is_contained(_index.unitKeys_, key)},
                      {"scanMs", _index.ms_}};
  }  // includers_to_json

}  // namespace DataFlow
