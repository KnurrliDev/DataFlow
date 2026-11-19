#include <dataflow/server.hpp>
//
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <unistd.h>

#include <csignal>
#endif

namespace DataFlow::Detail {

  // writes the line of the request of the crashed thread to stderr. then the crash stops the engine as before, with the
  // same exit code
#ifdef _WIN32
  inline LONG WINAPI report_crash(EXCEPTION_POINTERS*) {
    const CrashLine& line = crash_line;
    DWORD written         = 0;
    if (line.len_ > 0)
      WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.text_.data(), DWORD(line.len_), &written, nullptr);
    return EXCEPTION_CONTINUE_SEARCH;
  }  // report_crash
#else
  inline void report_crash(const int _signal) {
    const CrashLine& line = crash_line;
    if (line.len_ > 0) (void)!write(STDERR_FILENO, line.text_.data(), line.len_);
    std::signal(_signal, SIG_DFL);
    std::raise(_signal);
  }  // report_crash
#endif

  inline void install_crash_report() {
#ifdef _WIN32
    SetUnhandledExceptionFilter(report_crash);
#else
    for (const int s : {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT}) std::signal(s, report_crash);
#endif
  }  // install_crash_report

}  // namespace DataFlow::Detail

int main(int argc, char** argv) {
  using namespace DataFlow;

  Protocol::init_stdio();
  Detail::install_crash_report();
  Server srv;

  // the builtin headers of clang are next to the engine, as with clang itself
  llvm::SmallString<256> dir(llvm::sys::path::parent_path(llvm::sys::fs::getMainExecutable(argv[0], (void*)&main)));
  llvm::sys::path::append(dir, "lib", "clang", CLANG_VERSION_MAJOR_STRING);
  srv.default_resource_dir_ = std::string(dir);
  (void)argc;

  while (const auto msg = Protocol::read_message()) {
    auto parsed = llvm::json::parse(*msg);
    if (!parsed) {
      llvm::errs() << "bad message: " << llvm::toString(parsed.takeError()) << "\n";
      continue;
    }
    const JsonObject* obj = parsed->getAsObject();
    if (!obj) continue;
    const auto method = obj->getString("method");
    if (!method) continue;
    if (*method == "exit") break;

    dispatch(srv, method->str(), obj->get("id"), obj->getObject("params"));
  }

  // cancel the open requests, then wait for the workers
  {
    const std::lock_guard lock(srv.cancel_mutex_);
    for (auto& [key, flag] : srv.cancels_) flag->store(true);
  }
  if (srv.pool_) srv.pool_->destroy();
  return 0;
}
