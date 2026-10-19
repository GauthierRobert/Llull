// C++ port of measure_step_brep.py (same OCCT calls, same order) for hosts where the OCP Python wheel cannot be installed: link it
// against any OCCT 7.9 install, e.g. the TK libraries of the cadquery-ocp 7.9.3.1 wheel (what the Python reference ran on) or
// llull's OCCT 7.9.2 prefix. For each STEP file it prints one JSON row with the whole-file measures of measure_step_brep.py
// ("file" … "signature") and the same measures of the first solid of the healed shape ("solid": what llull's import_step_exact
// keeps; the whole-file numbers also count loose shells, faces, wires and points that travel with the solid in the file).
//
// Build:  g++ -O2 -std=c++17 -I<occt>/include/opencascade measure_step_brep.cxx -o measure_step_brep -L<occt>/lib \
//           -Wl,-rpath,<occt>/lib -lTKDESTEP -lTKDE -lTKXSBase -lTKShHealing -lTKTopAlgo -lTKGeomAlgo -lTKBRep -lTKGeomBase \
//           -lTKG3d -lTKG2d -lTKMath -lTKernel
// Usage:  ./measure_step_brep FILE.stp [FILE.stp ...] > rows.ndjson   (OCCT's own messages go to stdout too: keep lines starting '{')

#include <BRepBndLib.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <STEPControl_Reader.hxx>
#include <ShapeFix_Shape.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>

#include <algorithm>
#include <cstdio>
#include <string>

namespace {

TopTools_IndexedMapOfShape sub_shapes(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, kind, map);
  return map;
}

double max_tolerance(const TopoDS_Shape &shape) {
  double worst = 0;
  const auto vertices = sub_shapes(shape, TopAbs_VERTEX);
  for (int i = 1; i <= vertices.Extent(); ++i) worst = std::max(worst, BRep_Tool::Tolerance(TopoDS::Vertex(vertices(i))));
  const auto edges = sub_shapes(shape, TopAbs_EDGE);
  for (int i = 1; i <= edges.Extent(); ++i) worst = std::max(worst, BRep_Tool::Tolerance(TopoDS::Edge(edges(i))));
  const auto faces = sub_shapes(shape, TopAbs_FACE);
  for (int i = 1; i <= faces.Extent(); ++i) worst = std::max(worst, BRep_Tool::Tolerance(TopoDS::Face(faces(i))));
  return worst;
}

// Per-face "%.6f,%.6f,%.6f,%.6f" (area, centroid) joined by '|': the text measure_step_brep.py hashes (sha256, first 16 hex digits).
// Printed as is; the consumer hashes it, so this file needs no sha256 of its own.
std::string signature_text(const TopoDS_Shape &shape) {
  std::string text;
  const auto faces = sub_shapes(shape, TopAbs_FACE);
  char buffer[160];
  for (int i = 1; i <= faces.Extent(); ++i) {
    GProp_GProps props;
    BRepGProp::SurfaceProperties(faces(i), props);
    const gp_Pnt c = props.CentreOfMass();
    std::snprintf(buffer, sizeof buffer, "%s%.6f,%.6f,%.6f,%.6f", i > 1 ? "|" : "", props.Mass(), c.X(), c.Y(), c.Z());
    text += buffer;
  }
  return text;
}

void measures(const TopoDS_Shape &shape) {
  GProp_GProps vp;
  BRepGProp::VolumeProperties(shape, vp);
  GProp_GProps sp;
  BRepGProp::SurfaceProperties(shape, sp);
  const gp_Pnt c = vp.CentreOfMass();
  const gp_Mat inertia = vp.MatrixOfInertia();
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, Standard_False, Standard_False);
  double b[6];
  box.Get(b[0], b[1], b[2], b[3], b[4], b[5]);
  std::printf("\"solids\":%d,\"shells\":%d,\"faces\":%d,\"edges\":%d,\"vertices\":%d,", sub_shapes(shape, TopAbs_SOLID).Extent(),
              sub_shapes(shape, TopAbs_SHELL).Extent(), sub_shapes(shape, TopAbs_FACE).Extent(), sub_shapes(shape, TopAbs_EDGE).Extent(),
              sub_shapes(shape, TopAbs_VERTEX).Extent());
  std::printf("\"valid\":%s,\"maxToleranceMm\":%.17g,\"volumeMm3\":%.17g,\"areaMm2\":%.17g,", BRepCheck_Analyzer(shape).IsValid() ? "true" : "false",
              max_tolerance(shape), vp.Mass(), sp.Mass());
  std::printf("\"centroidMm\":[%.17g,%.17g,%.17g],\"inertiaRho1Mm5\":[", c.X(), c.Y(), c.Z());
  for (int i = 1; i <= 3; ++i)
    std::printf("%s[%.17g,%.17g,%.17g]", i > 1 ? "," : "", inertia.Value(i, 1), inertia.Value(i, 2), inertia.Value(i, 3));
  std::printf("],\"bboxMm\":[%.17g,%.17g,%.17g,%.17g,%.17g,%.17g],\"signatureText\":\"%s\"", b[0], b[1], b[2], b[3], b[4], b[5],
              signature_text(shape).c_str());
}

}  // namespace

int main(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    const std::string path = argv[i];
    const std::string file = path.substr(path.find_last_of('/') + 1);
    STEPControl_Reader reader;
    if (reader.ReadFile(path.c_str()) != IFSelect_RetDone) {
      std::printf("{\"file\":\"%s\",\"error\":\"ReadFile failed\"}\n", file.c_str());
      continue;
    }
    reader.TransferRoots();
    const TopoDS_Shape shape = reader.OneShape();
    try {
      const bool valid_raw = BRepCheck_Analyzer(shape).IsValid();
      ShapeFix_Shape fixer(shape);
      fixer.Perform();
      const TopoDS_Shape fixed = fixer.Shape();
      const auto solids = sub_shapes(fixed, TopAbs_SOLID);
      std::printf("{\"file\":\"%s\",\"validAsRead\":%s,", file.c_str(), valid_raw ? "true" : "false");
      measures(fixed);
      if (solids.Extent() > 0) {
        std::printf(",\"solid\":{");
        measures(solids(1));
        std::printf("}");
      }
      std::printf("}\n");
    } catch (const Standard_Failure &failure) {
      std::printf("\n{\"file\":\"%s\",\"error\":\"%s: %s\"}\n", file.c_str(), failure.DynamicType()->Name(), failure.GetMessageString());
    }
  }
  return 0;
}
