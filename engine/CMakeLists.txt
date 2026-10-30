cmake_minimum_required(VERSION 3.20)
project(dataflow_engine CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# the llvm release libraries for windows use the static msvc runtime
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# the folder with llvm-23.1.4, zlib and zstd, for example C:/Users/<user>/.cache/dataflow
set(DATAFLOW_DEPS_DIR "" CACHE PATH "Folder with the LLVM, zlib and zstd builds")
list(APPEND CMAKE_PREFIX_PATH "${DATAFLOW_DEPS_DIR}/llvm-23.1.4" "${DATAFLOW_DEPS_DIR}/zlib" "${DATAFLOW_DEPS_DIR}/zstd")

# llvm needs zlib and zstd. the windows release of llvm does not include them
set(ZLIB_USE_STATIC_LIBS ON)
find_package(Clang REQUIRED CONFIG)
message(STATUS "DataFlow engine: LLVM ${LLVM_PACKAGE_VERSION}, RTTI ${LLVM_ENABLE_RTTI}")

add_executable(dataflow-engine src/main.cpp)
target_include_directories(dataflow-engine PRIVATE include ${LLVM_INCLUDE_DIRS} ${CLANG_INCLUDE_DIRS})
separate_arguments(llvm_defs NATIVE_COMMAND "${LLVM_DEFINITIONS}")
target_compile_definitions(dataflow-engine PRIVATE ${llvm_defs})
target_link_libraries(dataflow-engine PRIVATE
  clangTooling clangToolingInclusionsStdlib clangDependencyScanning clangDriver clangFrontend clangSerialization
  clangAnalysisFlowSensitiveModels
  clangAnalysisFlowSensitive clangAnalysis clangASTMatchers clangAST clangLex clangBasic)

# copy the builtin headers of clang next to the engine. the engine reads them from <exe folder>/lib/clang/<major>
add_custom_command(TARGET dataflow-engine POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${LLVM_LIBRARY_DIR}/clang/${LLVM_VERSION_MAJOR}/include"
          "$<TARGET_FILE_DIR:dataflow-engine>/lib/clang/${LLVM_VERSION_MAJOR}/include")

if(MSVC)
  target_compile_options(dataflow-engine PRIVATE /utf-8 /permissive- /Zc:__cplusplus /bigobj)
  # classes from llvm without rtti need the same setting in the engine
  if(NOT LLVM_ENABLE_RTTI)
    target_compile_options(dataflow-engine PRIVATE /GR-)
  endif()
endif()
