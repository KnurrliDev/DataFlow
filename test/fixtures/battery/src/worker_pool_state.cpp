#include <battery/worker_pool.hpp>

namespace electricity {

// the state of the pool, in a second source file of the class
bool WorkerPool::is_stopping() {
  const std::lock_guard lock(mutex_);
  return isStopping_;
}

size_t WorkerPool::queued() {
  const std::lock_guard lock(mutex_);
  return jobs_.size();
}

} // namespace electricity
