#include <QMap>
#include <QString>

#include <optional>

struct Preset {
  int id = 0;
  QString kind;
};

std::optional<Preset> find_preset(const QMap<QString, Preset> &presetDb, const QString &key) {
  if (!presetDb.contains(key))
    return std::nullopt;
  return presetDb.value(key);
}

QString describe(const QMap<QString, Preset> &presetDb, const QString &key) {
  auto hit = find_preset(presetDb, key);
  if (hit) {
    return QString("preset %1").arg(hit->id);
  }
  return QString("missing %1").arg(hit->kind);
}
