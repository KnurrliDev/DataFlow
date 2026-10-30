#include <battery/worker_pool.hpp>

namespace electricity {

WorkerPool::WorkerPool(int count) {
  for (int i = 0; i < count; ++i)
    threads_.emplace_back([this]() {
      while (true) {
        std::function<void()> job;
        {
          std::unique_lock lock(mutex_);
          cv_.wait(lock, [this]() { return isStopping_ || !jobs_.empty(); });
          if (jobs_.empty())
            return;
          job = std::move(jobs_.front());
          jobs_.pop_front();
        }
        job();
      }
    });
}

void WorkerPool::post(std::function<void()> &&job) {
  {
    const std::lock_guard lock(mutex_);
    jobs_.push_back(std::move(job));
  }
  cv_.notify_one();
}

void WorkerPool::destroy() {
  {
    const std::lock_guard lock(mutex_);
    isStopping_ = true;
  }
  cv_.notify_all();
  for (std::thread &t : threads_)
    if (t.joinable())
      t.join();
  threads_.clear();
}

} // namespace electricity
