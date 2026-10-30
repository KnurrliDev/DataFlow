#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace electricity {

// a pool of worker threads. Its member functions are in two source files
class WorkerPool {
  std::vector<std::thread> threads_;
  std::deque<std::function<void()>> jobs_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool isStopping_ = false;

public:
  explicit WorkerPool(int count);
  void post(std::function<void()> &&job);
  void destroy();
  bool is_stopping();
  size_t queued();
};

} // namespace electricity
