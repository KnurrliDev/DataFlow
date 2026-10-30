#pragma once

#include <dataflow/defines.hpp>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

/*
  JSON-RPC 2.0 over stdio, with the message headers of LSP:
    > Content-Length: <bytes>\r\n
    > \r\n
    > <json body>
*/

namespace DataFlow::Protocol {

  // json-rpc error codes
  constexpr int32_t ec_invalid_params    = -32602;
  constexpr int32_t ec_method_not_found  = -32601;
  constexpr int32_t ec_internal          = -32603;
  constexpr int32_t ec_request_cancelled = -32800;

  // binary mode stops windows from changing the line ends
  inline void init_stdio() noexcept {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
  }  // init_stdio

  // reads one message. returns nullopt at the end of the input
  [[nodiscard]] inline std::optional<std::string> read_message() {
    constexpr std::string_view key = "Content-Length:";
    size_t length                  = 0;
    std::string line;

    // read the headers. an empty line ends them
    while (true) {
      line.clear();
      int c = 0;
      while ((c = std::fgetc(stdin)) != EOF && c != '\n') line.push_back(char(c));
      if (c == EOF) return std::nullopt;
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) break;
      if (line.starts_with(key)) {
        const std::string_view num = std::string_view(line).substr(key.size());
        const size_t first         = num.find_first_not_of(' ');
        if (first != std::string_view::npos) std::from_chars(num.data() + first, num.data() + num.size(), length);
      }
    }

    std::string out(length, '\0');
    if (std::fread(out.data(), 1, length, stdin) != length) return std::nullopt;
    return out;
  }  // read_message

  // IMPORTANT: worker threads write replies at the same time. the lock keeps each message in one piece
  inline void write_message(const Json& _msg) {
    static std::mutex write_mutex;

    std::string body;
    llvm::raw_string_ostream os(body);
    os << _msg;
    os.flush();

    const std::lock_guard lock(write_mutex);
    std::fprintf(stdout, "Content-Length: %zu\r\n\r\n", body.size());
    std::fwrite(body.data(), 1, body.size(), stdout);
    std::fflush(stdout);
  }  // write_message

  inline void notify(const std::string& _method, Json&& _params) {
    write_message(JsonObject{{"jsonrpc", "2.0"}, {"method", _method}, {"params", std::move(_params)}});
  }  // notify

  inline void reply(const Json& _id, Json&& _result) {
    write_message(JsonObject{{"jsonrpc", "2.0"}, {"id", _id}, {"result", std::move(_result)}});
  }  // reply

  inline void reply_error(const Json& _id, const int32_t _code, const std::string& _message) {
    write_message(
        JsonObject{{"jsonrpc", "2.0"}, {"id", _id}, {"error", JsonObject{{"code", _code}, {"message", _message}}}});
  }  // reply_error

}  // namespace DataFlow::Protocol
