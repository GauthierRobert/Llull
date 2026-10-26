// LawFillet: BRepFilletAPI_MakeFillet over a spine whose straight laws are exact (see law_fillet.hxx).
#include "llull-kernel-occt/cpp/law_fillet.hxx"

#include <algorithm>
#include <cmath>

#include <ChFiDS_Stripe.hxx>
#include <Law_BSpline.hxx>
#include <Law_BSpFunc.hxx>
#include <Law_Composite.hxx>
#include <Law_Interpol.hxx>
#include <Law_Laws.hxx>
#include <Law_Linear.hxx>
#include <Precision.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TopExp_Explorer.hxx>
#include <TopOpeBRepBuild_HBuilder.hxx>
#include <TopOpeBRepDS_HDataStructure.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>

namespace llull {

namespace {

struct Knot {
  double position;
  double radius;
};

// The nodes a Law_Interpol was interpolated through: its knots (the interpolation puts one knot at every given parameter) and its values there.
std::vector<Knot> knots_of(const Handle(Law_Interpol) & spline) {
  const Handle(Law_BSpline) curve = spline->Curve();
  TColStd_Array1OfReal knots(1, curve->NbKnots());
  curve->Knots(knots);
  std::vector<Knot> out;
  for (int k = knots.Lower(); k <= knots.Upper(); ++k) out.push_back({knots(k), curve->Value(knots(k))});
  return out;
}

}  // namespace

void LawSpine::add_node(double relative, double radius, int edge_in_contour, bool straight) {
  SetRadius(gp_XY(relative, radius), edge_in_contour);
  straight_[edge_in_contour] = straight;
}

// After the spine has computed the law of an elementary spine (one Law_Composite of constants and splines), every stretch of a spline that lies on
// an edge carrying a straight law becomes Law_Linear pieces through the knots of that very interpolation (the nodes OCCT kept). Every other stretch
// (a smooth edge, or an edge pulled into the contour by tangency with no law of its own) stays exactly OCCT's spline, trimmed to the stretch: the
// radius is continuous at a junction, the slope jumps there.
void LawSpine::AppendElSpine(const Handle(ChFiDS_ElSpine) & elspine) {
  ChFiDS_FilSpine::AppendElSpine(elspine);
  const bool any_straight = std::any_of(straight_.begin(), straight_.end(), [](const auto &entry) { return entry.second; });
  if (!any_straight) return;
  const Handle(Law_Composite) composite = Law(elspine);
  if (composite.IsNull()) return;
  const auto segment_straight = [&](double from, double to) {
    const auto found = straight_.find(Index(0.5 * (from + to)));
    return found != straight_.end() && found->second;
  };
  Law_Laws rebuilt;
  bool changed = false;
  for (Law_Laws::Iterator it(composite->ChangeLaws()); it.More(); it.Next()) {
    const Handle(Law_Interpol) spline = Handle(Law_Interpol)::DownCast(it.Value());
    const std::vector<Knot> knots = spline.IsNull() ? std::vector<Knot>() : knots_of(spline);
    bool straight_here = false;
    for (size_t k = 0; k + 1 < knots.size(); ++k) straight_here = straight_here || segment_straight(knots[k].position, knots[k + 1].position);
    if (!straight_here) {
      rebuilt.Append(it.Value());
      continue;
    }
    changed = true;
    size_t run = 0;
    while (run + 1 < knots.size()) {
      const bool straight = segment_straight(knots[run].position, knots[run + 1].position);
      size_t end = run + 1;
      while (end + 1 < knots.size() && segment_straight(knots[end].position, knots[end + 1].position) == straight) ++end;
      if (straight) {
        for (size_t k = run; k < end; ++k) {
          Handle(Law_Linear) piece = new Law_Linear();
          piece->Set(knots[k].position, knots[k].radius, knots[k + 1].position, knots[k + 1].radius);
          rebuilt.Append(piece);
        }
      } else {
        rebuilt.Append(spline->Trim(knots[run].position, knots[end].position, Precision::PConfusion()));
      }
      run = end;
    }
  }
  if (changed) composite->ChangeLaws() = rebuilt;
}

void LawBuilder::add_edge(const TopoDS_Edge &edge) {
  if (Contains(edge) || !myEFMap.Contains(edge)) return;
  Handle(ChFiDS_Stripe) stripe = new ChFiDS_Stripe();
  Handle(LawSpine) spine = new LawSpine(tolesp);
  stripe->ChangeSpine() = spine;
  TopoDS_Edge forward = edge;
  forward.Orientation(TopAbs_FORWARD);
  spine->SetEdges(forward);
  TopoDS_Face reference;
  if (PerformElement(spine, -1, reference)) {
    PerformExtremity(spine);
    spine->Load();
    myListStripe.Append(stripe);
  }
}

LawFillet::LawFillet(const TopoDS_Shape &shape) : builder_(shape) {}

LawFillet::Slot LawFillet::slot(const TopoDS_Edge &edge) {
  builder_.add_edge(edge);
  Slot found;
  const int contour = builder_.Contains(edge, found.index);
  if (contour != 0) found.spine = Handle(LawSpine)::DownCast(builder_.Value(contour));
  return found;
}

bool LawFillet::constant(const TopoDS_Edge &edge, double radius) {
  const Slot target = slot(edge);
  if (target.spine.IsNull()) return false;
  target.spine->add_node(0., radius, target.index, false);
  target.spine->add_node(1., radius, target.index, false);
  return true;
}

bool LawFillet::range(const TopoDS_Edge &edge, double start, double end) {
  // a difference below the confusion is the same radius, as BRepFilletAPI_MakeFillet reads it
  if (std::abs(start - end) < Precision::Confusion()) return constant(edge, 0.5 * (start + end));
  const Slot target = slot(edge);
  if (target.spine.IsNull()) return false;
  target.spine->add_node(0., start, target.index, false);
  target.spine->add_node(1., end, target.index, false);
  return true;
}

bool LawFillet::nodes(const TopoDS_Edge &edge, const std::vector<gp_Pnt2d> &nodes, bool straight) {
  if (nodes.size() == 1) return constant(edge, nodes.front().Y());
  if (nodes.size() == 2 && !straight) return range(edge, nodes.front().Y(), nodes.back().Y());
  const Slot target = slot(edge);
  if (target.spine.IsNull()) return false;
  for (const gp_Pnt2d &node : nodes) target.spine->add_node(node.X(), node.Y(), target.index, straight);
  return true;
}

void LawFillet::Build(const Message_ProgressRange &) {
  builder_.Compute();
  if (!builder_.IsDone()) return;
  Done();
  myShape = builder_.Shape();
  for (TopExp_Explorer face(myShape, TopAbs_FACE); face.More(); face.Next()) faces_.Add(face.Current());
}

const TopTools_ListOfShape &LawFillet::Generated(const TopoDS_Shape &shape) { return builder_.Generated(shape); }

const TopTools_ListOfShape &LawFillet::Modified(const TopoDS_Shape &shape) {
  myGenerated.Clear();
  const Handle(TopOpeBRepBuild_HBuilder) history = builder_.Builder();
  for (TopAbs_State state : {TopAbs_OUT, TopAbs_IN, TopAbs_ON})
    if (history->IsSplit(shape, state))
      for (TopTools_ListIteratorOfListOfShape it(history->Splits(shape, state)); it.More(); it.Next()) myGenerated.Append(it.Value());
  return myGenerated;
}

bool LawFillet::IsDeleted(const TopoDS_Shape &shape) {
  const Handle(TopOpeBRepBuild_HBuilder) history = builder_.Builder();
  return !(faces_.Contains(shape) || history->IsSplit(shape, TopAbs_OUT) || history->IsSplit(shape, TopAbs_IN) ||
           history->IsSplit(shape, TopAbs_ON));
}

int LawFillet::NbContours() const { return builder_.NbElements(); }
int LawFillet::Contour(const TopoDS_Edge &edge) const { return builder_.Contains(edge); }
int LawFillet::NbEdges(int contour) const { return builder_.Value(contour)->NbEdges(); }
const TopoDS_Edge &LawFillet::Edge(int contour, int k) const { return builder_.Value(contour)->Edges(k); }
ChFiDS_ErrorStatus LawFillet::StripeStatus(int contour) const { return builder_.StripeStatus(contour); }
int LawFillet::NbFaultyVertices() const { return builder_.NbFaultyVertices(); }
TopoDS_Vertex LawFillet::FaultyVertex(int k) const { return builder_.FaultyVertex(k); }
bool LawFillet::HasResult() const { return builder_.HasResult(); }

}  // namespace llull
