#include <battery/types.hpp>

// the main loop of the controller: one call of process() in each cycle
int main() {
  tf::Executor executor;
  electricity::power_ctrl::HomeBatteryCtrl home_battery_ctl;
  charge::State charge;
  int sent = 0;
  for (int cycle = 0; cycle < 100; ++cycle) {
    auto requests = electricity::power_ctrl::process(executor, home_battery_ctl, charge);
    if (requests) {
      sent += requests->count;
    }
  }
  return sent > 0 ? 0 : 1;
}
