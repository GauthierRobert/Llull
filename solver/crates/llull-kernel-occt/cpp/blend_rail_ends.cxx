// Oblique ends of a rail-preserving profile blend (BLD M2, TECHNICAL_SPEC §13.35): the skin is built over the whole parameter range of OCCT's blend surface, which
// reaches past the end of the shorter contact line, and is cut back by the plane of each oblique end face. The extension is a SURFACE that is cut away again, not a
// tool solid, so there is no material it can notch; what guards it is that the cut meets the circular blend's own end vertices.
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <GC_MakeCircle.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <Geom_Circle.hxx>
#include <gp_Circ.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <GeomConvert.hxx>
#include <GeomConvert_CompCurveToBSplineCurve.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"

namespace llull {
namespace blend {
namespace rails {

namespace {

// Stations along the extension of a contact line that check_extension samples.
constexpr int kExtensionStations = 8;
// The most the chord of the section may change (relative) between the slopes inside and outside the end of the circular blend's contact lines.
constexpr double kLawKink = 1e-5;
// The most the skin may leave a support face at (radians) in the extension: the blend is tangent to it.
constexpr double kExtensionAngle = 1e-4;

// The half space on the outer side of the plane through `point` with outward `normal`, as a box large enough for the part.
TopoDS_Shape outer_box(const gp_Pnt &point, const gp_Vec &normal, double extent) {
  const gp_Ax2 frame(point, gp_Dir(normal));
  const gp_Pnt corner = point.Translated(frame.XDirection().XYZ() * (-extent) + frame.YDirection().XYZ() * (-extent));
  return BRepPrimAPI_MakeBox(gp_Ax2(corner, gp_Dir(normal), frame.XDirection()), 2 * extent, 2 * extent, extent).Shape();
}

// True when every interior sample of `edge` lies on the end face of oblique end `side` (its plane, or the surface of a curved end face) within `tolerance`.
bool on_end(const Blend &blend, int side, const TopoDS_Edge &edge, double tolerance) {
  const BRepAdaptor_Curve curve(edge);
  for (int k = 1; k <= 5; ++k) {
    const gp_Pnt at = curve.Value(curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * k / 6.0);
    if (blend.curved[side]) {
      gp_Pnt on;
      if (!project_on_face(blend.end_face[side], at, on) || on.Distance(at) > tolerance) return false;
    } else if (std::fabs(gp_Vec(blend.end_point[side], at).Dot(blend.end_normal[side].Normalized())) > tolerance) {
      return false;
    }
  }
  return true;
}

// The edge as a B-spline curve in world coordinates over the edge's own range; null when it has no 3D curve.
Handle(Geom_Curve) curve_of(const TopoDS_Edge &edge) {
  TopoDS_Edge copy = edge;
  double first = 0, last = 0;
  TopLoc_Location location;
  Handle(Geom_Curve) curve = BRep_Tool::Curve(copy, location, first, last);
  if (curve.IsNull()) {
    BRepLib::BuildCurves3d(copy);
    curve = BRep_Tool::Curve(copy, location, first, last);
    if (curve.IsNull()) return curve;
  }
  Handle(Geom_BSplineCurve) spline = GeomConvert::CurveToBSplineCurve(new Geom_TrimmedCurve(curve, first, last));
  if (spline.IsNull()) return spline;
  spline->Transform(location.Transformation());
  return spline;
}

// The pieces joined end to end into ONE curve that starts at the end of a piece nearest `from`; every piece is used.
bool chain_pieces(const std::vector<Handle(Geom_BSplineCurve)> &pieces, const gp_Pnt &from, double gap_limit, Handle(Geom_Curve) &out, std::string &why) {
  GeomConvert_CompCurveToBSplineCurve chain;
  std::vector<bool> used(pieces.size(), false);
  gp_Pnt at = from;
  for (size_t count = 0; count < pieces.size(); ++count) {
    size_t next = pieces.size();
    bool reversed = false;
    double nearest = count == 0 ? 1e300 : gap_limit;
    for (size_t k = 0; k < pieces.size(); ++k) {
      if (used[k]) continue;
      const double head = pieces[k]->StartPoint().Distance(at), tail = pieces[k]->EndPoint().Distance(at);
      if (std::min(head, tail) <= nearest) {
        nearest = std::min(head, tail);
        next = k;
        reversed = tail < head;
      }
    }
    if (next == pieces.size()) {
      why = "internal error: the pieces of the cut of the blend surface by an oblique end face do not form one chain";
      return false;
    }
    used[next] = true;
    Handle(Geom_BSplineCurve) piece = Handle(Geom_BSplineCurve)::DownCast(pieces[next]->Copy());
    if (reversed) piece->Reverse();
    if (!chain.Add(piece, std::max(gap_limit, 1e-9))) {
      why = "internal error: the pieces of the cut of the blend surface by an oblique end face could not be joined";
      return false;
    }
    at = piece->EndPoint();
  }
  out = chain.BSplineCurve();
  return true;
}

}  // namespace

bool trim_oblique(const TopoDS_Face &skin_face, const Blend &blend, double diagonal, double gap_limit, TopoDS_Face &trimmed,
                  Handle(Geom_Curve) (&end_curves)[2], std::string &why) {
  TopTools_ListOfShape arguments, cutters;
  arguments.Append(skin_face);
  for (int side = 0; side < 2; ++side)
    if (blend.oblique[side] && !blend.curved[side]) cutters.Append(outer_box(blend.end_point[side], blend.end_normal[side], 2.0 * diagonal));
  trimmed = skin_face;
  if (!cutters.IsEmpty()) {
    BRepAlgoAPI_Cut cut;
    cut.SetArguments(arguments);
    cut.SetTools(cutters);
    cut.Build();
    if (!cut.IsDone() || cut.HasErrors()) {
      why = "internal error: the skin could not be cut back by the plane of an oblique end face";
      return false;
    }
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(cut.Shape(), TopAbs_FACE, faces);
    if (faces.Extent() != 1) {
      why = "internal error: the plane of an oblique end face cuts the blend surface into " + std::to_string(faces.Extent()) + " pieces (one expected)";
      return false;
    }
    trimmed = TopoDS::Face(faces(1));
  }
  // a curved end face cuts the skin by its surface (13.37)
  for (int side = 0; side < 2; ++side)
    if (blend.oblique[side] && blend.curved[side] && !split_by_end_surface(trimmed, blend, side, diagonal, why)) return false;
  // the piece that stays is on the solid's side of each end plane, as the circular blend face is (the outward normal of the end face points away from the blend)
  GProp_GProps kept, circular;
  BRepGProp::SurfaceProperties(trimmed, kept);
  BRepGProp::SurfaceProperties(blend.face, circular);
  for (int side = 0; side < 2; ++side) {
    double kept_height = 0, circular_height = 0;
    if (blend.oblique[side] && (!end_height(blend, side, kept.CentreOfMass(), kept_height) || !end_height(blend, side, circular.CentreOfMass(), circular_height))) {
      why = "internal error: the surface of a curved end face could not be projected on";
      return false;
    }
    if (blend.oblique[side] && (kept_height >= 0 || circular_height >= 0)) {
      why = "the outward side of an oblique end face does not leave the blend on the solid's side (the blend continues past the end face)";
      return false;
    }
  }
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(trimmed, TopAbs_EDGE, edges);
  // The edges in an end plane. The cut may split the end curve at a vertex of its own, and both ends of an arc can lie in one plane: each end takes the chain of
  // those edges that runs from the first vertex of the circular blend's own end edge to its last one, merged into ONE curve.
  std::vector<Handle(Geom_BSplineCurve)> pieces;
  for (int e = 1; e <= edges.Extent(); ++e)
    for (int side = 0; side < 2; ++side)
      if (blend.oblique[side] && on_end(blend, side, TopoDS::Edge(edges(e)), gap_limit)) {
        const Handle(Geom_Curve) curve = curve_of(TopoDS::Edge(edges(e)));
        if (curve.IsNull()) {
          why = "internal error: the cut of the blend surface by an oblique end face has no 3D curve";
          return false;
        }
        pieces.push_back(Handle(Geom_BSplineCurve)::DownCast(curve));
        break;
      }
  for (int side = 0; side < 2; ++side) {
    if (!blend.oblique[side]) continue;
    if (blend.extend[side].active) {
      // the size is continued past the end of the edge (13.37): the contact points are new, so the end curve is the chain of ALL the in-plane pieces of this end,
      // starting from the one nearest the first vertex of the circular blend's end edge
      std::vector<Handle(Geom_BSplineCurve)> here;
      for (int e = 1; e <= edges.Extent(); ++e)
        if (on_end(blend, side, TopoDS::Edge(edges(e)), gap_limit)) {
          const Handle(Geom_Curve) curve = curve_of(TopoDS::Edge(edges(e)));
          if (curve.IsNull()) {
            why = "internal error: the cut of the blend surface by an oblique end face has no 3D curve";
            return false;
          }
          here.push_back(Handle(Geom_BSplineCurve)::DownCast(curve));
        }
      if (!chain_pieces(here, BRep_Tool::Pnt(TopExp::FirstVertex(blend.end[side])), gap_limit, end_curves[side], why)) return false;
      continue;
    }
    const gp_Pnt start =BRep_Tool::Pnt(TopExp::FirstVertex(blend.end[side])), finish = BRep_Tool::Pnt(TopExp::LastVertex(blend.end[side]));
    GeomConvert_CompCurveToBSplineCurve chain;
    std::vector<bool> used(pieces.size(), false);
    gp_Pnt at = start;
    bool first = true;
    while (at.Distance(finish) > gap_limit || first) {
      size_t next = pieces.size();
      bool reversed = false;
      double nearest = gap_limit;
      for (size_t k = 0; k < pieces.size(); ++k) {
        if (used[k]) continue;
        const double head = pieces[k]->StartPoint().Distance(at), tail = pieces[k]->EndPoint().Distance(at);
        if (std::min(head, tail) <= nearest) {
          nearest = std::min(head, tail);
          next = k;
          reversed = tail < head;
        }
      }
      if (next == pieces.size()) {
        why = "internal error: the cut of the blend surface by an oblique end face does not join the end vertices of the circular blend (it stops " +
              std::to_string(at.Distance(finish)) + " from the last one; limit " + std::to_string(gap_limit) + "): the circular blend surface is not accurate past its end";
        return false;
      }
      used[next] = true;
      Handle(Geom_BSplineCurve) piece = Handle(Geom_BSplineCurve)::DownCast(pieces[next]->Copy());
      if (reversed) piece->Reverse();
      if (!chain.Add(piece, std::max(gap_limit, 1e-9))) {
        why = "internal error: the pieces of the cut of the blend surface by an oblique end face could not be joined";
        return false;
      }
      at = piece->EndPoint();
      first = false;
    }
    end_curves[side] = chain.BSplineCurve();
  }
  return true;
}


bool check_extension(const Blend &blend, double limit, std::string &why) {
  const BRepAdaptor_Surface surface(blend.face, Standard_False);
  const double span = blend.hi - blend.lo;
  double worst = 0, where = 0, arc_worst = 0, arc_where = 0, angle_worst = 0, angle_where = 0;
  for (int side = 0; side < 2; ++side) {
    if (!blend.oblique[side]) continue;
    const double from = side == 0 ? blend.lo : blend.hi, to = side == 0 ? blend.core[0] : blend.core[1];
    if (std::fabs(to - from) <= 1e-9 * span) continue;
    for (int k = 0; k <= kExtensionStations; ++k) {
      const double along = from + (to - from) * k / kExtensionStations;
      // the section there must be the circular arc through its contact points and midpoint (the ball): the other points of the iso-curve lie on it
      {
        const auto point = [&](double fraction) {
          const double across = blend.across[0] + (blend.across[1] - blend.across[0]) * fraction;
          return blend.across_is_u ? surface.Value(across, along) : surface.Value(along, across);
        };
        GC_MakeCircle circle(point(0.0), point(0.5), point(1.0));
        if (!circle.IsDone()) {
          why = "internal error: a section of the circular blend past its end is not a circle arc";
          return false;
        }
        const gp_Circ round = circle.Value()->Circ();
        for (const double fraction : {0.2, 0.4, 0.6, 0.8}) {
          const gp_Vec offset(round.Location(), point(fraction));
          const double out_of_plane = offset.Dot(gp_Vec(round.Axis().Direction()));
          const gp_Vec in_plane = offset - gp_Vec(round.Axis().Direction()) * out_of_plane;
          const double miss = std::hypot(in_plane.Magnitude() - round.Radius(), out_of_plane);
          if (miss > arc_worst) {
            arc_worst = miss;
            arc_where = along;
          }
        }
      }
      for (int rail = 0; rail < 2; ++rail) {
        const gp_Pnt contact = blend.across_is_u ? surface.Value(blend.across[rail], along) : surface.Value(along, blend.across[rail]);
        const RailPiece *nearest = nullptr;
        double gap = 1e300;
        for (const RailPiece &piece : blend.supports[rail]) {
          const double away = along < piece.lo ? piece.lo - along : (along > piece.hi ? along - piece.hi : 0.0);
          if (away < gap) {
            gap = away;
            nearest = &piece;
          }
        }
        gp_Pnt on;
        if (nearest == nullptr || !project_on_face(nearest->face, contact, on)) {
          why = "internal error: a contact point of the extended blend could not be projected on its support face";
          return false;
        }
        {
          // the blend meets the support tangentially there: the normals of the skin and of the support (the UNTRIMMED surface of the face, as the projection above) agree
          gp_Pnt at;
          gp_Vec du, dv;
          if (blend.across_is_u) surface.D1(blend.across[rail], along, at, du, dv);
          else surface.D1(along, blend.across[rail], at, du, dv);
          TopLoc_Location location;
          const Handle(Geom_Surface) support = BRep_Tool::Surface(nearest->face, location);
          GeomAPI_ProjectPointOnSurf projection(contact.Transformed(location.Transformation().Inverted()), support);
          if (support.IsNull() || projection.NbPoints() < 1) {
            why = "internal error: a contact point of the extended blend could not be projected on its support surface";
            return false;
          }
          double u = 0, v = 0;
          projection.LowerDistanceParameters(u, v);
          gp_Pnt on_support;
          gp_Vec su, sv;
          support->D1(u, v, on_support, su, sv);
          const gp_Vec n1 = du.Crossed(dv), n2 = su.Crossed(sv);
          if (n1.Magnitude() > 1e-14 && n2.Magnitude() > 1e-14) {
            const double angle = std::acos(std::min(1.0, std::fabs(n1.Normalized().Dot(n2.Normalized()))));
            if (angle > angle_worst) {
              angle_worst = angle;
              angle_where = along;
            }
          }
        }
        if (contact.Distance(on) > worst) {
          worst = contact.Distance(on);
          where = along;
        }
      }
    }
  }
  // A size that varies must be continued across the end of the circular blend's own contact lines: OCCT holds it constant past the end of the edge, which is
  // not the law the profile would follow there (the kink is inside the longer contact line, between reach and core).
  const auto chord = [&](double along) {
    const gp_Pnt a = blend.across_is_u ? surface.Value(blend.across[0], along) : surface.Value(along, blend.across[0]);
    const gp_Pnt b = blend.across_is_u ? surface.Value(blend.across[1], along) : surface.Value(along, blend.across[1]);
    return a.Distance(b);
  };
  for (int side = 0; side < 2; ++side) {
    if (!blend.oblique[side] || blend.extend[side].active) continue;
    const double out = blend.reach[side], edge = side == 0 ? blend.core[0] : blend.core[1];
    double step = edge - out;
    if (std::fabs(step) <= 1e-9 * span) continue;
    const double room = 0.5 * (blend.core[1] - blend.core[0]);
    if (std::fabs(step) > room) step = step < 0 ? -room : room;
    const double slope_out = (chord(edge) - chord(out)) / (edge - out), slope_in = (chord(edge + step) - chord(edge)) / step;
    if (std::fabs(slope_out - slope_in) * std::fabs(edge - out) > kLawKink * chord(edge)) {
      why = "the size of the blend does not continue past the end of the edge: the circular blend holds it constant there (the chord changes by " +
            std::to_string(slope_in * (edge - out)) + " along the extension where the extension holds " + std::to_string(chord(edge) - chord(out)) +
            "), so an oblique end that needs the extension of a varying size is not the profile of that size";
      return false;
    }
  }
  if (angle_worst > kExtensionAngle) {
    why = "the circular blend surface past the end of its shorter contact line meets the support face at " + std::to_string(angle_worst) + " rad (limit " +
          std::to_string(kExtensionAngle) + ", at parameter " + std::to_string(angle_where) +
          "): OCCT extends the surface of a varying size by extrapolation, so an oblique end that needs the extension is not exact";
    return false;
  }
  if (arc_worst > limit) {
    why = "the circular blend surface past the end of its shorter contact line is not made of circular arcs: its section misses the arc through its contact points by " +
          std::to_string(arc_worst) + " (limit " + std::to_string(limit) + ", at parameter " + std::to_string(arc_where) +
          "); OCCT extends the surface of a varying size by extrapolation, so an oblique end that needs the extension is not exact";
    return false;
  }
  if (worst > limit) {
    why = "the circular blend surface past the end of its shorter contact line leaves the support face by " + std::to_string(worst) + " (limit " +
          std::to_string(limit) + ", at parameter " + std::to_string(where) +
          "): OCCT extends the surface of a varying size by extrapolation, so an oblique end that needs the extension is not exact";
    return false;
  }
  return true;
}
}  // namespace rails
}  // namespace blend
}  // namespace llull
