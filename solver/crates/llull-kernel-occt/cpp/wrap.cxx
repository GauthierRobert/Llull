// Curve projection onto the faces of a solid (03 WRP M2, `faceQuery.projectCurves`): the source curves are sampled, every sample is carried to the nearest face
// along a direction (rays against the trimmed faces, IntCurvesFace_Intersector) or to its closest point (BRepExtrema_DistShapeShape), the run boundaries are bisected
// to the parameter where the hit changes, and each run is fitted again with a B-spline in 3D and in the face's (u, v). Fitting our own samples keeps the accuracy
// under our control (the fit tolerance), which the OCCT projection classes (BRepProj_Projection / BRepOffsetAPI_NormalProjection, approximations of 1e-4 by default)
// do not offer.
#include <algorithm>
#include <cmath>
#include <memory>
#include <optional>
#include <stdexcept>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <Geom2dAPI_PointsToBSpline.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <GeomAPI_PointsToBSpline.hxx>
#include <Geom_BSplineCurve.hxx>
#include <GeomAdaptor_Curve.hxx>
#include <IntCurvesFace_Intersector.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>

#include "llull-kernel-occt/cpp/queries.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

namespace {

constexpr int kMinSamples = 64;
constexpr int kMaxSamples = 2000;
constexpr int kBisections = 44;

struct Hit {
  int face = -1;  // index into the requested face list
  gp_Pnt point;
  double u = 0;
  double v = 0;
};

class Projector {
 public:
  Projector(const std::vector<TopoDS_Face> &faces, bool closest, const gp_Dir &direction, double max_distance)
      : faces_(faces), closest_(closest), direction_(direction), max_distance_(max_distance) {
    if (!closest_)
      for (const TopoDS_Face &face : faces_) intersectors_.push_back(std::make_unique<IntCurvesFace_Intersector>(face, 1e-7, Standard_True, Standard_True));
  }

  // The nearest hit of `p` over all faces (along the direction ahead of p, or the closest point within max_distance).
  std::optional<Hit> locate(const gp_Pnt &p) const {
    std::optional<Hit> best;
    double best_key = 0;
    for (size_t i = 0; i < faces_.size(); ++i) {
      if (closest_) {
        BRepExtrema_DistShapeShape distance(BRepBuilderAPI_MakeVertex(p).Vertex(), faces_[i]);
        if (!distance.IsDone() || distance.NbSolution() < 1 || distance.Value() > max_distance_) continue;
        // the nearest point may lie on an edge or a vertex of the face: its parameters come from the surface
        const gp_Pnt nearest = distance.PointOnShape2(1);
        const BRepAdaptor_Surface adaptor(faces_[i], Standard_True);
        const std::array<double, 2> uv = query::uv_of_point(faces_[i], adaptor, nearest);
        if (!best || distance.Value() < best_key) {
          best = Hit{static_cast<int>(i), nearest, uv[0], uv[1]};
          best_key = distance.Value();
        }
        continue;
      }
      IntCurvesFace_Intersector &intersector = *intersectors_[i];
      intersector.Perform(gp_Lin(p, direction_), -1e-9, 1e30);
      for (int k = 1; k <= intersector.NbPnt(); ++k) {
        if (intersector.State(k) == TopAbs_OUT) continue;
        const double w = intersector.WParameter(k);
        if (!best || w < best_key) {
          best = Hit{static_cast<int>(i), intersector.Pnt(k), intersector.UParameter(k), intersector.VParameter(k)};
          best_key = w;
        }
      }
    }
    return best;
  }

 private:
  const std::vector<TopoDS_Face> &faces_;
  bool closest_;
  gp_Dir direction_;
  double max_distance_;
  std::vector<std::unique_ptr<IntCurvesFace_Intersector>> intersectors_;
};

// degree, pole count, knot count, rational flag, xyz poles, weights (rational only), knots, multiplicities.
Handle(Geom_BSplineCurve) read_curve(rust::Slice<const double> d) {
  if (d.size() < 4) throw std::invalid_argument("curve: header too short");
  const auto count = [&](double value, int minimum, int maximum) {
    if (!(value >= minimum && value <= maximum) || value != std::floor(value)) throw std::invalid_argument("curve: a count is not an integer in range");
    return static_cast<int>(value);
  };
  const int degree = count(d[0], 1, 25);
  const int poles_n = count(d[1], 2, 20000);
  const int knots_n = count(d[2], 2, 20000);
  const bool rational = d[3] != 0.0;
  const size_t expected = 4 + 3 * static_cast<size_t>(poles_n) + (rational ? static_cast<size_t>(poles_n) : 0) + 2 * static_cast<size_t>(knots_n);
  if (d.size() != expected) throw std::invalid_argument("curve: length mismatch");
  size_t at = 4;
  TColgp_Array1OfPnt poles(1, poles_n);
  for (int i = 1; i <= poles_n; ++i, at += 3) poles.SetValue(i, gp_Pnt(d[at], d[at + 1], d[at + 2]));
  TColStd_Array1OfReal weights(1, poles_n);
  for (int i = 1; i <= poles_n; ++i) weights.SetValue(i, rational ? d[at++] : 1.0);
  TColStd_Array1OfReal knots(1, knots_n);
  for (int i = 1; i <= knots_n; ++i) knots.SetValue(i, d[at++]);
  TColStd_Array1OfInteger mults(1, knots_n);
  long total = 0;
  for (int i = 1; i <= knots_n; ++i) {
    mults.SetValue(i, count(d[at++], 1, degree + 1));
    total += mults(i);
  }
  if (total != poles_n + degree + 1) throw std::invalid_argument("curve: multiplicities do not fit the poles");
  if (rational) return new Geom_BSplineCurve(poles, weights, knots, mults, degree);
  return new Geom_BSplineCurve(poles, knots, mults, degree);
}

void write_curve3(JsonWriter &out, const Handle(Geom_BSplineCurve) & curve) {
  out.begin_object().key("degree").integer(curve->Degree()).key("poles").begin_array();
  for (int i = 1; i <= curve->NbPoles(); ++i) out.point(curve->Pole(i));
  out.end_array();
  if (curve->IsRational()) {
    out.key("weights").begin_array();
    for (int i = 1; i <= curve->NbPoles(); ++i) out.number(curve->Weight(i));
    out.end_array();
  }
  out.key("knots").begin_array();
  for (int i = 1; i <= curve->NbKnots(); ++i) out.number(curve->Knot(i));
  out.end_array().key("multiplicities").begin_array();
  for (int i = 1; i <= curve->NbKnots(); ++i) out.integer(curve->Multiplicity(i));
  out.end_array().end_object();
}

void write_curve2(JsonWriter &out, const Handle(Geom2d_BSplineCurve) & curve) {
  out.begin_object().key("degree").integer(curve->Degree()).key("poles").begin_array();
  for (int i = 1; i <= curve->NbPoles(); ++i) out.begin_array().number(curve->Pole(i).X()).number(curve->Pole(i).Y()).end_array();
  out.end_array();
  if (curve->IsRational()) {
    out.key("weights").begin_array();
    for (int i = 1; i <= curve->NbPoles(); ++i) out.number(curve->Weight(i));
    out.end_array();
  }
  out.key("knots").begin_array();
  for (int i = 1; i <= curve->NbKnots(); ++i) out.number(curve->Knot(i));
  out.end_array().key("multiplicities").begin_array();
  for (int i = 1; i <= curve->NbKnots(); ++i) out.integer(curve->Multiplicity(i));
  out.end_array().end_object();
}

struct Run {
  int face = -1;
  std::vector<double> parameters;
  std::vector<Hit> hits;
};

// Two adjacent samples with a different outcome: the parameters (low keeps the outcome of `from`, high the other) closest to the change.
void bisect_change(const Projector &projector, const Handle(Geom_BSplineCurve) & curve, double from, double to, int face_from, double &low, double &high) {
  low = from;
  high = to;
  for (int k = 0; k < kBisections; ++k) {
    const double mid = 0.5 * (low + high);
    const std::optional<Hit> hit = projector.locate(curve->Value(mid));
    const int outcome = hit ? hit->face : -1;
    if (outcome == face_from) low = mid;
    else high = mid;
  }
}

}  // namespace

rust::String project_curves_json(const Shape &shape, rust::Slice<const uint32_t> face_indices, rust::Slice<const double> curves,
                                 rust::Slice<const uint32_t> lengths, int32_t mode, rust::Slice<const double> direction, double max_distance,
                                 double sample_step, double tolerance) {
  if (direction.size() != 3) throw std::invalid_argument("project: direction needs 3 components");
  const TopTools_IndexedMapOfShape all_faces = query::distinct(shape.shape, TopAbs_FACE);
  std::vector<TopoDS_Face> faces;
  for (uint32_t index : face_indices) {
    if (index >= static_cast<uint32_t>(all_faces.Extent())) throw std::invalid_argument("project: face index out of range");
    faces.push_back(TopoDS::Face(all_faces(static_cast<int>(index) + 1)));
  }
  if (faces.empty()) throw std::invalid_argument("project: no faces");
  const bool closest = mode == 1;
  const Projector projector(faces, closest, closest ? gp_Dir(0, 0, 1) : gp_Dir(direction[0], direction[1], direction[2]), max_distance);
  JsonWriter out;
  out.begin_object().key("curves").begin_array();
  std::vector<double> coverage;
  size_t offset = 0;
  for (size_t source = 0; source < lengths.size(); ++source) {
    if (offset + lengths[source] > curves.size()) throw std::invalid_argument("project: curve lengths overrun");
    const Handle(Geom_BSplineCurve) curve = read_curve(rust::Slice<const double>(curves.data() + offset, lengths[source]));
    offset += lengths[source];
    const double first = curve->FirstParameter();
    const double last = curve->LastParameter();
    const double length = GCPnts_AbscissaPoint::Length(GeomAdaptor_Curve(curve));
    const int samples = std::max(kMinSamples, std::min(kMaxSamples, static_cast<int>(std::ceil(length / std::max(sample_step, 1e-12)))));
    std::vector<Run> runs;
    int previous = -2;
    double previous_t = first;
    for (int i = 0; i <= samples; ++i) {
      const double t = first + (last - first) * i / samples;
      const std::optional<Hit> hit = projector.locate(curve->Value(t));
      const int outcome = hit ? hit->face : -1;
      if (i > 0 && outcome != previous) {
        double low = 0, high = 0;
        bisect_change(projector, curve, previous_t, t, previous, low, high);
        if (previous >= 0 && !runs.empty()) {
          const std::optional<Hit> edge = projector.locate(curve->Value(low));
          if (edge && edge->face == previous && (runs.back().parameters.empty() || runs.back().parameters.back() < low)) {
            runs.back().parameters.push_back(low);
            runs.back().hits.push_back(*edge);
          }
        }
        const std::optional<Hit> start = projector.locate(curve->Value(high));
        if (start) {
          Run run;
          run.face = start->face;
          run.parameters.push_back(high);
          run.hits.push_back(*start);
          runs.push_back(run);
        }
      }
      if (hit) {
        if (runs.empty() || runs.back().face != outcome) {
          Run run;
          run.face = outcome;
          runs.push_back(run);
        }
        if (runs.back().parameters.empty() || runs.back().parameters.back() < t) {
          runs.back().parameters.push_back(t);
          runs.back().hits.push_back(*hit);
        }
      }
      previous = outcome;
      previous_t = t;
    }
    double covered = 0;
    for (const Run &run : runs) {
      if (run.hits.size() < 2) continue;
      const size_t n = run.hits.size();
      covered += run.parameters.back() - run.parameters.front();
      TColgp_Array1OfPnt points(1, static_cast<int>(n));
      TColgp_Array1OfPnt2d uvs(1, static_cast<int>(n));
      const BRepAdaptor_Surface surface(faces[static_cast<size_t>(run.face)], Standard_True);
      const bool periodic = surface.IsUPeriodic();
      const double period = periodic ? surface.UPeriod() : 0.0;
      double previous_u = run.hits[0].u;
      for (size_t k = 0; k < n; ++k) {
        double u = run.hits[k].u;
        if (periodic && k > 0) u += std::round((previous_u - u) / period) * period;
        previous_u = u;
        points.SetValue(static_cast<int>(k) + 1, run.hits[k].point);
        uvs.SetValue(static_cast<int>(k) + 1, gp_Pnt2d(u, run.hits[k].v));
      }
      // every sample on one point (a source line running straight at the face): nothing to fit
      double spread = 0;
      for (size_t k = 1; k < n; ++k) spread = std::max(spread, run.hits[k].point.Distance(run.hits[0].point));
      if (spread < 1e-9) continue;
      const int max_degree = std::min<int>(8, static_cast<int>(n) - 1);
      const int min_degree = std::min<int>(3, max_degree);
      GeomAPI_PointsToBSpline fit3(points, min_degree, max_degree, GeomAbs_C2, tolerance);
      Geom2dAPI_PointsToBSpline fit2(uvs, min_degree, max_degree, GeomAbs_C2, std::max(1e-9, 1e-2 * tolerance));
      if (!fit3.IsDone() || !fit2.IsDone()) continue;
      out.begin_object().key("source").integer(static_cast<long long>(source)).key("face").integer(face_indices[static_cast<size_t>(run.face)]);
      out.key("t0").number(run.parameters.front()).key("t1").number(run.parameters.back()).key("curve");
      write_curve3(out, fit3.Curve());
      out.key("pcurve");
      write_curve2(out, fit2.Curve());
      out.end_object();
    }
    coverage.push_back(last > first ? std::min(1.0, covered / (last - first)) : 0.0);
  }
  out.end_array().key("coverage").begin_array();
  for (double value : coverage) out.number(value);
  out.end_array().end_object();
  return rust::String(out.text());
}

}  // namespace llull
