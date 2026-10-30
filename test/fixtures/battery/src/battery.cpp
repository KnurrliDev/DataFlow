#include <battery/types.hpp>

#include <algorithm>
#include <cmath>
#include <format>

namespace electricity::power_ctrl {

std::optional<charge::Preset> best_preset(const charge::PresetDb &presetDb, const charge::CostModel &costModel,
                                          const std::set<std::string> &filter) {
  if (presetDb.empty() || filter.contains("skip"))
    return std::nullopt;
  return presetDb.front();
}

void log_info(const std::string &text) { (void)text; }

auto initial_power(const charge::Context &context, const charge::Schedule &schedule,
                   bool usePreset, const charge::PresetDb &presetDb,
                   std::set<std::string> filter) -> std::optional<std::vector<double>> {

  struct StartPlan {
    std::string kind = "";
    std::vector<double> kw;
    double value;
  };
  std::vector<StartPlan> startPlans;

  {
    std::vector<double> kw = charge::initial_power(context.costFn.win);
    startPlans.push_back({"context", kw, context.costFn.evaluate(kw)});
  }

  // the kw of the active plan
  if (charge::isValidKw(context.costFn.win, schedule.kw)) {
    startPlans.push_back({"charge", schedule.kw, context.costFn.evaluate(schedule.kw)});
  }

  // kw of the best preset
  if (usePreset) {
    auto bestFit = best_preset(presetDb, context.costFn, filter);
    if (bestFit) {
      startPlans.push_back(
          {std::format("preset `{}`", bestFit->id), bestFit->kw, bestFit->value});
    }
    log_info(std::format("used preset `{}`", std::to_string(bestFit->id)));
  }
  std::sort(
      startPlans.begin(), startPlans.end(),
      [](const StartPlan &a, const StartPlan &b) -> bool { return a.value < b.value; });
  log_info(std::format("picked start at {}", startPlans[0].kind));
  auto kw = startPlans[0].kw;

  if (charge::isValidKw(context.costFn.win, kw))
    return kw;
  return {};
}

std::optional<double> solve_power_plan(charge::State &charge) {
  std::optional<double> res;
  while (charge.is_dirty) {
    auto &opt = charge.optimizers[main_optimizer_id];
    auto kw = initial_power(opt.context, opt.schedule, false, {}, {});
    if (kw) {
      opt.schedule.kw = *kw;
    }
    double cost = opt.context.costFn.evaluate(opt.schedule.kw);
    if (opt.last_cost && std::abs(cost - *opt.last_cost) < 1e-7) {
      if (cost < 1e-5) {
        res = cost;
      }
      break;
    }
    opt.last_cost = cost;
  }
  charge.is_dirty = false;
  return res;
}

} // namespace electricity::power_ctrl

namespace electricity::power_ctrl {

// the state machine of the battery controller: one call in each cycle of the main loop
std::optional<Requests> process(tf::Executor &executor, HomeBatteryCtrl &home_battery_ctl, charge::State &charge) {
  auto &tariff_plans = home_battery_ctl.electricityTariffSet;
  auto &settings = home_battery_ctl.operational_settings;
  std::optional<Requests> requests = std::nullopt;
  if (tariff_plans.active.size() == 0) {
    return std::nullopt;
  }
  auto cur_tariff_plan = get_if(tariff_plans.tariff_plans, *tariff_plans.active.begin());

  if (charge.is_dirty && !home_battery_ctl.charging_future) {
    home_battery_ctl.charging_future = executor.async([&]() { return solve_power_plan(charge); });
  }

  fire_transition(home_battery_ctl, "", true);

  if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING) {
    if (home_battery_ctl.charging_future && FINISHED(*home_battery_ctl.charging_future)) {
      auto converged = home_battery_ctl.charging_future->get();
      home_battery_ctl.charging_future.reset();
      if (converged) {
        log_info("the schedule converged");
        if (home_battery_ctl.operational_mode == POWER_AUTO) {
          home_battery_ctl.is_charging_underway = true;
          auto &opt = home_battery_ctl.planned_charge.optimizers[main_optimizer_id];
          requests = make_requests(opt.context, opt.schedule, *cur_tariff_plan);
        }
        fire_transition(home_battery_ctl, "_planned");
      } else {
        // with no converged schedule, try the next price slot
        if (home_battery_ctl.operational_mode == POWER_AUTO) {
          pick_next_price_slot(settings);
          auto res = compute_and_store_schedule(cur_tariff_plan, settings, charge);
          if (!res) {
            fire_transition(home_battery_ctl, "stop");
          }
        } else {
          fire_transition(home_battery_ctl, "_planned");
        }
      }
    }
  } else if (home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE) {
    if (!home_battery_ctl.is_charging_underway) {
      if (home_battery_ctl.operational_mode == POWER_AUTO) {
        pick_next_price_slot(settings);
        auto res = compute_and_store_schedule(cur_tariff_plan, settings, charge);
        if (!res) {
          fire_transition(home_battery_ctl, "stop");
          return std::nullopt;
        }
      }
      home_battery_ctl.meter_clk.reset();
      fire_transition(home_battery_ctl, "_ended");
    }
  } else if (home_battery_ctl.state == HOMEPOWER_METER_READING) {
    auto data = stable_readings(settings.meter_hold_time);
    data = drop_readings_already_stored(home_battery_ctl.reading_db, data);
    if (data.size() > 0) {
      home_battery_ctl.new_readings = data;
      fire_transition(home_battery_ctl, "_measured");
    }
    // with no new reading in the time limit, go to the next price slot
    if (home_battery_ctl.operational_mode == POWER_AUTO &&
        home_battery_ctl.meter_clk.elapsed_ms() > settings.meter_silent_timeout) {
      fire_transition(home_battery_ctl, "_timeout");
    }
  } else if (home_battery_ctl.state == HOMEPOWER_METER_STABLE) {
    if (home_battery_ctl.meter_clk.elapsed_ms() < settings.meter_hold_time) {
      return std::nullopt;
    }
    if (home_battery_ctl.operational_mode == POWER_AUTO) {
      for (const auto &d : home_battery_ctl.new_readings) {
        home_battery_ctl.reading_db.push_back(d);
        if (home_battery_ctl.reading_db.size() >= static_cast<size_t>(settings.reading_count_limit)) {
          break;
        }
      }
      if (home_battery_ctl.reading_db.size() < static_cast<size_t>(settings.reading_count_limit)) {
        fire_transition(home_battery_ctl, "_saved");
      } else {
        fire_transition(home_battery_ctl, "_full");
      }
      home_battery_ctl.new_readings.clear();
    }
  }
  return requests;
}

} // namespace electricity::power_ctrl

namespace electricity::power_ctrl {

// the readings that stayed the same for a time, for each channel of each feeder
std::vector<MeterRead> stable_readings(const MeterFeeds &stream, const GridStatus &state, long long settle_ms) {
  std::vector<MeterRead> data;
  static std::map<std::string, MeterRead> last_read;
  for (const auto &fdr : stream.feeders) {
    const auto &taps = stream.get_channels(fdr);
    std::vector<std::string> tap_topics;
    tap_topics.reserve(taps.size());
    for (const auto &[point, tap] : taps) {
      tap_topics.push_back(point);
    }

    for (const auto &tapTopic : tap_topics) {
      const auto &taps = stream.history(tapTopic);
      if (taps.size() == 0) {
        continue;
      }
      auto &[powerData, timestamp] = taps.back();
      auto meterread = MeterRead{state, powerData, fdr, tapTopic, timestamp};
      if (!last_read.contains(tapTopic)) {
        last_read[tapTopic] = meterread;
      } else if (meterread.timestamp != last_read[tapTopic].timestamp) {
        if (!is_nearly(last_read[tapTopic].tap2bus, powerData)) {
          last_read[tapTopic] = meterread;
        } else if (meterread.timestamp - last_read[tapTopic].timestamp > settle_ms) {
          data.push_back(last_read[tapTopic]);
        }
      }
    }
  }
  return data;
}

} // namespace electricity::power_ctrl
