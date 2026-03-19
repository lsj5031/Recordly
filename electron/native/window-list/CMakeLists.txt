cmake_minimum_required(VERSION 3.20)
project(window-list LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(window-list src/main.cpp)

target_compile_options(window-list PRIVATE /EHsc /W3 /utf-8)

target_link_libraries(window-list PRIVATE
  user32
  dwmapi
  version
)
