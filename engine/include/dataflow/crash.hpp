#pragma once

#include <dataflow/defines.hpp>

/*
  The report of a crash. When a crash stops the engine in a request, for example an access violation, the engine writes
  one line to stderr before it stops:
    > dataflow-engine: the engine stopped in request <id>
  Then the client does not send this request again. A thread keeps the line of its request while it runs the request,
  so the handler of the crash writes the line with no allocation. main.cpp installs the handler
*/

namespace DataFlow {

  namespace Detail {
    // the line of the request of a thread. an empty line: the thread runs no request
    struct CrashLine {
      std::array<char, 128> text_{};
      size_t len_ = 0;
    };  // CrashLine

    inline thread_local CrashLine crash_line;
  }  // namespace Detail

  // the request of the thread while the scope lives
  class RequestScope {
    Detail::CrashLine old_;

   public:
    explicit RequestScope(const Json& _id) : old_(Detail::crash_line) {
      std::string text;
      llvm::raw_string_ostream os(text);
      os << "dataflow-engine: the engine stopped in request " << _id << "\n";
      os.flush();
      Detail::CrashLine& line = Detail::crash_line;
      line.len_               = std::min(text.size(), line.text_.size());
      std::memcpy(line.text_.data(), text.data(), line.len_);
    }

    // a thread that helps a request, for example a thread of the scan of the call graph, gets the line of the request
    explicit RequestScope(const Detail::CrashLine& _line) : old_(Detail::crash_line) { Detail::crash_line = _line; }

    RequestScope(const RequestScope&)            = delete;
    RequestScope& operator=(const RequestScope&) = delete;

    ~RequestScope() { Detail::crash_line = old_; }
  };  // RequestScope

  // true if the engine must stop in a request with this method for this file, for a test of the report. the
  // environment variable DATAFLOW_TEST_CRASH gives the method, or * for all methods, and DATAFLOW_TEST_CRASH_FILE the
  // end of the path of the file. with no DATAFLOW_TEST_CRASH_FILE, all files stop the engine
  [[nodiscard]] inline bool is_test_crash(const std::string& _method, const std::string& _file) {
    static const char* method = std::getenv("DATAFLOW_TEST_CRASH");
    static const char* file   = std::getenv("DATAFLOW_TEST_CRASH_FILE");
    return method && (std::string_view(method) == "*" || _method == method) &&
           (!file || llvm::StringRef(_file).ends_with_insensitive(file));
  }  // is_test_crash

  // an access violation, as a bug of an analysis can make it
  inline void crash_now() {
    volatile int* p = nullptr;
    *p              = 1;
  }  // crash_now

}  // namespace DataFlow
