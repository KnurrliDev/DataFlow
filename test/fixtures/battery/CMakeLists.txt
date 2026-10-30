cmake_minimum_required(VERSION 3.20)
project(battery_fixture CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# a small battery charge controller with stub types, for the tests of DataFlow
add_library(battery STATIC src/battery.cpp src/worker_pool.cpp src/worker_pool_state.cpp)
target_include_directories(battery PUBLIC include)

add_executable(controller src/main.cpp)
target_link_libraries(controller PRIVATE battery)
