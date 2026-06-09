// ─────────────────────────────────────────────────────────────────────────────
//  sbs-occt-convert  —  native 64-bit STEP/IGES → glTF(.glb) converter
//  Part of SBS Step Browser. Built on OpenCascade (LGPL-2.1).
//
//  WHY THIS EXISTS
//    The in-app CAD reader is occt-import-js — OpenCascade compiled to 32-bit
//    WebAssembly, jailed in a ~2 GB heap. Big assemblies (≈150 MB+ STEP) blow
//    past that wall and fail. This is the SAME kernel built NATIVE + 64-bit:
//    it uses real RAM (no cap) and meshes in parallel, exactly like the CAD
//    apps that open these files fine. Output is a standard .glb that the app
//    already loads via its 64-bit GLTFLoader, with the assembly tree, part
//    names and colors preserved (XDE / XCAF).
//
//  USAGE
//    sbs-occt-convert <input.step|.stp|.iges|.igs> <output.glb> [linRatio] [angDeg]
//      linRatio : linear deflection as a fraction of the model's bbox diagonal
//                 (default 0.005 — matches the app's "normal" quality)
//      angDeg   : angular deflection in DEGREES (default 30)
//
//  EXIT CODES
//    0 ok · 1 bad args · 2 read failed · 3 transfer failed · 4 no shapes
//    5 mesh failed · 6 glTF write failed
//
//  Build: see native/README.md  (vcpkg + CMake).  Tested against OCCT 7.6–7.8.
// ─────────────────────────────────────────────────────────────────────────────

#define _USE_MATH_DEFINES
#include <iostream>
#include <string>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <chrono>

#include <Interface_Static.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <XCAFApp_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <TDF_LabelSequence.hxx>
#include <TopoDS_Shape.hxx>
#include <Bnd_Box.hxx>
#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <RWGltf_CafWriter.hxx>
#include <TColStd_IndexedDataMapOfStringString.hxx>
#include <Message.hxx>
#include <Message_ProgressRange.hxx>
#include <OSD_Path.hxx>

static std::string lower(std::string s) {
  for (auto& c : s) c = (char)std::tolower((unsigned char)c);
  return s;
}
static std::string ext(const std::string& p) {
  const auto dot = p.find_last_of('.');
  return dot == std::string::npos ? "" : lower(p.substr(dot + 1));
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: sbs-occt-convert <input.step|.iges> <output.glb> [linRatio] [angDeg]\n";
    return 1;
  }
  const std::string inPath  = argv[1];
  const std::string outPath = argv[2];
  const double linRatio = argc > 3 ? std::atof(argv[3]) : 0.005;          // fraction of bbox diagonal
  const double angDeg   = argc > 4 ? std::atof(argv[4]) : 30.0;           // degrees
  const double angRad   = angDeg * M_PI / 180.0;
  const std::string e   = ext(inPath);

  auto _t0   = std::chrono::steady_clock::now();
  auto secs  = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - _t0).count(); };

  // ── Speed knobs ─────────────────────────────────────────────────────────
  // STEP shape-healing is a slow, single-threaded repair pass we don't need for
  // visualisation — turning it off is the big win on large assemblies. A coarse
  // read precision also cuts the work. (Unknown static names are harmlessly
  // ignored, so these are safe even if a build doesn't recognise one.)
  Interface_Static::SetIVal("read.step.healing",       0);
  Interface_Static::SetIVal("read.precision.mode",     1);
  Interface_Static::SetRVal("read.precision.val",      0.1);

  // ── XCAF document (holds assembly tree + names + colors) ──────────────────
  Handle(TDocStd_Document) doc;
  Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
  app->NewDocument("BinXCAF", doc);

  // ── Read CAD into the document ────────────────────────────────────────────
  IFSelect_ReturnStatus rs = IFSelect_RetFail;
  if (e == "step" || e == "stp") {
    STEPCAFControl_Reader reader;
    reader.SetColorMode(true);
    reader.SetNameMode(true);
    reader.SetLayerMode(true);
    std::cerr << "[sbs-occt] parsing STEP file . . .\n";
    rs = reader.ReadFile(inPath.c_str());
    std::cerr << "[sbs-occt] parsed at " << secs() << "s; transferring to model . . .\n";
    if (rs == IFSelect_RetDone && !reader.Transfer(doc)) { std::cerr << "transfer failed\n"; return 3; }
    std::cerr << "[sbs-occt] transferred at " << secs() << "s\n";
  } else if (e == "iges" || e == "igs") {
    IGESCAFControl_Reader reader;
    reader.SetColorMode(true);
    reader.SetNameMode(true);
    rs = reader.ReadFile(inPath.c_str());
    if (rs == IFSelect_RetDone && !reader.Transfer(doc)) { std::cerr << "transfer failed\n"; return 3; }
  } else {
    std::cerr << "unsupported input extension: " << e << "\n";
    return 1;
  }
  if (rs != IFSelect_RetDone) { std::cerr << "read failed (status " << rs << ")\n"; return 2; }

  // ── Collect the free (top-level) shapes ───────────────────────────────────
  Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  TDF_LabelSequence freeShapes;
  shapeTool->GetFreeShapes(freeShapes);
  if (freeShapes.Length() == 0) { std::cerr << "no shapes in document\n"; return 4; }

  // ── Absolute linear deflection from the model bounding box ────────────────
  // OCCT's BRepMesh uses an ABSOLUTE deflection (model units); the app speaks
  // bbox-ratio, so convert via the overall bbox diagonal.
  Bnd_Box bbox;
  for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
    TopoDS_Shape s = shapeTool->GetShape(freeShapes.Value(i));
    if (!s.IsNull()) BRepBndLib::Add(s, bbox);
  }
  double linDefl = 1.0;
  if (!bbox.IsVoid()) {
    Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
    bbox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    const double dx = xmax - xmin, dy = ymax - ymin, dz = zmax - zmin;
    const double diag = std::sqrt(dx * dx + dy * dy + dz * dz);
    linDefl = (diag > 0 ? diag : 1.0) * linRatio;
  }
  std::cerr << "[sbs-occt] parts=" << freeShapes.Length()
            << " linDefl=" << linDefl << " angDeg=" << angDeg
            << " (meshing starts at " << secs() << "s)\n";

  // ── Tessellate every shape (parallel) ─────────────────────────────────────
  for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
    TopoDS_Shape s = shapeTool->GetShape(freeShapes.Value(i));
    if (s.IsNull()) continue;
    BRepMesh_IncrementalMesh mesher(s, linDefl, Standard_False, angRad, Standard_True /*parallel*/);
    mesher.Perform();
    if (i % 50 == 0 || i == freeShapes.Length())
      std::cerr << "[sbs-occt]   meshed " << i << "/" << freeShapes.Length()
                << " at " << secs() << "s\n";
  }
  std::cerr << "[sbs-occt] meshing done at " << secs() << "s; writing glTF . . .\n";

  // ── Write a binary glTF (.glb) carrying the XDE assembly structure ────────
  TColStd_IndexedDataMapOfStringString fileInfo;
  fileInfo.Add(TCollection_AsciiString("generator"), TCollection_AsciiString("sbs-occt-convert"));

  RWGltf_CafWriter writer(TCollection_AsciiString(outPath.c_str()), Standard_True /*isBinary → .glb*/);
  writer.SetTransformationFormat(RWGltf_WriterTrsfFormat_Compact);
  writer.SetForcedUVExport(Standard_False);
  Message_ProgressRange progress;
  if (!writer.Perform(doc, fileInfo, progress)) {
    std::cerr << "glTF write failed\n";
    return 6;
  }

  std::cerr << "[sbs-occt] wrote " << outPath << " at " << secs() << "s. DONE.\n";
  return 0;
}
