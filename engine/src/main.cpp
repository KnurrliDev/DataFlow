#include <dataflow/server.hpp>

int main(int argc, char** argv) {
  using namespace DataFlow;

  Protocol::init_stdio();
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
