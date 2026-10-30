# qmake fixture: the CMake fixture source plus one file that uses Qt types
TEMPLATE = lib
CONFIG += staticlib c++20
QT = core
INCLUDEPATH += ../battery/include
SOURCES += ../battery/src/battery.cpp battery_qt.cpp
