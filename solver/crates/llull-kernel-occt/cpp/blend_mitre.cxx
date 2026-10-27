// Mitre ends of the rail-preserving profile blend (BLD M2, TECHNICAL_SPEC §13.16). OCCT rounds a creased tangent chain (the top rim of an N-gon prism, a
// polyline outline: creases up to about 0.1 rad) with one blend face per edge, each ending on the section plane of its own edge, so neighbouring faces
// miss by exactly r x turn. Here the end section of both blends is taken in the bisector plane of the two end section planes (the plane of equal signed
// distance beyond each), where the section of both is the same conic: the points of every section near the end slide along the end's section-plane
// normal, faded in by a quintic so the faces stay exactly on the swept profile (a prism's rulings are straight), and the support faces that bound the
// rails are re-trimmed to the new end points.
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepLib.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRep_Tool.hxx>
#include <TopExp.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"

namespace llull {
namespace blend {
namespace rails {

namespace {

// OCCT chains creases up to about 0.1 rad; a larger turn is a corner of the part, not a chain.
constexpr double kMostTurn = 0.5;
// A mitre transition must be this many times longer than the largest displacement, so the rows of the surface keep advancing (the speed along a row is
// 1 + shift x fade', and the quintic's fade' is at most 1.875).
constexpr double kTransitionOverShift = 4.0;

// The end section of `blend` at `side` before any mitre, the unit normal of its plane pointing out of the blend, and the speed (length per unit of
// parameter) of the ball centre there.
struct EndFrame {
  Section section;
  gp_Vec outward;
  double speed = 0;
};

bool end_frame(const Blend &blend, int side, EndFrame &frame, std::string &why) {
  const BRepAdaptor_Surface surface(blend.face, Standard_False);
  const double span = blend.hi - blend.lo;
  const double at = side == 0 ? blend.lo : blend.hi, inner = side == 0 ? blend.lo + 0.02 * span : blend.hi - 0.02 * span;
  Section near_end;
  if (!section_at(surface, blend, at, false, 0.5, frame.section, why) || !section_at(surface, blend, inner, false, 0.5, near_end, why)) return false;
  gp_Vec normal = gp_Vec(frame.section.a, frame.section.b).Crossed(gp_Vec(frame.section.a, frame.section.t));
  const gp_Vec travel(near_end.centre, frame.section.centre);
  if (normal.Magnitude() < 1e-12 || travel.Magnitude() < 1e-12) {
    why = "a section of the circular blend at a chain junction is degenerate";
    return false;
  }
  normal.Normalize();
  frame.outward = normal.Dot(travel) < 0 ? normal.Reversed() : normal;
  frame.speed = travel.Magnitude() / (0.02 * span);
  return true;
}

double along_plane(const gp_Vec &normal, const gp_Pnt &point) { return normal.Dot(gp_Vec(point.XYZ())); }

}  // namespace

bool plan_mitres(std::vector<Blend> &blends, const TopTools_IndexedMapOfShape &blend_faces, const TopTools_IndexedDataMapOfShapeListOfShape &vertex_faces,
                 double diagonal, bool constant_size, std::string &why) {
  std::vector<Mitre> planned(2 * blends.size());  // assigned at the end: every end section is read before any mitre moves it
  for (size_t index = 0; index < blends.size(); ++index) {
    for (int side = 0; side < 2; ++side) {
      Blend &blend = blends[index];
      if (blend.end[side].IsNull() || blend.end_blend[side].IsNull()) continue;
      const int found = blend_faces.FindIndex(blend.end_blend[side]);
      if (found < 1) continue;
      const Blend &next = blends[static_cast<size_t>(found - 1)];
      const int next_side = next.end[0].IsSame(blend.end[side]) ? 0 : (next.end[1].IsSame(blend.end[side]) ? 1 : -1);
      if (next_side < 0) {
        why = "two blends of a chain do not share the edge where they meet";
        return false;
      }
      EndFrame mine, theirs;
      if (!end_frame(blend, side, mine, why) || !end_frame(next, next_side, theirs, why)) return false;
      const double cosine = -mine.outward.Dot(theirs.outward);
      const double turn = std::acos(std::max(-1.0, std::min(1.0, cosine)));
      if (turn > kMostTurn) {
        why = "two blends of a chain meet across a crease of " + number(turn) + " rad (more than " + number(kMostTurn) + ": a corner of the part, not a tangent chain)";
        return false;
      }
      // Bisector plane of the two end section planes: equal signed distance beyond each (the planes pass through the two ball centres).
      const gp_Vec normal = mine.outward - theirs.outward;
      const double offset = along_plane(mine.outward, mine.section.centre) - along_plane(theirs.outward, theirs.section.centre);
      const double slope = normal.Dot(mine.outward);
      const gp_Pnt *points[4] = {&mine.section.a, &mine.section.t, &mine.section.b, &mine.section.centre};
      Mitre mitre;
      double largest = 0;
      for (int p = 0; p < 4; ++p) {
        mitre.shift[p] = mine.outward * ((offset - along_plane(normal, *points[p])) / slope);
        largest = std::max(largest, mitre.shift[p].Magnitude());
      }
      // a displacement this small is tangent continuity as OCCT leaves it, not a crease: the end sections already agree
      if (largest <= kStillFraction * diagonal) continue;
      // The section planes of a blend whose size changes along it are not perpendicular to its rails, so the displacement above would not keep the
      // contact points on their supports: the mitre is exact for straight edges with a constant size only.
      if (!constant_size) {
        why = "a creased chain needs a single radius (no radiusEnd / sizes / law, even 1 -> 1): the mitre is exact for a constant size only";
        return false;
      }
      const double span = blend.hi - blend.lo;
      mitre.length = 0.5 * span;
      mitre.turn = turn;
      if (mitre.length * mine.speed < kTransitionOverShift * largest) {
        why = "a blend of the chain is too short for its mitre: half of it (" + number(mitre.length * mine.speed) + ") must be at least " + number(kTransitionOverShift) +
              " x the displacement of its end section (" + number(largest) + ", so " + number(kTransitionOverShift * largest) + ")";
        return false;
      }
      mitre.active = true;
      for (int rail = 0; rail < 2; ++rail) {
        if (blend.supports[rail].size() != 1) {
          why = "a creased chain over a contact line that runs over several faces";
          return false;
        }
        const RailPiece &piece = blend.supports[rail][0];
        if (BRepAdaptor_Surface(piece.face, Standard_False).GetType() != GeomAbs_Plane) {
          why = "a creased chain over a curved support face (the support would have to be re-trimmed on a curved surface)";
          return false;
        }
        const double moved = mitre.shift[rail == 0 ? 0 : 2].Magnitude();
        if (moved <= kStillFraction * diagonal) continue;
        // a contact point that moves must not sit on an edge of the part: the vertex at the end of the rail is shared by the support and the two blends only
        TopoDS_Vertex first, last;
        TopExp::Vertices(TopoDS::Edge(piece.edge.Oriented(TopAbs_FORWARD)), first, last);
        const gp_Pnt target = rail == 0 ? mine.section.a : mine.section.b;
        const TopoDS_Vertex &vertex = BRep_Tool::Pnt(first).Distance(target) <= BRep_Tool::Pnt(last).Distance(target) ? first : last;
        if (!vertex_faces.Contains(vertex)) continue;
        for (TopTools_ListIteratorOfListOfShape owner(vertex_faces.FindFromKey(vertex)); owner.More(); owner.Next())
          if (!owner.Value().IsSame(piece.face) && !owner.Value().IsSame(blend.face) && !owner.Value().IsSame(next.face)) {
            why = "the mitre of a chain moves a contact point by " + number(moved) +
                  " where it sits on an edge of the part that the bisector plane does not contain (an asymmetric crease)";
            return false;
          }
      }
      planned[2 * index + static_cast<size_t>(side)] = mitre;
    }
  }
  for (size_t k = 0; k < blends.size(); ++k)
    for (size_t s = 0; s < 2; ++s) blends[k].mitre[s] = planned[2 * k + s];
  return true;
}

bool rebuild_face(const FaceEdit &edit, TopoDS_Face &out, std::string &why) {
  BRepTools_ReShape reshape;
  std::vector<TopoDS_Edge> fresh;
  for (const Replacement &replacement : edit.replacements) {
    const TopoDS_Edge forward = TopoDS::Edge(replacement.old_edge.Oriented(TopAbs_FORWARD));
    TopoDS_Vertex first, last;
    TopExp::Vertices(forward, first, last);
    Handle(Geom_Curve) curve = replacement.curve;
    TopoDS_Vertex start = replacement.vertex[0], end = replacement.vertex[1];
    const gp_Pnt head = BRep_Tool::Pnt(first);
    if (curve->Value(curve->FirstParameter()).Distance(head) > curve->Value(curve->LastParameter()).Distance(head)) {
      curve = curve->Reversed();
      std::swap(start, end);
    }
    BRepBuilderAPI_MakeEdge edge(curve, start.IsNull() ? first : start, end.IsNull() ? last : end);
    if (!edge.IsDone()) {
      why = "the new curve could not be made an edge of the face it trims";
      return false;
    }
    reshape.Replace(forward, edge.Edge());
    fresh.push_back(edge.Edge());
  }
  out = TopoDS::Face(reshape.Apply(edit.face));
  for (const TopoDS_Edge &edge : fresh) BRepLib::BuildPCurveForEdgeOnPlane(edge, out);
  return true;
}

}  // namespace rails
}  // namespace blend
}  // namespace llull
