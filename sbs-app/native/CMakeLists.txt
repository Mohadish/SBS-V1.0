cmake_minimum_required(VERSION 3.16)
project(sbs_occt_convert CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# OpenCASCADE: provided by vcpkg (toolchain file) or a manual OCCT install.
#   vcpkg:  -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake
#   manual: -DOpenCASCADE_DIR=<occt>/cmake
find_package(OpenCASCADE REQUIRED)

add_executable(sbs-occt-convert sbs-occt-convert.cpp)

if(OpenCASCADE_INCLUDE_DIR)
  target_include_directories(sbs-occt-convert PRIVATE ${OpenCASCADE_INCLUDE_DIR})
endif()

# Toolkits needed: STEP/IGES data-exchange + XCAF (XDE) + meshing + glTF writer.
# Toolkit names were reorganised in OCCT 7.7/7.8 (the TKDE* modules), so we link
# whichever of these targets actually exist in the installed OCCT.
set(_sbs_occt_tks
  TKDESTEP TKDEIGES          # OCCT 7.7+ data-exchange modules
  TKSTEP   TKIGES            # OCCT <= 7.6 names
  TKXCAF TKLCAF TKVCAF TKCAF
  TKRWMesh                   # RWGltf_CafWriter
  TKMesh TKBRep TKTopAlgo TKG3d TKGeomBase TKMath TKXSBase TKernel
)
foreach(tk ${_sbs_occt_tks})
  if(TARGET ${tk})
    target_link_libraries(sbs-occt-convert PRIVATE ${tk})
  endif()
endforeach()

# Safety net — if the curated list missed a dependency, pull OCCT's full export.
if(DEFINED OpenCASCADE_LIBRARIES)
  target_link_libraries(sbs-occt-convert PRIVATE ${OpenCASCADE_LIBRARIES})
endif()

# Static-ish runtime on MSVC keeps the exe portable across machines.
if(MSVC)
  target_compile_options(sbs-occt-convert PRIVATE /EHsc /bigobj)
endif()

install(TARGETS sbs-occt-convert RUNTIME DESTINATION bin)
