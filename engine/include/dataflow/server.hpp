#pragma once

#include <dataflow/callgraph.hpp>
#include <dataflow/calls.hpp>
#include <dataflow/cost.hpp>
#include <dataflow/definition.hpp>
#include <dataflow/flow.hpp>
#include <dataflow/includers.hpp>
#include <dataflow/includes.hpp>
#include <dataflow/logic.hpp>
#include <dataflow/member.hpp>
#include <dataflow/metrics.hpp>
#include <dataflow/outline.hpp>
#include <dataflow/place.hpp>
#include <dataflow/protocol.hpp>
#include <dataflow/sites.hpp>
#include <dataflow/slice.hpp>
#include <dataflow/structure.hpp>
#include <dataflow/threads.hpp>
#include <dataflow/tokens.hpp>
#include <dataflow/tu_cache.hpp>
//
#include <llvm/Support/thread.h>

namespace DataFlow {

  // the status ready of a parse gives the number of the errors and a maximum of this number of errors
  inline constexpr size_t status_max_errors = 5;

  // runs jobs on a fixed number of threads
  class WorkerPool {
    std::vector<llvm::thread> threads_;
    std::deque<std::function<void()>> jobs_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool isStopping_ = false;

   public:
    // clang can need a deep stack for complex code, so each thread gets 8 MiB, as in clangd
    explicit WorkerPool(const uint32_t _count) {
      constexpr uint32_t stack_size = 8 << 20;
      for (uint32_t i = 0; i < std::max<uint32_t>(1, _count); ++i)
        threads_.emplace_back(std::optional<unsigned>(stack_size), [this]() {
          while (true) {
            std::function<void()> job;
            {
              std::unique_lock lock(mutex_);
              cv_.wait(lock, [this]() { return isStopping_ || !jobs_.empty(); });
              if (jobs_.empty()) return;  // stopping, and no work is left
              job = std::move(jobs_.front());
              jobs_.pop_front();
            }
            job();
          }
        });
    }

    WorkerPool(const WorkerPool&)            = delete;
    WorkerPool& operator=(const WorkerPool&) = delete;

    ~WorkerPool() { destroy(); }

    void post(std::function<void()>&& _job) {
      {
        const std::lock_guard lock(mutex_);
        jobs_.push_back(std::move(_job));
      }
      cv_.notify_one();
    }  // post

    // runs _fn on the calling thread and on up to _count - 1 other threads of the pool, and returns when all calls
    // ended. the calls must take their work from a shared counter. a call that would start after the calling thread
    // ended its own call does not run, so the calling thread never waits for threads that other jobs keep busy
    void run_on_threads(const uint32_t _count, const std::function<void()>& _fn) {
      struct Helpers {
        std::mutex mutex_;
        std::condition_variable cv_;
        uint32_t running_ = 0;
        bool isDone_      = false;
      };
      const auto helpers = std::make_shared<Helpers>();
      for (uint32_t i = 1; i < _count; ++i)
        post([helpers, &_fn]() {
          {
            const std::lock_guard lock(helpers->mutex_);
            if (helpers->isDone_) return;
            ++helpers->running_;
          }
          _fn();
          {
            const std::lock_guard lock(helpers->mutex_);
            --helpers->running_;
          }
          helpers->cv_.notify_all();
        });
      _fn();
      std::unique_lock lock(helpers->mutex_);
      helpers->isDone_ = true;
      helpers->cv_.wait(lock, [&]() { return helpers->running_ == 0; });
    }  // run_on_threads

    // finishes the queued jobs and joins the threads
    void destroy() {
      {
        const std::lock_guard lock(mutex_);
        isStopping_ = true;
      }
      cv_.notify_all();
      for (llvm::thread& t : threads_)
        if (t.joinable()) t.join();
      threads_.clear();
    }  // destroy

    [[nodiscard]] uint32_t get_count() const noexcept { return uint32_t(threads_.size()); }

  };  // WorkerPool

  struct Server {
    std::vector<CompileDb> dbs_;
    BufferStore buffers_;
    std::unique_ptr<TuCache> cache_;
    std::unique_ptr<WorkerPool> pool_;
    std::string resource_dir_;
    std::string default_resource_dir_;  // <exe folder>/lib/clang/<major>
    bool isInitialized_ = false;

    std::mutex cancel_mutex_;
    std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> cancels_;  // key: the request id as json

    // the files that a parse puts after the lines of the source file that includes them. key: the normalized path
    std::mutex context_mutex_;
    std::unordered_map<std::string, FileContext> contexts_;

    // the files that the source files of the compile databases include, for Included by. a request scans again if the
    // index is old
    std::mutex units_mutex_;
    std::shared_ptr<const UnitIndex> units_;

    // the call graph of the project for the reach of the heat score. one scan at a time works on a copy of the graph,
    // and the graph changes when the scan ends
    std::mutex graph_mutex_;
    std::shared_ptr<const ProjectGraph> graph_;
    bool isGraphScanning_ = false;
    size_t graphDone_ = 0, graphTotal_ = 0;    // the progress of the scan
    std::shared_ptr<const FramePaths> paths_;  // the frame paths of graph_ for pathNames_
    std::vector<std::string> pathNames_;
  };  // Server

  // a request that needs the ast of a file
  using FileWork  = std::function<std::expected<JsonObject, std::string>(clang::ASTUnit&)>;

  // a request that also needs the cache entry of the file, for example for data that it keeps for each parse
  using EntryWork = std::function<std::expected<JsonObject, std::string>(TuEntry&)>;

  namespace Detail {
    [[nodiscard]] inline std::string id_key(const Json& _id) {
      std::string out;
      llvm::raw_string_ostream os(out);
      os << _id;
      os.flush();
      return out;
    }  // id_key

    [[nodiscard]] inline std::optional<std::string> get_string(const JsonObject* _params, const llvm::StringRef _key) {
      if (!_params) return std::nullopt;
      const auto s = _params->getString(_key);
      return s ? std::optional<std::string>(s->str()) : std::nullopt;
    }  // get_string

    [[nodiscard]] inline std::optional<FileContext> context_of(Server& _srv, const std::string& _file) {
      const std::lock_guard lock(_srv.context_mutex_);
      const auto it = _srv.contexts_.find(normalize_path(_file));
      return it == _srv.contexts_.end() ? std::nullopt : std::optional(it->second);
    }  // context_of

    // makes the pass of the preprocessor of an entry current: the pass of an earlier parse if its key is the same, else
    // a new pass. a pass with a context gets the virtual file of the context. true if the pass is from an earlier
    // parse. call it only with the lock of the entry
    [[nodiscard]] inline std::expected<bool, std::string> update_include_pass(Server& _srv, TuEntry& _e,
                                                                              const std::string& _file) {
      const std::optional<FileContext> ctx = context_of(_srv, _file);
      const auto cmd                       = get_command(_srv.dbs_, _file, _srv.resource_dir_, ctx ? &*ctx : nullptr);
      if (!cmd) return std::unexpected(cmd.error());
      std::string key = include_pass_key(*cmd, *_e.ast_, _srv.buffers_.get_other_versions(_file));
      if (_e.include_pass_ && _e.include_pass_key_ == key) return true;
      std::vector<Buffer> buffers = _srv.buffers_.snapshot();
      if (ctx)
        if (std::optional<Buffer> b = context_buffer(*ctx, _file, buffers)) buffers.push_back(std::move(*b));
      _e.include_pass_     = std::make_shared<const IncludePass>(run_include_pass(*cmd, buffers, _srv.resource_dir_));
      _e.include_pass_key_ = std::move(key);
      return false;
    }  // update_include_pass

    // makes the tokens of an entry current: the tokens of the last parse stay in the entry. true if they were current.
    // call it only with the lock of the entry
    inline bool update_tokens(TuEntry& _e) {
      if (_e.tokens_ && _e.tokens_parse_ == _e.parse_count_) return true;
      _e.tokens_       = std::make_shared<const FileTokens>(build_file_tokens(*_e.ast_));
      _e.tokens_parse_ = _e.parse_count_;
      return false;
    }  // update_tokens

    // one string or an array of strings, for example compileCommands
    [[nodiscard]] inline std::vector<std::string> get_strings(const JsonObject* _params, const llvm::StringRef _key) {
      std::vector<std::string> out;
      if (!_params) return out;
      if (const auto one = _params->getString(_key)) out.push_back(one->str());
      if (const auto* many = _params->getArray(_key))
        for (const Json& v : *many)
          if (const auto s = v.getAsString()) out.push_back(s->str());
      return out;
    }  // get_strings

    // a complete call graph of the server with its frame paths, and the state of the call graph
    struct GraphView {
      std::shared_ptr<const ProjectGraph> graph_;  // null if the graph is not complete
      std::shared_ptr<const FramePaths> paths_;
      JsonObject state_;
    };  // GraphView

    // the state is none, scanning, partial or ready. a partial graph is from a first scan that stopped. _names: the
    // frame functions of the setting. with no _names, the view has no frame paths
    [[nodiscard]] inline GraphView graph_view(Server& _srv, const std::vector<std::string>* _names) {
      const std::lock_guard lock(_srv.graph_mutex_);
      GraphView out;
      const bool isComplete = _srv.graph_ && is_graph_complete(*_srv.graph_);
      const char* state = _srv.isGraphScanning_ ? "scanning" : !_srv.graph_ ? "none" : isComplete ? "ready" : "partial";
      out.state_        = JsonObject{{"state", state}};
      if (_srv.isGraphScanning_) {
        out.state_["done"]  = int64_t(_srv.graphDone_);
        out.state_["total"] = int64_t(_srv.graphTotal_);
      }
      if (!isComplete) return out;
      if (_names && (!_srv.paths_ || _srv.pathNames_ != *_names)) {
        _srv.paths_     = std::make_shared<const FramePaths>(frame_paths(*_srv.graph_, *_names));
        _srv.pathNames_ = *_names;
      }
      out.graph_ = _srv.graph_;
      if (_names) out.paths_ = _srv.paths_;
      return out;
    }  // graph_view

    [[nodiscard]] inline GraphView graph_view(Server& _srv, const std::vector<std::string>& _names) {
      return graph_view(_srv, &_names);
    }  // graph_view

    // the type of a request: by a name, with or without its namespaces, or the name at a position (line and col, from
    // 1). if more than one type ends with the name, the candidates give their qualified names
    struct RequestTag {
      const clang::TagDecl* tag_ = nullptr;
      std::vector<std::string> candidates_;
    };  // RequestTag

    [[nodiscard]] inline RequestTag request_tag(TuEntry& _e, const JsonObject& _params) {
      RequestTag out;
      clang::ASTContext& ctx = _e.ast_->getASTContext();
      if (const auto name = get_string(&_params, "name")) {
        out.tag_ = tag_by_name(ctx, *name);
        if (out.tag_) return out;
        const std::vector<const clang::TagDecl*> tags = tags_ending_with(ctx, *name);
        if (tags.size() == 1) out.tag_ = tags.front();
        if (tags.size() > 1)
          for (const clang::TagDecl* t : tags) out.candidates_.push_back(t->getQualifiedNameAsString());
      } else if (const auto line = _params.getInteger("line"), col = _params.getInteger("col");
                 line && col && *line > 0 && *col > 0) {
        update_tokens(_e);
        if (const FileToken* token = definition_token(*_e.tokens_, uint32_t(*line), uint32_t(*col)))
          if (const auto it = _e.tokens_->decls_.find(token->offset_); it != _e.tokens_->decls_.end())
            out.tag_ = outline_tag(it->second);
      }
      return out;
    }  // request_tag

    // the declaration of a type with no definition in the translation unit. the extension then looks for the header of
    // the definition
    [[nodiscard]] inline JsonObject tag_declaration_to_json(const clang::TagDecl& _tag) {
      JsonObject out =
          outline_place_to_json(outline_place(_tag.getASTContext().getSourceManager(), _tag.getLocation()));
      out["name"] = _tag.getQualifiedNameAsString();
      return out;
    }  // tag_declaration_to_json
  }  // namespace Detail

  // params: compileCommands, resourceDir, maxThreads, cacheSize
  [[nodiscard]] inline std::expected<Json, std::string> handle_initialize(Server& _srv, const JsonObject* _params) {
    if (_srv.isInitialized_) return std::unexpected("already initialized");
    const auto start = std::chrono::steady_clock::now();

    JsonArray dbs;
    for (const std::string& path : Detail::get_strings(_params, "compileCommands")) {
      auto db = load_compile_db(path);
      if (!db) {
        dbs.push_back(JsonObject{{"path", path}, {"error", db.error()}});
        continue;
      }
      dbs.push_back(JsonObject{{"path", path}, {"files", int64_t(db->files_.size())}});
      _srv.dbs_.push_back(std::move(*db));
    }

    // IMPORTANT: never more than 80% of the cores. the default is half of them
    const uint32_t cores       = std::max(1u, std::thread::hardware_concurrency());
    const uint32_t max_threads = std::max(1u, cores * 8 / 10);
    uint32_t threads           = std::max(1u, cores / 2);
    size_t cache_size          = 4;
    if (_params) {
      if (const auto n = _params->getInteger("maxThreads")) threads = uint32_t(std::clamp<int64_t>(*n, 1, max_threads));
      if (const auto n = _params->getInteger("cacheSize")) cache_size = size_t(std::clamp<int64_t>(*n, 1, 64));
    }

    _srv.resource_dir_  = Detail::get_string(_params, "resourceDir").value_or(_srv.default_resource_dir_);
    _srv.cache_         = std::make_unique<TuCache>(cache_size);
    _srv.pool_          = std::make_unique<WorkerPool>(threads);
    _srv.isInitialized_ = true;

    return JsonObject{
        {"name", "dataflow-engine"},   {"version", "0.5.0"},          {"clang", clang::getClangFullVersion()},
        {"databases", std::move(dbs)}, {"threads", int64_t(threads)}, {"cacheSize", int64_t(cache_size)},
        {"loadMs", elapsed_ms(start)}};
  }  // handle_initialize

  // runs a request on a worker: parse the file if necessary, then run _work on the entry
  inline void post_entry_request(Server& _srv, const Json& _id, const std::string& _file, EntryWork&& _work) {
    const std::string key = Detail::id_key(_id);
    auto cancelled        = std::make_shared<std::atomic<bool>>(false);
    {
      const std::lock_guard lock(_srv.cancel_mutex_);
      _srv.cancels_[key] = cancelled;
    }

    _srv.pool_->post([&_srv, id = _id, key, file = _file, work = std::move(_work), cancelled]() {
      const auto finish = [&](std::expected<Json, std::string>&& _res) {
        {
          const std::lock_guard lock(_srv.cancel_mutex_);
          _srv.cancels_.erase(key);
        }
        if (cancelled->load())
          Protocol::reply_error(id, Protocol::ec_request_cancelled, "request cancelled");
        else if (_res)
          Protocol::reply(id, std::move(*_res));
        else
          Protocol::reply_error(id, Protocol::ec_internal, _res.error());
      };
      if (cancelled->load()) return finish(Json(nullptr));

      const std::shared_ptr<TuEntry> entry = _srv.cache_->get(file);
      const std::lock_guard lock(entry->mutex_);

      const bool stale = !is_current(*entry, file, _srv.buffers_);
      if (stale) Protocol::notify("dataflow/status", JsonObject{{"file", file}, {"state", "parsing"}});
      const std::optional<FileContext> ctx = Detail::context_of(_srv, file);
      const auto parsed = update_tu(*entry, file, _srv.dbs_, _srv.buffers_, _srv.resource_dir_, ctx ? &*ctx : nullptr);
      if (!parsed) {
        Protocol::notify("dataflow/status", JsonObject{{"file", file}, {"state", "failed"}});
        return finish(std::unexpected(parsed.error()));
      }
      // a new parse: the status ready gives the number of the errors and the first errors
      if (*parsed) {
        JsonArray first;
        for (const std::string& msg : entry->diags_->get_messages()) {
          if (first.size() == status_max_errors) break;
          first.push_back(msg);
        }
        Protocol::notify("dataflow/status", JsonObject{{"file", file},
                                                       {"state", "ready"},
                                                       {"parseMs", entry->parse_ms_},
                                                       {"errorCount", int64_t(entry->diags_->get_count())},
                                                       {"errors", std::move(first)}});
      }
      if (cancelled->load()) return finish(Json(nullptr));

      const auto start = std::chrono::steady_clock::now();
      auto res         = work(*entry);
      if (!res) return finish(std::unexpected(res.error()));

      JsonArray errors;
      for (const std::string& msg : entry->diags_->get_messages()) errors.push_back(msg);
      (*res)["file"]       = file;
      (*res)["parsed"]     = *parsed;
      (*res)["parseMs"]    = entry->parse_ms_;
      (*res)["parseCount"] = int64_t(entry->parse_count_);
      (*res)["preambleBuilds"] = int64_t(entry->ast_->getPreambleCounterForTests());
      (*res)["errorCount"] = int64_t(entry->diags_->get_count());
      (*res)["errors"]     = std::move(errors);
      (*res)["analysisMs"] = elapsed_ms(start);
      finish(Json(std::move(*res)));
    });
  }  // post_entry_request

  // runs a request on a worker: parse the file if necessary, then run _work on the ast
  inline void post_file_request(Server& _srv, const Json& _id, const std::string& _file, FileWork&& _work) {
    post_entry_request(_srv, _id, _file, [work = std::move(_work)](TuEntry& _e) { return work(*_e.ast_); });
  }  // post_file_request

  // makes the call graph of the server current: a new graph for other project folders, else a scan of the source files
  // that need a scan. the scan runs on half of the threads of the pool, and sends dataflow/progress one time each
  // second. a cancel stops the scan. a stopped first scan keeps its source files for the next scan, and a stopped
  // update keeps the complete graph. params: roots, frameFunctions
  inline void post_call_graph(Server& _srv, const Json& _id, const JsonObject* _params) {
    {
      const std::lock_guard lock(_srv.graph_mutex_);
      if (_srv.isGraphScanning_)
        return Protocol::reply_error(_id, Protocol::ec_invalid_params, "a scan of the call graph runs");
      _srv.isGraphScanning_ = true;
      _srv.graphDone_       = 0;
      _srv.graphTotal_      = 0;
    }
    const std::string key = Detail::id_key(_id);
    auto cancelled        = std::make_shared<std::atomic<bool>>(false);
    {
      const std::lock_guard lock(_srv.cancel_mutex_);
      _srv.cancels_[key] = cancelled;
    }

    _srv.pool_->post([&_srv, id = _id, key, roots = Detail::get_strings(_params, "roots"),
                      names = Detail::get_strings(_params, "frameFunctions"), cancelled]() {
      const auto start = std::chrono::steady_clock::now();
      std::shared_ptr<const ProjectGraph> old;
      {
        const std::lock_guard lock(_srv.graph_mutex_);
        old = _srv.graph_;
      }
      const bool isSame                 = old && old->roots_ == roots;
      const bool wasComplete            = isSame && is_graph_complete(*old);
      const std::vector<Buffer> buffers = _srv.buffers_.snapshot();
      const uint32_t threads            = std::max(1u, _srv.pool_->get_count() / 2);
      const auto parallel = [&](const std::function<void()>& _fn) { _srv.pool_->run_on_threads(threads, _fn); };

      // the index of the includes gives the source files of a changed header. a new graph needs no index
      std::shared_ptr<const UnitIndex> index;
      if (isSame) {
        const std::lock_guard lock(_srv.units_mutex_);
        if (!_srv.units_ || is_index_old(*_srv.units_, roots, buffers_key(buffers)))
          _srv.units_ =
              std::make_shared<const UnitIndex>(build_unit_index(_srv.dbs_, _srv.resource_dir_, buffers, parallel));
        index = _srv.units_;
      }
      std::optional<ProjectGraph> fresh;
      if (!isSame) fresh = new_graph(_srv.dbs_, roots);
      const std::vector<size_t> todo = old_units(isSame ? *old : *fresh, index.get(), buffers);
      {
        const std::lock_guard lock(_srv.graph_mutex_);
        _srv.graphTotal_ = todo.size();
      }
      Protocol::notify("dataflow/progress",
                       JsonObject{{"id", id}, {"done", int64_t(0)}, {"total", int64_t(todo.size())}});

      // the progress one time each second, and at the end. the threads can tell their counts out of sequence
      std::mutex progress_mutex;
      auto sent         = std::chrono::steady_clock::now();
      size_t most       = 0;
      const auto report = [&](const size_t _done) {
        const std::lock_guard lock(progress_mutex);
        most = std::max(most, _done);
        {
          const std::lock_guard graph_lock(_srv.graph_mutex_);
          _srv.graphDone_ = most;
        }
        const auto now = std::chrono::steady_clock::now();
        if (most < todo.size() && now - sent < std::chrono::seconds(1)) return;
        sent = now;
        Protocol::notify("dataflow/progress",
                         JsonObject{{"id", id}, {"done", int64_t(most)}, {"total", int64_t(todo.size())}});
      };

      // the scan works on a copy, because the requests of the metrics read the graph
      std::shared_ptr<const ProjectGraph> result;
      if (!isSame || !todo.empty()) {
        ProjectGraph next     = isSame ? ProjectGraph(*old) : std::move(*fresh);
        const auto is_stopped = [&]() { return cancelled->load(); };
        const bool isComplete = todo.empty() || scan_graph(next, _srv.dbs_, _srv.resource_dir_, buffers, todo, parallel,
                                                           is_stopped, report);
        if (isComplete || !wasComplete) result = std::make_shared<const ProjectGraph>(std::move(next));
      }
      {
        const std::lock_guard lock(_srv.graph_mutex_);
        if (result) {
          _srv.graph_ = std::move(result);
          _srv.paths_.reset();
        }
        _srv.isGraphScanning_ = false;
      }
      {
        const std::lock_guard lock(_srv.cancel_mutex_);
        _srv.cancels_.erase(key);
      }
      if (cancelled->load()) return Protocol::reply_error(id, Protocol::ec_request_cancelled, "request cancelled");

      const Detail::GraphView view = Detail::graph_view(_srv, names);
      if (!view.graph_) return Protocol::reply_error(id, Protocol::ec_internal, "the call graph is not complete");
      JsonObject out = graph_to_json(*view.graph_, *view.paths_, todo.size());
      out["ms"]      = elapsed_ms(start);
      Protocol::reply(id, std::move(out));
    });
  }  // post_call_graph

  // the function of a request: by name (function) or by position (line and col, from 1). with a name, a line selects
  // one of the overloads
  [[nodiscard]] inline std::expected<const clang::FunctionDecl*, std::string> resolve_function(
      clang::ASTUnit& _ast, const JsonObject* _params) {
    const std::vector<const clang::FunctionDecl*> fns = main_file_functions(_ast);
    const clang::FunctionDecl* fn                     = nullptr;
    if (const auto name = Detail::get_string(_params, "function")) {
      const auto line = _params->getInteger("line");
      fn              = function_by_name(fns, *name, _ast.getSourceManager(),
                            line && *line > 0 ? std::optional(uint32_t(*line)) : std::nullopt);
    } else if (const auto line = _params->getInteger("line"))
      fn = function_at(fns, _ast.getSourceManager(), uint32_t(*line), uint32_t(_params->getInteger("col").value_or(1)));
    if (!fn) return std::unexpected("no function at this position or with this name");
    return fn;
  }  // resolve_function

  // the options of the threads analysis in a request, and the key of the options for the caches
  [[nodiscard]] inline std::pair<ThreadsOptions, std::string> threads_options(const JsonObject& _params) {
    ThreadsOptions opts;
    opts.async_functions_ = Detail::get_strings(&_params, "asyncFunctions");
    opts.roots_           = Detail::get_strings(&_params, "roots");
    std::string key;
    for (const std::vector<std::string>* list : {&opts.async_functions_, &opts.roots_}) {
      for (const std::string& s : *list) key += s + '\n';
      key += '\t';
    }
    return {std::move(opts), std::move(key)};
  }  // threads_options

  // the threads model of the parse of an entry. it stays in the entry until the next parse
  [[nodiscard]] inline std::shared_ptr<const ThreadsModel> threads_model(TuEntry& _e, const ThreadsOptions& _opts,
                                                                         const std::string& _key) {
    if (!_e.threads_model_ || _e.threads_model_parse_ != _e.parse_count_ || _e.threads_model_key_ != _key) {
      _e.threads_model_       = std::make_shared<const ThreadsModel>(build_threads(*_e.ast_, _opts));
      _e.threads_model_parse_ = _e.parse_count_;
      _e.threads_model_key_   = _key;
    }
    return _e.threads_model_;
  }  // threads_model

  // the threads of other source files that call functions of this unit, for a member trace
  [[nodiscard]] inline std::vector<ThreadEntry> thread_entries(const JsonObject& _params) {
    std::vector<ThreadEntry> out;
    if (const JsonArray* list = _params.getArray("entries"))
      for (const Json& j : *list)
        if (const JsonObject* o = j.getAsObject()) {
          const auto function = o->getString("function");
          if (!function) continue;
          out.push_back(ThreadEntry{function->str(), o->getString("via").value_or("").str(),
                                    o->getString("file").value_or("").str(),
                                    uint32_t(std::max<int64_t>(0, o->getInteger("line").value_or(0))),
                                    o->getBoolean("isRepeated").value_or(false)});
        }
    return out;
  }  // thread_entries

  // handles one message. requests that need a parse run on the worker pool
  inline void dispatch(Server& _srv, const std::string& _method, const Json* _id, const JsonObject* _params) {
    const auto reply = [&](std::expected<Json, std::string>&& _res) {
      if (!_id) return;
      if (_res)
        Protocol::reply(*_id, std::move(*_res));
      else
        Protocol::reply_error(*_id, Protocol::ec_invalid_params, _res.error());
    };

    // notifications
    if (_method == "$/cancelRequest") {
      const Json* target = _params ? _params->get("id") : nullptr;
      if (!target) return;
      const std::lock_guard lock(_srv.cancel_mutex_);
      if (const auto it = _srv.cancels_.find(Detail::id_key(*target)); it != _srv.cancels_.end())
        it->second->store(true);
      return;
    }
    if (_method == "textDocument/didOpen" || _method == "textDocument/didChange") {
      const auto file = Detail::get_string(_params, "file");
      const auto text = Detail::get_string(_params, "text");
      if (file && text) _srv.buffers_.set(*file, std::string(*text), _params->getInteger("version").value_or(0));
      return;
    }
    if (_method == "textDocument/didClose") {
      if (const auto file = Detail::get_string(_params, "file")) _srv.buffers_.remove(*file);
      return;
    }

    // the source file that includes a file, and the line of the #include. with no unit, the file has no context. a new
    // context makes a new parse of the file
    if (_method == "dataflow/context") {
      const auto file = Detail::get_string(_params, "file");
      if (!file) return;
      const auto unit = Detail::get_string(_params, "unit");
      const auto line = _params->getInteger("line");
      {
        const std::lock_guard lock(_srv.context_mutex_);
        if (unit && line && *line > 0)
          _srv.contexts_[normalize_path(*file)] = FileContext{*unit, uint32_t(*line)};
        else
          _srv.contexts_.erase(normalize_path(*file));
      }
      if (_srv.cache_) _srv.cache_->remove(*file);
      return;
    }

    // requests
    if (_method == "initialize") return reply(handle_initialize(_srv, _params));
    if (_method == "shutdown") return reply(Json(nullptr));
    if (!_id) return;
    if (!_srv.isInitialized_) return reply(std::unexpected("not initialized"));

    // the call graph of the project for the heat score. it needs no file
    if (_method == "dataflow/callGraph") return post_call_graph(_srv, *_id, _params);

    const auto file = Detail::get_string(_params, "file");
    if (!file) return reply(std::unexpected(_method + " needs a file"));

    if (_method == "dataflow/functions")
      return post_file_request(_srv, *_id, *file, [](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
        JsonArray out;
        for (const clang::FunctionDecl* f : main_file_functions(_ast))
          out.push_back(function_to_json(*f, _ast.getSourceManager()));
        return JsonObject{{"functions", std::move(out)}};
      });

    // the params object lives only during dispatch, so the work gets a copy
    const JsonObject params = *_params;

    // a parse of a copy of the file with forward declarations in the place of an include: the errors of the parse.
    // line: the line of the #include, text: the declarations. the copy is only in memory. the request does not wait for
    // the other requests of the file, because it does not use the parse of the file
    if (_method == "dataflow/checkForward") {
      const auto line = params.getInteger("line");
      const auto text = Detail::get_string(&params, "text");
      if (!line || *line < 1 || !text) return reply(std::unexpected("dataflow/checkForward needs a line and a text"));
      _srv.pool_->post([&srv = _srv, id = *_id, file = *file, line = uint32_t(*line), text = *text]() {
        const std::optional<FileContext> ctx = Detail::context_of(srv, file);
        const auto cmd                       = get_command(srv.dbs_, file, srv.resource_dir_, ctx ? &*ctx : nullptr);
        if (!cmd) return Protocol::reply_error(id, Protocol::ec_internal, cmd.error());
        std::vector<Buffer> buffers = srv.buffers_.snapshot();
        if (ctx)
          if (std::optional<Buffer> b = context_buffer(*ctx, file, buffers)) buffers.push_back(std::move(*b));
        const auto res = check_forward(*cmd, std::move(buffers), file, line, text, srv.resource_dir_);
        if (!res) return Protocol::reply_error(id, Protocol::ec_invalid_params, res.error());
        JsonObject out = forward_check_to_json(*res);
        out["file"]    = file;
        out["line"]    = int64_t(line);
        Protocol::reply(id, std::move(out));
      });
      return;
    }

    // the source files of the compile databases that include a file. the first request scans all source files on the
    // threads of the pool, with the unsaved text of the open files. a request after a change of a project file on disk
    // or of the directives of an open file scans again. roots: the project folders
    if (_method == "dataflow/includers") {
      _srv.pool_->post([&srv = _srv, id = *_id, file = *file, roots = Detail::get_strings(&params, "roots")]() {
        const auto start = std::chrono::steady_clock::now();
        std::shared_ptr<const UnitIndex> index;
        bool isScanned = false;
        {
          const std::lock_guard lock(srv.units_mutex_);
          const std::vector<Buffer> buffers = srv.buffers_.snapshot();
          if (!srv.units_ || is_index_old(*srv.units_, roots, buffers_key(buffers))) {
            const auto parallel = [&](const std::function<void()>& _fn) {
              srv.pool_->run_on_threads(srv.pool_->get_count(), _fn);
            };
            srv.units_ =
                std::make_shared<const UnitIndex>(build_unit_index(srv.dbs_, srv.resource_dir_, buffers, parallel));
            isScanned = true;
          }
          index = srv.units_;
        }
        JsonObject out = includers_to_json(*index, file);
        out["file"]    = file;
        out["scanned"] = isScanned;

        // the source files of the folders of the project with no build folders, for the include reach of the heat
        const GraphScope scope = graph_scope(srv.dbs_, roots);
        const std::string key  = normalize_path(file);
        int64_t projectUnits = 0, projectIncluders = 0;
        for (const std::string& u : index->unitKeys_) projectUnits += Detail::is_in_scope(scope, u) ? 1 : 0;
        if (const auto it = index->files_.find(key); it != index->files_.end())
          for (const int32_t u : index->includers_[size_t(it->second)]) {
            const std::string& unit = index->unitKeys_[size_t(u)];
            projectIncluders += unit != key && Detail::is_in_scope(scope, unit) ? 1 : 0;
          }
        out["projectUnits"]     = projectUnits;
        out["projectIncluders"] = projectIncluders;
        out["ms"]               = elapsed_ms(start);
        Protocol::reply(id, std::move(out));
      });
      return;
    }
    // the function at a position, and the innermost lambda in it at the position: its index and its range
    if (_method == "dataflow/functionAt")
      return post_file_request(
          _srv, *_id, *file, [params](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
            const auto fn = resolve_function(_ast, &params);
            JsonObject out{{"function", fn ? Json(function_to_json(**fn, _ast.getSourceManager())) : Json(nullptr)}};
            const auto line = params.getInteger("line"), col = params.getInteger("col");
            if (!fn || !line || !col) return out;
            const auto lambdas  = Detail::lambdas_of(**fn);
            const int32_t index = Detail::lambda_at(lambdas, _ast.getSourceManager(), uint32_t(*line), uint32_t(*col));
            if (index >= 0)
              out["lambda"] = JsonObject{
                  {"index", int64_t(index)},
                  {"range", Detail::range_to_json(_ast.getSourceManager(), lambdas[index]->getSourceRange())}};
            return out;
          });
    if (_method == "dataflow/cfg")
      return post_file_request(_srv, *_id, *file,
                               [params](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
                                 const auto fn = resolve_function(_ast, &params);
                                 if (!fn) return std::unexpected(fn.error());
                                 return JsonObject{{"function", function_to_json(**fn, _ast.getSourceManager())},
                                                   {"cfg", cfg_to_json(**fn, _ast.getASTContext())}};
                               });
    if (_method == "dataflow/optionalAccess")
      return post_file_request(_srv, *_id, *file,
                               [params](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
                                 const auto fn = resolve_function(_ast, &params);
                                 if (!fn) return std::unexpected(fn.error());
                                 auto res = optional_access_to_json(**fn, _ast.getASTContext());
                                 if (!res) return std::unexpected(res.error());
                                 return JsonObject{{"function", function_to_json(**fn, _ast.getSourceManager())},
                                                   {"unchecked", std::move(*res)}};
                               });
    if (_method == "dataflow/flow")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        clang::ASTUnit& ast = *_e.ast_;
        const auto fn       = resolve_function(ast, &params);
        if (!fn) return std::unexpected(fn.error());

        // the model of a function stays in the entry until the next parse
        const FlowOptions opts{Detail::get_strings(&params, "readFunctions")};
        std::string key = std::to_string(reinterpret_cast<uintptr_t>(*fn)) + '\t';
        for (const std::string& s : opts.read_functions_) key += s + '\n';
        if (_e.flows_parse_ != _e.parse_count_) {
          _e.flows_.clear();
          _e.flows_parse_ = _e.parse_count_;
        }
        if (!_e.flows_.contains(key) && _e.flows_.size() >= 64) _e.flows_.clear();
        std::shared_ptr<const JsonObject>& slot = _e.flows_[key];
        const bool isCached                     = slot != nullptr;
        if (!isCached) {
          JsonObject json  = flow_to_json(build_flow(**fn, ast.getASTContext(), opts), ast.getASTContext());
          json["function"] = function_to_json(**fn, ast.getSourceManager());
          slot             = std::make_shared<const JsonObject>(std::move(json));
        }
        JsonObject out = *slot;
        out["cached"]  = isCached;
        return out;
      });
    if (_method == "dataflow/member")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        clang::ASTUnit& ast = *_e.ast_;
        const MemberOptions opts{Detail::get_strings(&params, "asyncFunctions"),
                                 Detail::get_strings(&params, "readFunctions"), thread_entries(params)};
        const auto class_name         = Detail::get_string(&params, "className");
        const auto member_name        = Detail::get_string(&params, "member");
        const clang::ValueDecl* decl  = nullptr;
        const clang::FunctionDecl* fn = nullptr;

        // by the scope and the name, or at a position (line and col, from 1)
        if (class_name && member_name) {
          decl = field_by_name(ast.getASTContext(), *class_name, *member_name);
        } else if (const auto line = params.getInteger("line")) {
          const uint32_t col = uint32_t(params.getInteger("col").value_or(1));
          decl               = field_at(ast, uint32_t(*line), col);
          fn                 = function_at(main_file_functions(ast), ast.getSourceManager(), uint32_t(*line), col);
        }
        if (!decl) return JsonObject{{"member", nullptr}};

        // the threads analysis of the unit gives each access its threads, locks and order
        MemberModel model                                 = build_member(*decl, ast, opts);
        const auto [threads_opts, key]                    = threads_options(params);
        const std::shared_ptr<const ThreadsModel> threads = threads_model(_e, threads_opts, key);
        add_member_runs(model, *threads);
        JsonObject out  = member_to_json(model, ast.getASTContext());
        out["function"] = fn ? Json(function_to_json(*fn, ast.getSourceManager())) : Json(nullptr);
        return out;
      });
    // the logic of a function, or of a lambda in it: the lambda with the index "lambda", else the innermost lambda at
    // the position. a lambda gets the name <function>::(lambda <n>), with n from 1 in the sequence of the source
    if (_method == "dataflow/logic")
      return post_file_request(
          _srv, *_id, *file, [params](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
            const auto fn = resolve_function(_ast, &params);
            if (!fn) return std::unexpected(fn.error());
            const clang::SourceManager& sm = _ast.getSourceManager();
            const auto lambdas             = Detail::lambdas_of(**fn);
            int32_t index                  = -1;
            if (const auto n = params.getInteger("lambda"))
              index = *n >= 0 && *n < int64_t(lambdas.size()) ? int32_t(*n) : -1;
            else if (const auto line = params.getInteger("line"), col = params.getInteger("col"); line && col)
              index = Detail::lambda_at(lambdas, sm, uint32_t(*line), uint32_t(*col));
            const clang::FunctionDecl& target = index >= 0 ? *lambdas[index]->getCallOperator() : **fn;

            const LogicOptions opts{Detail::get_strings(&params, "eventFunctions"),
                                    Detail::get_strings(&params, "nullableFunctions"),
                                    Detail::get_strings(&params, "checkFunctions")};
            JsonObject out  = logic_to_json(build_logic(target, _ast.getASTContext(), opts), _ast.getASTContext());
            out["function"] = function_to_json(target, sm);
            if (index >= 0) {
              JsonObject& f      = *out.getObject("function");
              f["name"]          = "lambda";
              f["qualifiedName"] = (*fn)->getQualifiedNameAsString() + "::(lambda " + std::to_string(index + 1) + ")";
              f["range"]         = Detail::range_to_json(sm, lambdas[index]->getSourceRange());
              out["lambda"]      = int64_t(index);
              out["enclosing"]   = function_to_json(**fn, sm);
            }
            return out;
          });
    if (_method == "dataflow/structure")
      return post_file_request(_srv, *_id, *file,
                               [params](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
                                 const auto fn = resolve_function(_ast, &params);
                                 if (!fn) return std::unexpected(fn.error());
                                 const StructureOptions opts{Detail::get_strings(&params, "eventFunctions"),
                                                             Detail::get_strings(&params, "asyncFunctions")};
                                 JsonObject out  = structure_to_json(build_structure(**fn, _ast.getASTContext(), opts));
                                 out["function"] = function_to_json(**fn, _ast.getSourceManager());
                                 return out;
                               });
    // the metrics of the functions of the file for the heat score: decisions, depth, loops, writes and costs in loops.
    // with a complete call graph, also the reach of each function. frameFunctions: the frame functions of the setting.
    // testFolders: the folders of the tests, for the test functions among the callers
    if (_method == "dataflow/metrics")
      return post_file_request(_srv, *_id, *file,
                               [&srv = _srv, names = Detail::get_strings(&params, "frameFunctions"),
                                testFolders = Detail::get_strings(&params, "testFolders")](
                                   clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
                                 const std::vector<const clang::FunctionDecl*> fns = main_file_functions(_ast);
                                 const std::vector<FunctionMetrics> metrics =
                                     build_metrics(fns, main_file_instantiations(_ast), _ast.getASTContext());
                                 JsonObject out               = metrics_to_json(metrics, _ast.getSourceManager());
                                 const Detail::GraphView view = Detail::graph_view(srv, names);
                                 if (JsonArray* list = out.getArray("functions"); list && view.graph_) {
                                   const std::vector<char> tests = testFolders.empty()
                                                                       ? std::vector<char>()
                                                                       : test_nodes(*view.graph_, testFolders);
                                   for (size_t i = 0; i < metrics.size() && i < list->size(); ++i)
                                     if (JsonObject* o = (*list)[i].getAsObject())
                                       (*o)["reach"] =
                                           reach_to_json(*view.graph_, *view.paths_, *metrics[i].fn_, tests);
                                 }
                                 out["callGraph"] = JsonObject(view.state_);
                                 return out;
                               });
    // the callers of a function in the call graph up to a depth, with the lines of their calls, and its frame paths.
    // params: function, or line and col; depth (default 3, maximum 6); frameFunctions
    if (_method == "dataflow/callers")
      return post_file_request(_srv, *_id, *file,
                               [&srv = _srv, params, names = Detail::get_strings(&params, "frameFunctions")](
                                   clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
                                 const auto fn = resolve_function(_ast, &params);
                                 if (!fn) return std::unexpected(fn.error());
                                 const auto depth =
                                     uint32_t(std::clamp<int64_t>(params.getInteger("depth").value_or(3), 1, 6));
                                 const Detail::GraphView view = Detail::graph_view(srv, names);
                                 JsonObject out;
                                 if (view.graph_) {
                                   Json callers = callers_to_json(*view.graph_, *view.paths_, **fn, depth, 200);
                                   if (const JsonObject* o = callers.getAsObject()) out = *o;
                                 }
                                 // with no complete graph, or with no node for the function: its name and the state
                                 if (!out.get("function")) out["function"] = (*fn)->getQualifiedNameAsString();
                                 out["callGraph"] = JsonObject(view.state_);
                                 return out;
                               });
    // the facts of a line for a hook in the code: the function, the statements around the line, the locks at the start
    // of the line, and the reach of the function in the call graph. params: line (from 1); frameFunctions
    if (_method == "dataflow/place")
      return post_file_request(
          _srv, *_id, *file,
          [&srv = _srv, line = params.getInteger("line"), names = Detail::get_strings(&params, "frameFunctions")](
              clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
            if (!line || *line < 1) return std::unexpected("dataflow/place needs a line");
            const Place place            = build_place(_ast, uint32_t(*line));
            JsonObject out               = place_to_json(place, _ast.getSourceManager());
            const Detail::GraphView view = Detail::graph_view(srv, names);
            out["reach"] =
                place.fn_ && view.graph_ ? reach_to_json(*view.graph_, *view.paths_, *place.fn_) : Json(nullptr);
            out["callGraph"] = JsonObject(view.state_);
            return out;
          });
    // with a unit, the hidden c++ of a header in the translation unit of a source file that includes it. thus the
    // templates of the header get the items of their instantiations in the source file
    if (_method == "dataflow/cost") {
      const std::optional<std::string> unit = Detail::get_string(&params, "unit");
      return post_file_request(
          _srv, *_id, unit.value_or(*file),
          [params,
           focus = unit ? *file : std::string()](clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
            CostOptions opts;
            if (const auto n = params.getInteger("minCopyBytes"))
              opts.min_copy_bytes_ = uint64_t(std::max<int64_t>(0, *n));
            const std::vector<const clang::FunctionDecl*> fns =
                focus.empty() ? main_file_functions(_ast) : file_functions(_ast, focus);
            const Instantiations insts =
                focus.empty() ? main_file_instantiations(_ast) : file_instantiations(_ast, focus);
            return cost_to_json(build_costs(fns, insts, _ast.getASTContext(), opts), fns, _ast.getASTContext());
          });
    }
    if (_method == "dataflow/slice")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        clang::ASTUnit& ast = *_e.ast_;
        SliceOptions opts;
        opts.async_functions_        = Detail::get_strings(&params, "asyncFunctions");
        const std::string confidence = Detail::get_string(&params, "confidence").value_or("exact");
        if (confidence == "call") opts.confidence_ = Confidence::CALL;
        if (confidence == "estimated") opts.confidence_ = Confidence::ESTIMATED;

        SliceSeed seed;
        if (const JsonArray* lines = params.getArray("lines"))
          for (const Json& l : *lines)
            if (const auto n = l.getAsInteger(); n && *n > 0) seed.lines_.push_back(uint32_t(*n));
        if (const JsonArray* deleted = params.getArray("deleted"))
          for (const Json& d : *deleted) {
            const JsonObject* o = d.getAsObject();
            const auto line     = o ? o->getInteger("line") : std::nullopt;
            if (line && *line > 0) seed.deleted_.emplace_back(uint32_t(*line), o->getString("text").value_or("").str());
          }
        if (const JsonObject* call = params.getObject("call"))
          if (const auto line = call->getInteger("line"))
            seed.call_ = std::pair(uint32_t(*line), uint32_t(call->getInteger("col").value_or(1)));
        if (seed.lines_.empty() && seed.deleted_.empty() && !seed.call_)
          return std::unexpected("dataflow/slice needs lines or a call");

        // the body models stay in the entry until the next parse
        if (!_e.slices_ || _e.slices_parse_ != _e.parse_count_) {
          _e.slices_       = std::make_shared<SliceCache>();
          _e.slices_parse_ = _e.parse_count_;
        }
        const std::vector<const clang::FunctionDecl*> fns = main_file_functions(ast);
        return slice_to_json(build_slice(fns, seed, ast.getASTContext(), opts, *_e.slices_), fns, ast.getASTContext());
      });
    if (_method == "dataflow/calls")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        // the graph of a parse stays in the entry until the next parse
        CallOptions opts;
        opts.event_functions_ = Detail::get_strings(&params, "eventFunctions");
        opts.async_functions_ = Detail::get_strings(&params, "asyncFunctions");
        opts.roots_           = Detail::get_strings(&params, "roots");
        std::string key;
        for (const std::vector<std::string>* list : {&opts.event_functions_, &opts.async_functions_, &opts.roots_}) {
          for (const std::string& s : *list) key += s + '\n';
          key += '\t';
        }
        const bool isCached = _e.calls_ && _e.calls_parse_ == _e.parse_count_ && _e.calls_key_ == key;
        if (!isCached) {
          _e.calls_ = std::make_shared<const JsonObject>(
              calls_to_json(build_calls(*_e.ast_, opts), _e.ast_->getASTContext(), opts));
          _e.calls_parse_ = _e.parse_count_;
          _e.calls_key_   = std::move(key);
        }
        JsonObject out = *_e.calls_;
        out["cached"]  = isCached;
        return out;
      });
    if (_method == "dataflow/threads")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        // the result of a parse stays in the entry until the next parse. the member traces use the same model
        auto [opts, key]    = threads_options(params);
        const bool isCached = _e.threads_ && _e.threads_parse_ == _e.parse_count_ && _e.threads_key_ == key;
        if (!isCached) {
          const auto start                                = std::chrono::steady_clock::now();
          const std::shared_ptr<const ThreadsModel> model = threads_model(_e, opts, key);
          const auto built                                = std::chrono::steady_clock::now();
          JsonObject json                                 = threads_to_json(*model, _e.ast_->getASTContext());
          json["buildMs"]          = std::chrono::duration<double, std::milli>(built - start).count();
          _e.threads_              = std::make_shared<const JsonObject>(std::move(json));
          _e.threads_ms_ = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
          _e.threads_parse_ = _e.parse_count_;
          _e.threads_key_   = std::move(key);
        }
        JsonObject out    = *_e.threads_;
        out["cached"]     = isCached;
        out["analysisMs"] = _e.threads_ms_;
        return out;
      });
    if (_method == "dataflow/includes")
      return post_entry_request(
          _srv, *_id, *file,
          [&srv = _srv, params, file = *file](TuEntry& _e) -> std::expected<JsonObject, std::string> {
            // the result of a parse stays in the entry until the next parse
            IncludeOptions opts;
            opts.roots_     = Detail::get_strings(&params, "roots");
            opts.hasErrors_ = _e.diags_->get_count() > 0;
            std::string roots;
            for (const std::string& r : opts.roots_) roots += r + '\n';
            const bool isCached = _e.includes_ && _e.includes_parse_ == _e.parse_count_ && _e.includes_roots_ == roots;
            if (!isCached) {
              const auto isPassReused = Detail::update_include_pass(srv, _e, file);
              if (!isPassReused) return std::unexpected(isPassReused.error());
              IncludeModel model   = build_includes(*_e.include_pass_, *_e.ast_, srv.resource_dir_, opts);
              model.preprocess_ms_ = *isPassReused ? 0.0 : _e.include_pass_->ms_;
              model.isPassReused_  = *isPassReused;
              _e.includes_         = std::make_shared<const IncludeModel>(std::move(model));
              _e.includes_parse_   = _e.parse_count_;
              _e.includes_roots_   = std::move(roots);
            }
            JsonObject out = includes_to_json(*_e.includes_);
            out["cached"]  = isCached;
            return out;
          });
    // the lines of the main file in the ranges that a condition of the preprocessor skips, for example in #if 0. the
    // pass of the preprocessor of Include Hierarchy gives them. a file with no condition needs no pass
    if (_method == "dataflow/inactive")
      return post_entry_request(_srv, *_id, *file,
                                [&srv = _srv, file = *file](TuEntry& _e) -> std::expected<JsonObject, std::string> {
                                  JsonArray ranges;
                                  const clang::SourceManager& sm = _e.ast_->getSourceManager();
                                  if (has_conditions(sm.getBufferData(sm.getMainFileID()))) {
                                    const auto isPassReused = Detail::update_include_pass(srv, _e, file);
                                    if (!isPassReused) return std::unexpected(isPassReused.error());
                                    for (const auto& [first, last] : _e.include_pass_->skipped_)
                                      if (last >= first) ranges.push_back(JsonArray{int64_t(first), int64_t(last)});
                                  }
                                  return JsonObject{{"ranges", std::move(ranges)}};
                                });
    if (_method == "dataflow/tokens")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        // the tokens of a parse stay in the entry, because the side view asks for the lines in parts
        const bool isCached  = Detail::update_tokens(_e);
        const int64_t first  = std::clamp<int64_t>(params.getInteger("first").value_or(1), 1, INT32_MAX);
        const int64_t last   = std::clamp<int64_t>(params.getInteger("last").value_or(INT32_MAX), 0, INT32_MAX);
        // the level of a bracket among the brackets of its type, for the setting of vs code that gives each type its
        // own colors
        const bool isPerType = params.getBoolean("bracketLevelPerType").value_or(false);
        JsonObject out       = tokens_to_json(*_e.tokens_, uint32_t(first), uint32_t(last), isPerType);
        out["version"]       = _e.version_;
        out["cached"]        = isCached;
        return out;
      });
    // the definition of the name at a position (line and col, from 1): a name, a macro or the file of an #include. the
    // tokens of the parse give the name and its declaration
    if (_method == "dataflow/definition")
      return post_entry_request(
          _srv, *_id, *file,
          [&srv = _srv, params, file = *file](TuEntry& _e) -> std::expected<JsonObject, std::string> {
            const auto line = params.getInteger("line"), col = params.getInteger("col");
            if (!line || !col || *line < 1 || *col < 1)
              return std::unexpected("the request needs line and col, from 1");
            Detail::update_tokens(_e);
            const FileToken* token = definition_token(*_e.tokens_, uint32_t(*line), uint32_t(*col));
            if (!token) return definition_to_json({});
            if (is_include_file(*_e.tokens_, *token)) {
              const auto isPassReused = Detail::update_include_pass(srv, _e, file);
              if (!isPassReused) return std::unexpected(isPassReused.error());
              return definition_to_json(include_definition(*_e.include_pass_, uint32_t(*line)));
            }
            return definition_to_json(name_definition(*_e.ast_, *_e.tokens_, *token));
          });
    // the outline of the class, the struct, the union or the enum of the name at a position (line and col, from 1), or
    // of a qualified name. a type with no definition in the translation unit gives its declaration
    if (_method == "dataflow/outline")
      return post_entry_request(_srv, *_id, *file, [params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
        // a name with no namespaces, or with only a part of them, needs a search. more than one match gives the
        // candidates
        const Detail::RequestTag found = Detail::request_tag(_e, params);
        if (!found.candidates_.empty())
          return JsonObject{{"outline", nullptr}, {"candidates", JsonArray(found.candidates_)}};
        if (!found.tag_) return JsonObject{{"outline", nullptr}};
        if (const clang::TagDecl* def = found.tag_->getDefinition())
          return JsonObject{{"outline", outline_to_json(build_outline(*def, _e.ast_->getASTContext()))}};
        return JsonObject{{"outline", nullptr}, {"declaration", Detail::tag_declaration_to_json(*found.tag_)}};
      });
    // the sites of the members of a type in the index of the call graph: the functions that use the data members of a
    // record, or the switch statements on an enum. the type: name, or the name at a position (line and col, from 1)
    if (_method == "dataflow/memberSites")
      return post_entry_request(
          _srv, *_id, *file, [&srv = _srv, params](TuEntry& _e) -> std::expected<JsonObject, std::string> {
            const Detail::RequestTag found = Detail::request_tag(_e, params);
            if (!found.candidates_.empty())
              return JsonObject{{"type", nullptr}, {"candidates", JsonArray(found.candidates_)}};
            if (!found.tag_) return JsonObject{{"type", nullptr}};
            const clang::TagDecl* def = found.tag_->getDefinition();
            if (!def)
              return JsonObject{{"type", nullptr}, {"declaration", Detail::tag_declaration_to_json(*found.tag_)}};
            const Detail::GraphView view = Detail::graph_view(srv, nullptr);
            JsonObject out               = llvm::isa<clang::EnumDecl>(def)
                                               ? enum_sites_to_json(view.graph_.get(), *llvm::cast<clang::EnumDecl>(def))
                                               : record_sites_to_json(view.graph_.get(), *llvm::cast<clang::RecordDecl>(def));
            out["type"]                  = tag_to_json(*def);
            out["callGraph"]             = JsonObject(view.state_);
            return out;
          });
    // the facts of the data members of the classes, the structs and the unions of the file for the heat, from the index
    // of the call graph. frameFunctions: the frame functions of the setting
    if (_method == "dataflow/memberMetrics")
      return post_file_request(_srv, *_id, *file,
                               [&srv = _srv, names = Detail::get_strings(&params, "frameFunctions")](
                                   clang::ASTUnit& _ast) -> std::expected<JsonObject, std::string> {
                                 const Detail::GraphView view = Detail::graph_view(srv, names);
                                 JsonObject out   = member_metrics_to_json(main_file_records(_ast), view.graph_.get(),
                                                                           view.paths_.get());
                                 out["callGraph"] = JsonObject(view.state_);
                                 return out;
                               });

    Protocol::reply_error(*_id, Protocol::ec_method_not_found, "unknown method: " + _method);
  }  // dispatch

}  // namespace DataFlow
