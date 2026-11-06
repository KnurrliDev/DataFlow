#pragma once

#include <battery/types.hpp>
#include <battery/worker_pool.hpp>

namespace electricity::power_ctrl {

// a planner for Include Hierarchy. It uses the types of types.hpp only through pointers and references, so forward
// declarations can replace that include. It has a WorkerPool by value, so it needs worker_pool.hpp
class Planner {
  WorkerPool pool_;
  const MeterRead *lastRead_ = nullptr;

public:
  void plan(const charge::State &state, charge::Schedule *schedule);
  const charge::Preset *best(const charge::CostModel &costModel) const;
};

} // namespace electricity::power_ctrl
