cmake_minimum_required(VERSION 3.10.2)
project(agnode)

set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(native-lib SHARED native-lib.cpp)
include_directories(${LIBNODE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
