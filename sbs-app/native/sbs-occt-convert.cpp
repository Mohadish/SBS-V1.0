// ─────────────────────────────────────────────────────────────────────────────
//  sbs-occt-convert  —  native 64-bit STEP/IGES → SBS mesh-blob (.sbsmesh)
//  Part of SBS Step Browser. Built on OpenCascade (LGPL-2.1).
//
//  WHY THIS EXISTS
//    The in-app CAD reader (occt-import-js) is OpenCascade in 32-bit WASM,
//    capped at ~2 GB → it fails on big assemblies (≈150 MB+ STEP). This is the
//    SAME kernel, native + 64-bit (no cap), AND it emits the EXACT same data
//    structure the WASM reader does — a { root, meshes } tree of per-solid
//    meshes — serialised in the app's own cache-blob format (see
//    src/io/model-cache.js). The app loads it through buildNodeFromOcct, the
//    identical path the WASM reader uses, so the result matches byte-for-byte
//    in behaviour: separated parts, OCC-native orientation, per-solid colours.
//
//  OUTPUT (.sbsmesh) — the model-cache payload, little-endian:
//    [u32 jsonLen][json][binary]
//    json = { v:1, root:{name,meshes,children}, meshes:[{color,p,n,u,i}] }
//           each slot = {o:byteOffsetInBinary, l:elementCount}
//    binary = concatenated f32 positions, f32 normals, u32 indices
//
//  USAGE
//    sbs-occt-convert <input.step|.iges> <output.sbsmesh> [linRatio] [angDeg]
//      linRatio : linear deflection as a fraction of the bbox diagonal (def 0.005)
//      angDeg   : angular deflection in degrees (def 30)
//
//  Build: see native/README.md (vcpkg + CMake). Tested against OCCT 7.6–8.0.
// ─────────────────────────────────────────────────────────────────────────────

#define _USE_MATH_DEFINES
#include <iostream>
#include <fstream>
#include <iterator>
#include <vector>
#include <string>
#include <map>
#include <unordered_map>
#include <functional>
#include <cstdint>
#include <cstdio>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <utility>

#include <Interface_Static.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPControl_Reader.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <XCAFApp_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Face.hxx>
#include <TopExp_Explorer.hxx>
#include <TopAbs.hxx>
#include <TopLoc_Location.hxx>
#include <BRep_Tool.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <Bnd_Box.hxx>
#include <BRepBndLib.hxx>
#include <Poly_Triangulation.hxx>
#include <Quantity_Color.hxx>
#include <Quantity_TypeOfColor.hxx>
#include <TopoDS_TShape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Dir.hxx>
#include <gp_Trsf.hxx>

static std::string lower(std::string s) { for (auto& c : s) c = (char)std::tolower((unsigned char)c); return s; }
static std::string ext(const std::string& p) { const auto d = p.find_last_of('.'); return d == std::string::npos ? "" : lower(p.substr(d + 1)); }
static std::string f2s(double v) { char b[32]; std::snprintf(b, sizeof(b), "%.6g", v); return std::string(b); }

struct Mesh {
  bool hasColor = false; double r = 0, g = 0, b = 0;
  std::vector<float>    pos, nrm;
  std::vector<uint32_t> idx;
};

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: sbs-occt-convert <input.step|.iges> <output.sbsobj> [linRatio] [angDeg]\n"
                 "  output ext .sbsobj = STEP + mesh-blob polyglot (still a valid STEP);\n"
                 "             .sbsmesh = bare mesh blob (lean display copy).\n";
    return 1;
  }
  const std::string inPath  = argv[1];
  const std::string outPath = argv[2];
  const double linRatio = argc > 3 ? std::atof(argv[3]) : 0.005;
  const double angDeg   = argc > 4 ? std::atof(argv[4]) : 30.0;
  const double angRad   = angDeg * M_PI / 180.0;
  const std::string e   = ext(inPath);

  auto _t0  = std::chrono::steady_clock::now();
  auto secs = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - _t0).count(); };

  // Speed: skip the slow single-threaded STEP healing pass (unknown statics are ignored).
  Interface_Static::SetIVal("read.step.healing", 0);
  // NOTE: do NOT force a coarse read precision — a large read.precision.val
  // makes OCC merge adjacent faces during transfer, which destroys per-face
  // colours (styled_items target individual ADVANCED_FACEs). Use file precision.
  // Read tessellated geometry too (AP242 triangulated face sets). Big exports
  // are often mesh-based, not B-rep; OCC skips them unless this is on. 1 = On.
  Interface_Static::SetIVal("read.step.tessellated", 1);
  Interface_Static::SetCVal("read.step.tessellated", "On");

  Handle(TDocStd_Document) doc;
  Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
  app->NewDocument("BinXCAF", doc);

  IFSelect_ReturnStatus rs = IFSelect_RetFail;
  if (e == "step" || e == "stp") {
    STEPCAFControl_Reader reader;
    reader.SetColorMode(true); reader.SetNameMode(true); reader.SetLayerMode(true);
    std::cerr << "[sbs-occt] parsing STEP . . .\n";
    rs = reader.ReadFile(inPath.c_str());
    std::cerr << "[sbs-occt] parsed at " << secs() << "s; transferring . . .\n";
    if (rs == IFSelect_RetDone && !reader.Transfer(doc)) { std::cerr << "transfer failed\n"; return 3; }
    std::cerr << "[sbs-occt] transferred at " << secs() << "s\n";
  } else if (e == "iges" || e == "igs") {
    IGESCAFControl_Reader reader;
    reader.SetColorMode(true); reader.SetNameMode(true);
    rs = reader.ReadFile(inPath.c_str());
    if (rs == IFSelect_RetDone && !reader.Transfer(doc)) { std::cerr << "transfer failed\n"; return 3; }
  } else { std::cerr << "unsupported input extension: " << e << "\n"; return 1; }
  if (rs != IFSelect_RetDone) { std::cerr << "read failed (status " << rs << ")\n"; return 2; }

  Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  Handle(XCAFDoc_ColorTool) colorTool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
  TDF_LabelSequence freeShapes;
  shapeTool->GetFreeShapes(freeShapes);

  auto countFaces = [](const std::vector<TopoDS_Shape>& rr) {
    int n = 0;
    for (const auto& r : rr) for (TopExp_Explorer fe(r, TopAbs_FACE); fe.More(); fe.Next()) ++n;
    return n;
  };

  // Root shapes from the structured (XCAF) reader.
  bool usedFallback = false;          // set if we drop to the plain (label-less) reader
  std::vector<TopoDS_Shape> roots;
  for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
    TopoDS_Shape s = shapeTool->GetShape(freeShapes.Value(i));
    if (!s.IsNull()) roots.push_back(s);
  }
  auto countType = [](const std::vector<TopoDS_Shape>& rr, TopAbs_ShapeEnum t) {
    int n = 0;
    for (const auto& r : rr) for (TopExp_Explorer ee(r, t); ee.More(); ee.Next()) ++n;
    return n;
  };
  int nFaces = countFaces(roots);
  std::cerr << "[sbs-occt] XCAF: " << roots.size() << " root(s), " << nFaces << " face(s), "
            << countType(roots, TopAbs_EDGE) << " edge(s), "
            << countType(roots, TopAbs_VERTEX) << " vertex(es)\n";

  // Fallback: some STEPs transfer NO faces through the structured reader (odd
  // product structure). Retry with the plain STEPControl_Reader — more
  // permissive: it recovers the raw B-rep (loses colours/structure, but the
  // geometry comes through). We still explode it into solids/shells/faces.
  if (nFaces == 0 && (e == "step" || e == "stp")) {
    std::cerr << "[sbs-occt] no faces from XCAF — retrying with plain STEPControl_Reader . . .\n";
    STEPControl_Reader sr;
    if (sr.ReadFile(inPath.c_str()) == IFSelect_RetDone) {
      sr.TransferRoots();
      TopoDS_Shape one = sr.OneShape();
      roots.clear();
      if (!one.IsNull()) { roots.push_back(one); usedFallback = true; }
      nFaces = countFaces(roots);
      std::cerr << "[sbs-occt] plain reader: " << roots.size() << " root(s), "
                << nFaces << " face(s) at " << secs() << "s\n";
    }
  }
  if (roots.empty() || nFaces == 0) { std::cerr << "no faces/shapes to mesh\n"; return 4; }

  // Linear deflection from overall bbox diagonal (BRepMesh wants absolute units).
  Bnd_Box bbox;
  for (const auto& s : roots) { if (!s.IsNull()) BRepBndLib::Add(s, bbox); }
  double linDefl = 1.0;
  if (!bbox.IsVoid()) {
    Standard_Real x0, y0, z0, x1, y1, z1; bbox.Get(x0, y0, z0, x1, y1, z1);
    const double dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const double diag = std::sqrt(dx * dx + dy * dy + dz * dz);
    linDefl = (diag > 0 ? diag : 1.0) * linRatio;
  }
  // Junk/construction geometry (datum planes, unbounded surfaces) can blow the
  // bbox up to ~infinity → an absurd absolute deflection that meshes nothing.
  // When the bbox is unusable, fall back to RELATIVE meshing: each face is
  // tessellated relative to its OWN size, immune to a polluted global bbox.
  const bool useRelative = bbox.IsVoid() || !std::isfinite(linDefl)
                           || linDefl <= 1e-7 || linDefl > 1e7;
  if (useRelative)
    std::cerr << "[sbs-occt] meshing (RELATIVE ratio=" << linRatio
              << ", bbox unusable) at " << secs() << "s\n";
  else
    std::cerr << "[sbs-occt] meshing (linDefl=" << linDefl << ") at " << secs() << "s\n";

  // Tessellate every root shape (parallel) — meshes all sub-shapes within.
  for (const auto& s : roots) {
    if (s.IsNull()) continue;
    BRepMesh_IncrementalMesh mesher(s,
                                    useRelative ? linRatio : linDefl,
                                    useRelative ? Standard_True : Standard_False,
                                    angRad, Standard_True);
    mesher.Perform();
  }
  std::cerr << "[sbs-occt] meshed at " << secs() << "s; extracting meshes . . .\n";

  // ── Explode into separable parts, each split into per-COLOUR sub-meshes ──────
  // Per-SOLID gives separable parts (fall back to SHELL, then whole-shape faces
  // for sheet bodies). WITHIN each part, faces are grouped BY COLOUR: a face's
  // own override wins, else the colour resolved for this OCCURRENCE from the
  // assembly tree, else uncoloured. A multi-colour part becomes one node holding
  // several coloured sub-meshes.
  std::vector<Mesh>            meshes;   // flat list of (colour, geometry)
  std::vector<std::vector<int>> parts;   // each part = the mesh indices it owns

  // Read colour as sRGB — what authoring tools / 3ds Max display. OCC 7.5+ keeps
  // colour LINEAR internally; .Red()/.Green()/.Blue() return linear → shifted /
  // washed hues. Quantity_TOC_sRGB hands back the file's authored values.
  auto toRGB = [](const Quantity_Color& c, double& r, double& g, double& b) {
    Standard_Real rr, gg, bb; c.Values(rr, gg, bb, Quantity_TOC_sRGB);
    r = rr; g = gg; b = bb;
  };
  auto labelColor = [&](const TDF_Label& l, Quantity_Color& c) -> bool {
    return colorTool->GetColor(l, XCAFDoc_ColorSurf, c)
        || colorTool->GetColor(l, XCAFDoc_ColorGen,  c);
  };

  // ── Pre-index PER-FACE colours by sub-shape ─────────────────────────────────
  // OCC's shape-level GetColor(face) misses sub-shape colour labels. Enumerate
  // them directly (GetSubShapes), keyed by the face TShape. A face override is a
  // property of the part DEFINITION, so sharing it across instances is correct.
  std::vector<Quantity_Color> palette;
  std::unordered_map<const TopoDS_TShape*, int> faceColor;
  {
    TDF_LabelSequence allShapes;
    shapeTool->GetShapes(allShapes);
    for (Standard_Integer i = 1; i <= allShapes.Length(); ++i) {
      TDF_LabelSequence subs;
      if (!shapeTool->GetSubShapes(allShapes.Value(i), subs)) continue;
      for (Standard_Integer j = 1; j <= subs.Length(); ++j) {
        Quantity_Color c;
        if (labelColor(subs.Value(j), c)) {
          TopoDS_Shape sh = shapeTool->GetShape(subs.Value(j));
          if (sh.IsNull()) continue;
          const TopoDS_TShape* k = sh.TShape().get();
          if (faceColor.find(k) == faceColor.end()) { faceColor[k] = (int)palette.size(); palette.push_back(c); }
        }
      }
    }
    std::cerr << "[sbs-occt] pre-indexed " << palette.size() << " sub-shape colour(s) at " << secs() << "s\n";
  }

  // Diagnostic tallies — where each face's colour came from.
  long dFace = 0, dFaceHit = 0, dBaseHit = 0, dNone = 0, dSolidTot = 0, dSolidColoured = 0;

  // Build ONE part (one solid/shell), grouping its faces by colour. `base` is the
  // colour resolved for this occurrence; a face-level override beats it.
  auto addPartGeom = [&](const TopoDS_Shape& part, bool baseHas, double br, double bg, double bb) {
    std::map<std::string, Mesh> groups;          // colour key → mesh
    for (TopExp_Explorer fe(part, TopAbs_FACE); fe.More(); fe.Next()) {
      TopoDS_Face face = TopoDS::Face(fe.Current());
      TopLoc_Location loc;
      Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
      if (tri.IsNull()) continue;

      // Colour: per-face override → resolved base (solid/instance/part/inherited) → none.
      double cr = 0, cg = 0, cb = 0; bool colored = false;
      ++dFace;
      auto cit = faceColor.find(face.TShape().get());
      if (cit != faceColor.end()) {
        toRGB(palette[cit->second], cr, cg, cb); colored = true; ++dFaceHit;
      } else if (baseHas) {
        cr = br; cg = bg; cb = bb; colored = true; ++dBaseHit;
      } else { ++dNone; }
      char key[40];
      if (colored) std::snprintf(key, sizeof(key), "%d,%d,%d",
                                 (int)(cr * 255 + 0.5), (int)(cg * 255 + 0.5), (int)(cb * 255 + 0.5));
      else         std::snprintf(key, sizeof(key), "none");
      Mesh& m = groups[key];
      if (colored && !m.hasColor) { m.hasColor = true; m.r = cr; m.g = cg; m.b = cb; }

      const gp_Trsf trsf = loc.Transformation();
      const uint32_t vbase = (uint32_t)(m.pos.size() / 3);
      const bool rev  = (face.Orientation() == TopAbs_REVERSED);
      const bool hasN = tri->HasNormals();
      for (Standard_Integer n = 1; n <= tri->NbNodes(); ++n) {
        gp_Pnt p = tri->Node(n); p.Transform(trsf);
        m.pos.push_back((float)p.X()); m.pos.push_back((float)p.Y()); m.pos.push_back((float)p.Z());
        if (hasN) {
          gp_Dir d = tri->Normal(n); d.Transform(trsf);
          float nx = (float)d.X(), ny = (float)d.Y(), nz = (float)d.Z();
          if (rev) { nx = -nx; ny = -ny; nz = -nz; }
          m.nrm.push_back(nx); m.nrm.push_back(ny); m.nrm.push_back(nz);
        }
      }
      for (Standard_Integer t = 1; t <= tri->NbTriangles(); ++t) {
        Standard_Integer a, b, c; tri->Triangle(t).Get(a, b, c);
        if (rev) std::swap(b, c);
        m.idx.push_back(vbase + a - 1); m.idx.push_back(vbase + b - 1); m.idx.push_back(vbase + c - 1);
      }
    }

    std::vector<int> owned;
    for (auto& kv : groups) {
      if (kv.second.pos.empty() || kv.second.idx.empty()) continue;
      owned.push_back((int)meshes.size());
      meshes.push_back(std::move(kv.second));
    }
    if (!owned.empty()) parts.push_back(std::move(owned));
  };

  // A container's OWN colour (per-solid / per-shell styled_item, e.g. a STEP
  // MANIFOLD_SOLID_BREP colour) overrides the inherited base for its faces — but
  // a face that has its own override still wins inside addPartGeom.
  auto withOwnColour = [&](const TopoDS_Shape& c, bool baseHas, double& r, double& g, double& b) -> bool {
    auto it = faceColor.find(c.TShape().get());
    if (it != faceColor.end()) { toRGB(palette[it->second], r, g, b); return true; }
    return baseHas;
  };

  // Decompose a shape into separable parts (SOLID, else SHELL, else loose faces)
  // and emit each with its own (or inherited) base colour.
  auto emitParts = [&](const TopoDS_Shape& shape, bool baseHas, double br, double bg, double bb) {
    const size_t before = parts.size();
    for (TopExp_Explorer se(shape, TopAbs_SOLID); se.More(); se.Next()) {
      double r = br, g = bg, b = bb;
      ++dSolidTot;
      if (faceColor.count(se.Current().TShape().get())) ++dSolidColoured;
      const bool h = withOwnColour(se.Current(), baseHas, r, g, b);
      addPartGeom(se.Current(), h, r, g, b);
    }
    if (parts.size() > before) return;
    for (TopExp_Explorer sh(shape, TopAbs_SHELL); sh.More(); sh.Next()) {
      double r = br, g = bg, b = bb;
      const bool h = withOwnColour(sh.Current(), baseHas, r, g, b);
      addPartGeom(sh.Current(), h, r, g, b);
    }
    if (parts.size() > before) return;
    addPartGeom(shape, baseHas, br, bg, bb);   // loose faces / sheet body
  };

  if (usedFallback) {
    // Plain-reader geometry has NO XCAF labels → no colours; just emit it.
    for (const auto& root : roots) if (!root.IsNull()) emitParts(root, false, 0, 0, 0);
  } else {
    // ── Walk the assembly TREE, resolving colour per OCCURRENCE ──────────────
    // Priority at every node: instance(occurrence) override > part definition >
    // inherited-from-ancestor. This is what a viewer does, and fixes (a) instance
    // colours we never read → grey, and (b) one part instanced with different
    // colours collapsing to a single colour (TShape is shared across instances).
    struct Col { bool has = false; double r = 0, g = 0, b = 0; };
    auto readCol = [&](const TDF_Label& l) -> Col {
      Col o; Quantity_Color c;
      if (labelColor(l, c)) { toRGB(c, o.r, o.g, o.b); o.has = true; }
      return o;
    };
    std::function<void(const TDF_Label&, const TopLoc_Location&, const Col&, const Col&)>
    walk = [&](const TDF_Label& defLabel, const TopLoc_Location& accLoc,
               const Col& inst, const Col& anc) {
      const Col def = readCol(defLabel);
      const Col eff = inst.has ? inst : (def.has ? def : anc);   // instance > def > ancestor
      if (shapeTool->IsAssembly(defLabel)) {
        TDF_LabelSequence comps;
        shapeTool->GetComponents(defLabel, comps);
        for (Standard_Integer i = 1; i <= comps.Length(); ++i) {
          const TDF_Label C = comps.Value(i);
          TDF_Label ref;
          if (!shapeTool->GetReferredShape(C, ref)) continue;
          walk(ref, accLoc * shapeTool->GetLocation(C), readCol(C), eff);
        }
      } else {
        TopoDS_Shape s = shapeTool->GetShape(defLabel);
        if (!s.IsNull()) emitParts(s.Moved(accLoc), eff.has, eff.r, eff.g, eff.b);
      }
    };
    const Col none;
    for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i)
      walk(freeShapes.Value(i), TopLoc_Location(), none, none);
  }

  int coloredMeshes = 0; for (const auto& m : meshes) if (m.hasColor) ++coloredMeshes;
  std::cerr << "[sbs-occt][diag2] faces=" << dFace << " faceHit=" << dFaceHit
            << " baseHit=" << dBaseHit << " none=" << dNone
            << " | colourMap=" << faceColor.size()
            << " solids=" << dSolidTot << " solidColoured=" << dSolidColoured << "\n";
  std::cerr << "[sbs-occt] extracted " << parts.size() << " part(s), "
            << meshes.size() << " mesh(es), " << coloredMeshes << " coloured at " << secs() << "s\n";
  if (meshes.empty()) { std::cerr << "no triangulated geometry (no solids/shells/faces)\n"; return 5; }

  // ── Serialise to the model-cache blob format ────────────────────────────────
  std::vector<uint8_t> bin;
  auto pushF = [&](const std::vector<float>& v, size_t& o, size_t& l) {
    o = bin.size(); l = v.size();
    const uint8_t* p = reinterpret_cast<const uint8_t*>(v.data());
    bin.insert(bin.end(), p, p + v.size() * sizeof(float));
  };
  auto pushU = [&](const std::vector<uint32_t>& v, size_t& o, size_t& l) {
    o = bin.size(); l = v.size();
    const uint8_t* p = reinterpret_cast<const uint8_t*>(v.data());
    bin.insert(bin.end(), p, p + v.size() * sizeof(uint32_t));
  };

  // Serialise every mesh (binary section + JSON entry).
  std::string meshesJson;
  for (size_t i = 0; i < meshes.size(); ++i) {
    Mesh& m = meshes[i];
    size_t po, pl, no = 0, nl = 0, io, il;
    pushF(m.pos, po, pl);
    std::string slotN = "null";
    if (!m.nrm.empty()) { pushF(m.nrm, no, nl); slotN = "{\"o\":" + std::to_string(no) + ",\"l\":" + std::to_string(nl) + "}"; }
    pushU(m.idx, io, il);
    std::string color = m.hasColor ? ("[" + f2s(m.r) + "," + f2s(m.g) + "," + f2s(m.b) + "]") : "null";
    if (i) meshesJson += ",";
    meshesJson += "{\"color\":" + color +
                  ",\"p\":{\"o\":" + std::to_string(po) + ",\"l\":" + std::to_string(pl) + "}" +
                  ",\"n\":" + slotN +
                  ",\"u\":null" +
                  ",\"i\":{\"o\":" + std::to_string(io) + ",\"l\":" + std::to_string(il) + "}}";
  }
  // Part tree — each part node references the colour-mesh indices it owns.
  std::string children;
  for (size_t p = 0; p < parts.size(); ++p) {
    if (p) children += ",";
    children += "{\"name\":\"part_" + std::to_string(p + 1) + "\",\"meshes\":[";
    for (size_t k = 0; k < parts[p].size(); ++k) { if (k) children += ","; children += std::to_string(parts[p][k]); }
    children += "],\"children\":[]}";
  }
  std::string json = "{\"v\":1,\"root\":{\"name\":\"model\",\"meshes\":[],\"children\":[" + children + "]},\"meshes\":[" + meshesJson + "]}";

  std::vector<uint8_t> out;
  const uint32_t jl = (uint32_t)json.size();
  out.push_back((uint8_t)(jl & 0xff)); out.push_back((uint8_t)((jl >> 8) & 0xff));
  out.push_back((uint8_t)((jl >> 16) & 0xff)); out.push_back((uint8_t)((jl >> 24) & 0xff));
  out.insert(out.end(), json.begin(), json.end());
  out.insert(out.end(), bin.begin(), bin.end());

  // `out` is the payload blob ([u32 jsonLen][json][binary]).
  const bool bareBlob = (ext(outPath) == "sbsmesh");

  // For the polyglot .sbsobj we embed the original STEP bytes as the head.
  // Read it NOW — BEFORE opening the output stream. Critical for in-place
  // conversion (outPath == inPath): opening the ofstream below truncates the
  // file, so the head must be captured first or it would read back empty
  // (corrupting the source STEP and producing a headless .sbsobj).
  std::vector<uint8_t> head;
  if (!bareBlob) {
    std::ifstream hf(inPath, std::ios::binary);
    head.assign((std::istreambuf_iterator<char>(hf)), std::istreambuf_iterator<char>());
    hf.close();
  }

  std::ofstream f(outPath, std::ios::binary);
  if (!f) { std::cerr << "cannot open output " << outPath << "\n"; return 6; }

  if (bareBlob) {
    // Bare blob — lean display copy (no embedded STEP).
    f.write(reinterpret_cast<const char*>(out.data()), (std::streamsize)out.size());
  } else {
    // Polyglot .sbsobj: [original STEP bytes][blob][96-byte footer]. The file
    // STAYS a valid STEP (rename → .step opens in CAD) and SBS fast-loads from
    // the tail. Footer matches src/io/model-cache.js; a zero head-hash means
    // "trusted" so the app skips re-hashing the (huge) embedded STEP head.
    uint8_t footer[96]; std::memset(footer, 0, sizeof(footer));
    std::memcpy(footer, "SBSCAC1\0", 8);
    footer[8]  = 1;                        // formatVersion (u32 LE)
    footer[12] = 1;                        // kind
    const uint64_t hl = head.size(), pl = out.size();
    for (int i = 0; i < 8; ++i) {
      footer[16 + i] = (uint8_t)((hl >> (8 * i)) & 0xff);
      footer[24 + i] = (uint8_t)((pl >> (8 * i)) & 0xff);
    }
    std::memcpy(footer + 88, "SBSCAC1\0", 8);
    f.write(reinterpret_cast<const char*>(head.data()), (std::streamsize)head.size());
    f.write(reinterpret_cast<const char*>(out.data()),  (std::streamsize)out.size());
    f.write(reinterpret_cast<const char*>(footer), 96);
  }
  f.close();

  std::cerr << "[sbs-occt] wrote " << outPath << " (" << parts.size()
            << " parts, " << meshes.size() << " meshes) at " << secs() << "s. DONE.\n";
  return 0;
}
