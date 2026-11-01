// Oblique ends where a VARYING size runs past the end of the edge (BLD M2, TECHNICAL_SPEC §13.37): the size law is continued past the end vertex by its
// end tangent, the sections beyond the vertex are the circular blend's own scaled about their apex to that size (a straight edge between two flat faces:
// the apex is the point of the edge and the contact points move along the faces), and the faces around the end are rebuilt around the new contact points.
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <GeomConvert.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_Line.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"

namespace llull {
namespace blend {
namespace rails {

namespace {

// Cross-check of the exact end slope of the law: a one-sided quadratic fit through the ball radius at the vertex and at this fraction (and twice it) of the edge's
// length inside it.
constexpr double kBaseline = 0.02;
// The continued size may fall to this fraction of the size at the vertex at most (a law that reaches zero within the extension has no blend there).
constexpr double kLeastSize = 0.05;
// A section whose apex lies less than this fraction of the diagonal beyond the vertex is not beyond it.
constexpr double kBeyond = 1e-9;
// The slope fitted on the circular blend may differ from the law's exact end slope by this fraction of the size over the fit (twice the baseline) at most.
constexpr double kSlopeCheck = 2e-3;
// The new contact point of a rail may lie this far (x the edge it moves along, or x the end curve of the blend) from the old one at most.
constexpr double kMostMove = 0.25;

// The section of the circular blend at `along` as the skin reads it (before any continuation): its apex's distance beyond the vertex along `outward`, and the
// radius of its rolling ball.
bool probe(const BRepAdaptor_Surface &surface, const Blend &blend, double along, const gp_Pnt &vertex, const gp_Vec &outward, double &delta, double &radius,
           std::string &why) {
  Section section;
  if (!section_at(surface, blend, along, false, 0.5, section, why)) return false;
  delta = gp_Vec(vertex, section.t).Dot(outward);
  radius = 0.5 * (section.a.Distance(section.centre) + section.b.Distance(section.centre));
  return true;
}

// Bisection for the parameter between `inside` (apex short of `target`) and `outside` (apex beyond it) where the apex lies `target` beyond the vertex.
bool find_along(const BRepAdaptor_Surface &surface, const Blend &blend, double inside, double outside, const gp_Pnt &vertex, const gp_Vec &outward,
                double target, double &along, double &radius, std::string &why) {
  double lo = inside, hi = outside, delta = 0;
  for (int step = 0; step < 80; ++step) {
    const double middle = 0.5 * (lo + hi);
    if (!probe(surface, blend, middle, vertex, outward, delta, radius, why)) return false;
    (delta < target ? lo : hi) = middle;
  }
  along = 0.5 * (lo + hi);
  return probe(surface, blend, along, vertex, outward, delta, radius, why);
}

// The segment from `from` to `to` as a degree 1 B-spline.
Handle(Geom_BSplineCurve) segment(const gp_Pnt &from, const gp_Pnt &to) {
  const gp_Vec direction(from, to);
  return GeomConvert::CurveToBSplineCurve(new Geom_TrimmedCurve(new Geom_Line(from, gp_Dir(direction)), 0.0, direction.Magnitude()));
}

}  // namespace

bool plan_extension(Blend &blend, const TopoDS_Edge &source, double diagonal, std::string &why) {
  if ((!blend.oblique[0] && !blend.oblique[1]) || blend.closed || source.IsNull()) return true;
  const BRepAdaptor_Curve line(source);
  if (line.GetType() != GeomAbs_Line) return true;
  for (int rail = 0; rail < 2; ++rail)
    if (blend.supports[rail].size() != 1 || BRepAdaptor_Surface(blend.supports[rail][0].face, Standard_False).GetType() != GeomAbs_Plane) return true;
  const BRepAdaptor_Surface surface(blend.face, Standard_False);
  const gp_Pnt ends[2] = {line.Value(line.FirstParameter()), line.Value(line.LastParameter())};
  const double length = ends[0].Distance(ends[1]);
  if (!(length > 0)) return true;
  for (int side = 0; side < 2; ++side) {
    if (!blend.oblique[side] || blend.curved[side]) continue;
    const BRepAdaptor_Curve end_curve(blend.end[side]);
    const gp_Pnt middle = end_curve.Value(0.5 * (end_curve.FirstParameter() + end_curve.LastParameter()));
    const int which = ends[0].Distance(middle) <= ends[1].Distance(middle) ? 0 : 1;
    // the exact end slope of the law (13.37.1); an end where the size does not change needs no placed vertex when the circular blend stays inside the edge
    if (!blend.law_known) {
      why = "internal error: the size law of the edge a blend with an oblique end rounds is not among the laws given";
      return false;
    }
    if (ends[which].Distance(middle) > 0.5 * length) {
      why = "internal error: the end vertex of the edge could not be placed for the size law past an oblique end: the end curve of the circular blend lies " + number(ends[which].Distance(middle)) +
            " from the nearer end of an edge only " + number(length) + " long (more than half of it)";
      return false;
    }
    const gp_Pnt vertex = ends[which];
    const gp_Vec outward = gp_Vec(ends[1 - which], vertex) / length;
    // the apex of the middle section is well inside the edge and that of the farthest section of the skin is the farthest
    const double inside = 0.5 * (blend.reach[0] + blend.reach[1]), outside = side == 0 ? blend.lo : blend.hi;
    double reach_delta = 0, radius = 0, inside_delta = 0;
    if (!probe(surface, blend, outside, vertex, outward, reach_delta, radius, why) || !probe(surface, blend, inside, vertex, outward, inside_delta, radius, why))
      return false;
    if (reach_delta <= kBeyond * diagonal) continue;
    if (!(inside_delta < 0)) {
      why = "internal error: the size law past an oblique end could not be placed: the apex of the middle section of the blend is not inside the edge";
      return false;
    }
    double a0 = 0, r0 = 0;
    if (!find_along(surface, blend, inside, outside, vertex, outward, 0.0, a0, r0, why)) return false;
    // the exact slope of the law at this end (outward); the fit on the circular blend is only the cross-check
    // the kernel's own spline has no end slope derived from its nodes (NaN): it is read from the circular blend by the fit; any other law is exact and the fit only checks it
    const bool exact = !std::isnan(blend.law_slope[which]);
    double slope = blend.law_slope[which];
    if (!exact && !(inside_delta <= -2.5 * kBaseline * length)) {
      why = "internal error: the end slope of the kernel's own size law past an oblique end could not be measured: the edge is only " + number(length) + " long";
      return false;
    }
    if (inside_delta <= -2.5 * kBaseline * length) {
      double a1 = 0, a2 = 0, r1 = 0, r2 = 0;
      if (!find_along(surface, blend, inside, outside, vertex, outward, -kBaseline * length, a1, r1, why) ||
          !find_along(surface, blend, inside, outside, vertex, outward, -2.0 * kBaseline * length, a2, r2, why))
        return false;
      const double h = kBaseline * length, first = r0 - r1, second = r0 - r2;
      const double measured = (first + (2.0 * first - second) / 2.0) / h;
      if (!exact) slope = measured;
      else if (std::fabs(measured - slope) * 2.0 * h > kSlopeCheck * r0) {
        why = "internal error: the end slope of the size law (" + number(slope) + ") and the slope measured on the circular blend (" + number(measured) + ") differ by more than " +
              number(kSlopeCheck) + " of the size over the fit";
        return false;
      }
    }
    if (!(r0 + slope * reach_delta >= kLeastSize * r0)) {
      why = "internal error: the size of the blend continued past the end of the edge by its end tangent (" + number(slope) + " per unit, from " + number(r0) +
            ") falls to " + number(r0 + slope * reach_delta) + " within the " + number(reach_delta) + " the oblique end face needs (least " + number(kLeastSize * r0) +
            "): a size that reaches zero has no blend there";
      return false;
    }
    blend.extend[side] = Extension{true, vertex, outward, r0, slope};
  }
  return true;
}

void continue_size(const Blend &blend, double radius, Section &section) {
  for (int side = 0; side < 2; ++side) {
    const Extension &extension = blend.extend[side];
    if (!extension.active) continue;
    const double delta = gp_Vec(extension.vertex, section.t).Dot(extension.outward);
    if (delta <= 0) continue;
    const double scale = (extension.size + extension.slope * delta) / radius;
    section.a = section.t.Translated(gp_Vec(section.t, section.a) * scale);
    section.b = section.t.Translated(gp_Vec(section.t, section.b) * scale);
    section.centre = section.t.Translated(gp_Vec(section.t, section.centre) * scale);
  }
}

bool extension_edits(const Blend &blend, const Handle(Geom_BSplineSurface) &skin, Handle(Geom_Curve) (&end_curves)[2], double gap_limit,
                     const TopTools_IndexedDataMapOfShapeListOfShape &edge_faces, const std::function<FaceEdit &(const TopoDS_Face &)> &edit_of,
                     std::string &why) {
  double u0, u1, v0, v1;
  skin->Bounds(u0, u1, v0, v1);
  BRep_Builder builder;
  // the vertex where each rail meets each extended end: the old one of the circular blend and a new one at the end of the new end curve
  TopoDS_Vertex old_vertex[2][2], new_vertex[2][2];
  for (int side = 0; side < 2; ++side) {
    if (!blend.extend[side].active) continue;
    const TopoDS_Vertex first = TopExp::FirstVertex(blend.end[side]);
    for (int rail = 0; rail < 2; ++rail) {
      if (!TopExp::CommonVertex(blend.supports[rail][0].edge, blend.end[side], old_vertex[side][rail])) {
        why = "internal error: a contact line of the blend and its end edge share no vertex";
        return false;
      }
      const bool at_start = old_vertex[side][rail].IsSame(first);
      const gp_Pnt point = end_curves[side]->Value(at_start ? end_curves[side]->FirstParameter() : end_curves[side]->LastParameter());
      if (point.Distance(BRep_Tool::Pnt(old_vertex[side][rail])) > kMostMove * BRep_Tool::Pnt(first).Distance(BRep_Tool::Pnt(TopExp::LastVertex(blend.end[side])))) {
        why = "internal error: the contact point of the blend on an end face moves by " + number(point.Distance(BRep_Tool::Pnt(old_vertex[side][rail]))) +
              " when the size is continued past the end of the edge, more than a quarter of the end curve of the circular blend";
        return false;
      }
      builder.MakeVertex(new_vertex[side][rail], point, gap_limit);
    }
  }
  // the contact lines: the iso-lines of the skin cut at each oblique end plane
  for (int rail = 0; rail < 2; ++rail) {
    const Handle(Geom_Curve) iso = skin->UIso(rail == 0 ? u0 : u1);
    double bound[2] = {v0, v1};
    for (int side = 0; side < 2; ++side) {
      if (!blend.oblique[side]) continue;
      const auto height = [&](double v) { return gp_Vec(blend.end_point[side], iso->Value(v)).Dot(blend.end_normal[side].Normalized()); };
      double inside = 0.5 * (v0 + v1), outside = side == 0 ? v0 : v1;
      if (!(height(inside) < 0 && height(outside) > 0)) {
        why = "internal error: a contact line of the skin does not cross the plane of an oblique end face";
        return false;
      }
      for (int step = 0; step < 100; ++step) {
        const double middle = 0.5 * (inside + outside);
        (height(middle) < 0 ? inside : outside) = middle;
      }
      bound[side] = 0.5 * (inside + outside);
      if (blend.extend[side].active &&
          iso->Value(bound[side]).Distance(BRep_Tool::Pnt(new_vertex[side][rail])) > gap_limit) {
        why = "internal error: the cut of the skin by an oblique end plane misses the end of a contact line by " +
              number(iso->Value(bound[side]).Distance(BRep_Tool::Pnt(new_vertex[side][rail]))) + " (limit " + number(gap_limit) + ")";
        return false;
      }
    }
    Handle(Geom_BSplineCurve) piece = Handle(Geom_BSplineCurve)::DownCast(iso->Copy());
    if (piece.IsNull() || !(bound[1] > bound[0])) {
      why = "internal error: a contact line of the skin could not be cut at the oblique end planes";
      return false;
    }
    piece->Segment(bound[0], bound[1]);
    FaceEdit &support = edit_of(blend.supports[rail][0].face);
    support.replacements.push_back({blend.supports[rail][0].edge, piece, {blend.extend[0].active ? new_vertex[0][rail] : TopoDS_Vertex(), blend.extend[1].active ? new_vertex[1][rail] : TopoDS_Vertex()}, gap_limit});
  }
  // the edge the end face shares with each support moves with the contact point (a segment of the same line, from its far vertex to the new point)
  for (int side = 0; side < 2; ++side) {
    if (!blend.extend[side].active) continue;
    for (int rail = 0; rail < 2; ++rail) {
      const TopoDS_Face &end_face = blend.end_face[side], &support = blend.supports[rail][0].face;
      TopoDS_Edge shared;
      TopTools_IndexedMapOfShape seen;
      for (TopExp_Explorer it(end_face, TopAbs_EDGE); it.More(); it.Next()) {
        if (!seen.Add(it.Current()) || it.Current().IsSame(blend.end[side])) continue;
        const TopoDS_Edge edge = TopoDS::Edge(it.Current());
        if (!TopExp::FirstVertex(edge).IsSame(old_vertex[side][rail]) && !TopExp::LastVertex(edge).IsSame(old_vertex[side][rail])) continue;
        for (TopTools_ListIteratorOfListOfShape owner(edge_faces.FindFromKey(edge)); owner.More(); owner.Next())
          if (owner.Value().IsSame(support)) shared = edge;
      }
      if (shared.IsNull()) {
        why = "internal error: the end face has no edge shared with the support face at the contact point of the blend (the edge the contact point moves along)";
        return false;
      }
      const TopoDS_Vertex anchor_vertex = TopExp::FirstVertex(shared).IsSame(old_vertex[side][rail]) ? TopExp::LastVertex(shared) : TopExp::FirstVertex(shared);
      const gp_Pnt anchor = BRep_Tool::Pnt(anchor_vertex), old = BRep_Tool::Pnt(old_vertex[side][rail]), fresh = BRep_Tool::Pnt(new_vertex[side][rail]);
      if (fresh.Distance(old) > kMostMove * anchor.Distance(old) || gp_Vec(anchor, fresh).Dot(gp_Vec(anchor, old)) <= 0) {
        why = "the contact point of the blend moves by " + number(fresh.Distance(old)) + " along the edge of the end face it lies on, which is only " +
              number(anchor.Distance(old)) + " long (the size continued past the end of the edge)";
        return false;
      }
      const Handle(Geom_BSplineCurve) moved = segment(anchor, fresh);
      edit_of(end_face).replacements.push_back({shared, moved, {TopoDS_Vertex(), new_vertex[side][rail]}, 0.0});
      edit_of(support).replacements.push_back({shared, moved, {TopoDS_Vertex(), new_vertex[side][rail]}, 0.0});
    }
  }
  // the end faces: the new end curve between the new vertices, or the section edge of a square end
  for (int side = 0; side < 2; ++side) {
    if (blend.end_face[side].IsNull()) continue;
    if (blend.extend[side].active) {
      const TopoDS_Vertex first = TopExp::FirstVertex(blend.end[side]);
      const int start_rail = old_vertex[side][0].IsSame(first) ? 0 : 1;
      edit_of(blend.end_face[side]).replacements.push_back({blend.end[side], end_curves[side], {new_vertex[side][start_rail], new_vertex[side][1 - start_rail]}, gap_limit});
    } else {
      edit_of(blend.end_face[side]).replacements.push_back(
          {blend.end[side], blend.oblique[side] ? end_curves[side] : Handle(Geom_Curve)(skin->VIso(side == 0 ? v0 : v1)), {}, blend.oblique[side] ? gap_limit : 0.0});
    }
  }
  return true;
}

}  // namespace rails
}  // namespace blend
}  // namespace llull
