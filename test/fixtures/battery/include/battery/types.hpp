#pragma once

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

// small stub types of a charge planner, only for the tests

namespace charge {

struct Timeline {
  int length = 0;
};

struct CostModel {
  Timeline win;
  double evaluate(const std::vector<double> &kw) const { return kw.empty() ? 1.0 : kw[0]; }
};

struct Context {
  CostModel costFn;
};

struct Schedule {
  std::vector<double> kw;
};

struct Preset {
  int id = 0;
  std::vector<double> kw;
  double value = 0.0;
};

using PresetDb = std::vector<Preset>;

struct Optimizer {
  Context context;
  Schedule schedule;
  std::optional<double> last_cost;
};

struct State {
  bool is_dirty = false;
  std::map<int, Optimizer> optimizers;
};

inline std::vector<double> initial_power(const Timeline &win) { return std::vector<double>(win.length, 0.0); }
inline bool isValidKw(const Timeline &win, const std::vector<double> &kw) { return int(kw.size()) == win.length; }

} // namespace charge

namespace electricity::power_ctrl {

constexpr int main_optimizer_id = 0;

std::optional<charge::Preset> best_preset(const charge::PresetDb &presetDb, const charge::CostModel &costModel,
                                          const std::set<std::string> &filter);
void log_info(const std::string &text);

auto initial_power(const charge::Context &context, const charge::Schedule &schedule, bool usePreset,
                   const charge::PresetDb &presetDb, std::set<std::string> filter)
    -> std::optional<std::vector<double>>;
std::optional<double> solve_power_plan(charge::State &charge);

} // namespace electricity::power_ctrl

// stub of the executor of taskflow. async runs a callable on a different thread and returns a future
namespace tf {

template <class T>
struct Future {
  T value;
  bool is_ready() const { return true; }
  T get() { return value; }
};

struct Executor {
  template <class F>
  auto async(F &&f) -> Future<decltype(f())> { return {f()}; }
};

} // namespace tf

// the stub types of the controller in process()

#define FINISHED(f) ((f).is_ready())

namespace electricity::power_ctrl {

enum ChargeCtlState {
  HOMEPOWER_CHARGE_PLANNING,
  HOMEPOWER_CHARGE_ACTIVE,
  HOMEPOWER_METER_READING,
  HOMEPOWER_METER_STABLE
};

enum OperationalMode { POWER_MANUAL, POWER_AUTO };

struct TariffTable {
  int id = 0;
};

struct ElectricityTariffSet {
  std::map<int, TariffTable> tariff_plans;
  std::set<int> active;
};

struct OperationalSettings {
  double meter_hold_time = 500.0;
  double meter_silent_timeout = 5000.0;
  int reading_count_limit = 10;
};

struct Timer {
  double elapsed_ms() const { return 0.0; }
  void reset() {}
};

// the result of solve_power_plan(), from a different thread
using ChargingFuture = tf::Future<std::optional<double>>;

struct GridStatus {
  std::vector<double> phases;
  std::vector<double> line_loads;
};

struct PowerData {
  double m[4][4] = {};
};

struct MeterRead {
  GridStatus state;
  PowerData tap2bus;
  std::string busId;
  std::string tapId;
  long long timestamp = 0;
};

struct Requests {
  int count = 0;
};

struct HomeBatteryCtrl {
  ChargeCtlState state = HOMEPOWER_METER_READING;
  OperationalMode operational_mode = POWER_AUTO;
  ElectricityTariffSet electricityTariffSet;
  OperationalSettings operational_settings;
  std::optional<ChargingFuture> charging_future;
  charge::State planned_charge;
  Timer meter_clk;
  bool is_charging_underway = false;
  std::vector<MeterRead> reading_db;
  std::vector<MeterRead> new_readings;
};

// returns a null pointer if the map has no value for the key
template <class Map, class Key>
auto get_if(Map &map, const Key &key) -> typename Map::mapped_type * {
  auto it = map.find(key);
  return it == map.end() ? nullptr : &it->second;
}

void fire_transition(HomeBatteryCtrl &home_battery_ctl, const std::string &event, bool force = false);
void pick_next_price_slot(OperationalSettings &settings);
bool compute_and_store_schedule(TariffTable *tariff_plan, OperationalSettings &settings, charge::State &charge);
std::vector<MeterRead> stable_readings(double settle_time);
std::vector<MeterRead> drop_readings_already_stored(const std::vector<MeterRead> &recorded, std::vector<MeterRead> data);
Requests make_requests(const charge::Context &context, const charge::Schedule &schedule, const TariffTable &tariff_plan);
std::optional<Requests> process(tf::Executor &executor, HomeBatteryCtrl &home_battery_ctl, charge::State &charge);

} // namespace electricity::power_ctrl

// the stub types of the meter feeds for stable_readings()

namespace electricity::power_ctrl {

struct TapSample {
  PowerData powerData;
  long long timestamp = 0;
};

struct MeterFeeds {
  std::vector<std::string> feeders;
  // returns a new map for each call
  std::map<std::string, PowerData> get_channels(const std::string &feeder) const;
  const std::vector<TapSample> &history(const std::string &point) const;
};

bool is_nearly(const PowerData &a, const PowerData &b);
std::vector<MeterRead> stable_readings(const MeterFeeds &stream, const GridStatus &state, long long settle_ms);

} // namespace electricity::power_ctrl
