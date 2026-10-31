// LawFillet: BRepFilletAPI_MakeFillet over a spine whose straight laws are exact (see law_fillet.hxx).
#include "llull-kernel-occt/cpp/law_fillet.hxx"

#include <algorithm>
#include <cmath>
#include <functional>

#include <BRepAdaptor_Curve.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <ChFiDS_Stripe.hxx>
#include <Law_BSpline.hxx>
#include <Law_BSpFunc.hxx>
#include <Law_Composite.hxx>
#include <Law_Interpol.hxx>
#include <Law_Laws.hxx>
#include <Law_Linear.hxx>
#include <Precision.hxx>
#include <Standard_Failure.hxx>
#include <atomic>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TColStd_Array1OfInteger.hxx>
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

// Slopes of the monotone C1 law (Fritsch-Carlson / PCHIP) at knots[first..last]: zero at both ends and at a local extremum, else the weighted harmonic
// mean of the neighbouring secants. The same formula as packages/core/src/geometry/blend/monotone.ts (pinned by tests/unit/blendMonotone.test.ts).
std::vector<double> monotone_slopes(const std::vector<Knot> &knots, size_t first, size_t last) {
  std::vector<double> slopes(last - first + 1, 0.0);
  for (size_t k = first + 1; k < last; ++k) {
    const double before_width = knots[k].position - knots[k - 1].position;
    const double after_width = knots[k + 1].position - knots[k].position;
    const double before = (knots[k].radius - knots[k - 1].radius) / before_width;
    const double after = (knots[k + 1].radius - knots[k].radius) / after_width;
    if (before * after <= 0.0) continue;
    const double w1 = 2.0 * after_width + before_width;
    const double w2 = after_width + 2.0 * before_width;
    slopes[k - first] = (w1 + w2) / (w1 / before + w2 / after);
  }
  return slopes;
}

// One cubic Hermite piece between two knots as a Bezier-form Law_BSpline (poles r0, r0 + m0 h / 3, r1 - m1 h / 3, r1): exact value, slope and curvature.
Handle(Law_BSpFunc) hermite_piece(const Knot &from, double from_slope, const Knot &to, double to_slope) {
  const double width = to.position - from.position;
  TColStd_Array1OfReal poles(1, 4);
  poles(1) = from.radius;
  poles(2) = from.radius + from_slope * width / 3.0;
  poles(3) = to.radius - to_slope * width / 3.0;
  poles(4) = to.radius;
  TColStd_Array1OfReal knots(1, 2);
  knots(1) = from.position;
  knots(2) = to.position;
  TColStd_Array1OfInteger multiplicities(1, 2);
  multiplicities(1) = 4;
  multiplicities(2) = 4;
  Handle(Law_BSpline) curve = new Law_BSpline(poles, knots, multiplicities, 3);
  return new Law_BSpFunc(curve, from.position, to.position);
}

// OCCT reads the relative position of a node of an edge as a fraction of the edge's PARAMETER range (measured: native test nativeBlendChainEdges), which is
// not the fraction of its length where the curve does not run at a steady speed (an ellipse, a B-spline). A law is given along the edge's ARC length, so a node at
// the arc fraction `arc` is placed at the parameter fraction of that point. Not placing it is a failure (never the arc fraction in its place: that is the old error).
std::atomic<int> g_inversion_fault_after{-1};  // test hook: set_law_inversion_fault (-1: off; n >= 0: every inversion after the first n fails)
std::atomic<int> g_inversions{0};
std::atomic<size_t> g_node_cap{0};  // test hook: set_law_node_cap (0: MAX_STRETCH_NODES)

double parameter_fraction(const BRepAdaptor_Curve &curve, double length, double arc) {
  if (arc <= 0.0) return 0.0;
  if (arc >= 1.0) return 1.0;
  const double first = curve.FirstParameter(), last = curve.LastParameter();
  const int fault_after = g_inversion_fault_after.load();
  const bool faulted = fault_after >= 0 && g_inversions.fetch_add(1) >= fault_after;
  if (faulted || !(last > first)) throw LawNodeFailure("law node not placed: the arc length abscissa of the edge could not be inverted");
  const GCPnts_AbscissaPoint point(curve, arc * length, first);
  if (!point.IsDone()) throw LawNodeFailure("law node not placed: the arc length abscissa of the edge could not be inverted");
  return std::min(1.0, std::max(0.0, (point.Parameter() - first) / (last - first)));
}

// A stretch between two nodes on an edge of uneven speed starts as this many pieces, each halved (down to MAX_HALVINGS times, at most MAX_STRETCH_NODES nodes in
// the stretch) until the law in the PARAMETER differs from the law in the ARC length by less than RADIUS_GAP of the largest radius at the middle and the two quarter
// points of the piece: a law that is straight (or a cubic) in the arc length is not so in the parameter, so its nodes are laid on the arc-length curve of the law
// (the gap of a piece grows with the square of its width and the curvature of the map: about 7e-6 of the radius at 1/256 of a stretch on a 2:1 ellipse, so RADIUS_GAP is the aim, not a
// bound the limits can always meet). A piece still above RADIUS_GAP at either limit is accepted only below RADIUS_REFUSAL of the largest radius (the tolerance check_blends
// holds a blend to, RADIUS_LAW_TOLERANCE); above it the law is refused with the gap, never built with a silent miss.
constexpr int BASE_PIECES = 4;
constexpr int MAX_HALVINGS = 6;
constexpr size_t MAX_STRETCH_NODES = 128;
constexpr double RADIUS_GAP = 1e-5;
constexpr double RADIUS_REFUSAL = 1e-4;

// Whether the parameter fraction of the edge differs from its arc fraction: probed at fractions off the symmetric ones (a closed ellipse is at its arc fraction at 1/4, 1/2 and 3/4).
bool uneven_curve(const BRepAdaptor_Curve &curve, double length) {
  double unevenness = 0.0;
  for (const double arc : {0.1, 0.3, 0.45, 0.7, 0.9}) unevenness = std::max(unevenness, std::abs(parameter_fraction(curve, length, arc) - arc));
  return unevenness >= kUnevenSpeed;
}

// The cubic Hermite value at `x` between two knots with the given end slopes.
double hermite_value(const Knot &from, double from_slope, const Knot &to, double to_slope, double x) {
  const double width = to.position - from.position;
  const double u = (x - from.position) / width, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * from.radius + (u3 - 2 * u2 + u) * width * from_slope + (-2 * u3 + 3 * u2) * to.radius + (u3 - u2) * width * to_slope;
}

// The radius of the law of `kind` through `nodes` (arc fraction, radius) at the arc fraction x: the polyline, the monotone cubic, or the cubic spline of OCCT
// (zero slope at both ends; two nodes alone are its Hermite cubic).
std::function<double(double)> arc_law(const std::vector<gp_Pnt2d> &nodes, LawKind kind) {
  std::vector<Knot> knots;
  for (const gp_Pnt2d &node : nodes) knots.push_back({node.X(), node.Y()});
  const auto stretch_of = [knots](double x) {
    size_t k = 0;
    while (k + 2 < knots.size() && x > knots[k + 1].position) ++k;
    return k;
  };
  if (kind == LawKind::Straight)
    return [knots, stretch_of](double x) {
      const size_t k = stretch_of(x);
      const double u = (x - knots[k].position) / (knots[k + 1].position - knots[k].position);
      return knots[k].radius + u * (knots[k + 1].radius - knots[k].radius);
    };
  if (kind == LawKind::Monotone || knots.size() == 2) {
    const std::vector<double> slopes = kind == LawKind::Monotone ? monotone_slopes(knots, 0, knots.size() - 1) : std::vector<double>(2, 0.0);
    return [knots, slopes, stretch_of](double x) {
      const size_t k = stretch_of(x);
      return hermite_value(knots[k], slopes[k], knots[k + 1], slopes[k + 1], x);
    };
  }
  TColgp_Array1OfPnt2d points(1, static_cast<int>(nodes.size()));
  for (size_t k = 0; k < nodes.size(); ++k) points(static_cast<int>(k) + 1) = nodes[k];
  Handle(Law_Interpol) spline = new Law_Interpol();
  spline->Set(points, 0.0, 0.0, Standard_False);
  return [spline](double x) { return spline->Value(x); };
}

// The nodes (arc fraction, radius) of a law along `edge` as the nodes OCCT reads (parameter fraction, radius). `uneven` is false (and the nodes come back as
// given) where the parameter fraction is the arc fraction; else every stretch is cut into pieces (BASE_PIECES, refined) whose nodes lie on the law of `kind` in the arc length,
// so the radius follows the law between the given nodes too, not only at them.
std::vector<gp_Pnt2d> parameter_nodes(const TopoDS_Edge &edge, const std::vector<gp_Pnt2d> &nodes, LawKind kind, bool &uneven) {
  uneven = false;
  const BRepAdaptor_Curve curve(edge);
  const double length = GCPnts_AbscissaPoint::Length(curve, curve.FirstParameter(), curve.LastParameter());
  if (!(length > Precision::Confusion())) return nodes;
  if (!uneven_curve(curve, length)) return nodes;
  uneven = true;
  const std::function<double(double)> law = arc_law(nodes, kind);
  double scale = 0.0;
  for (const gp_Pnt2d &node : nodes) scale = std::max(scale, std::abs(node.Y()));
  const double tolerance = RADIUS_GAP * scale;
  std::vector<gp_Pnt2d> out;
  // A piece [x0, x1] of the arc fraction (parameter fractions p0, p1 at its ends): `gap` is the largest miss, at the middle and the two quarter points, of the chord of the
  // law in the parameter against the law in the arc length (negative until measured).
  struct Piece {
    double x0, p0, x1, p1, xm, pm, ym, gap;
  };
  const auto measure = [&](Piece &piece) {
    piece.xm = 0.5 * (piece.x0 + piece.x1);
    piece.pm = parameter_fraction(curve, length, piece.xm);
    piece.ym = law(piece.xm);
    piece.gap = 0.0;
    if (!(piece.p1 > piece.p0)) return;
    const double y0 = law(piece.x0), y1 = law(piece.x1);
    const auto gap_at = [&](double p, double y) { return std::abs(y0 + (y1 - y0) * (p - piece.p0) / (piece.p1 - piece.p0) - y); };
    piece.gap = gap_at(piece.pm, piece.ym);
    for (const double share : {0.25, 0.75}) {
      const double xq = piece.x0 + share * (piece.x1 - piece.x0);
      piece.gap = std::max(piece.gap, gap_at(parameter_fraction(curve, length, xq), law(xq)));
    }
  };
  // The nodes strictly inside the stretch from `from` to `to`: every piece above RADIUS_GAP is halved, level by level (so the nodes spread over the stretch), until none is,
  // MAX_HALVINGS levels were cut, or the next level would pass MAX_STRETCH_NODES nodes; a piece still above RADIUS_REFUSAL then is the refusal.
  const auto place_stretch = [&](const gp_Pnt2d &from, const gp_Pnt2d &to) {
    std::vector<Piece> pieces;
    double x0 = from.X(), p0 = parameter_fraction(curve, length, x0);
    for (int piece = 1; piece <= BASE_PIECES; ++piece) {
      const double x1 = piece == BASE_PIECES ? to.X() : from.X() + (static_cast<double>(piece) / BASE_PIECES) * (to.X() - from.X());
      const double p1 = parameter_fraction(curve, length, x1);
      pieces.push_back({x0, p0, x1, p1, 0.0, 0.0, 0.0, -1.0});
      x0 = x1;
      p0 = p1;
    }
    for (int level = 0;; ++level) {
      for (Piece &piece : pieces)
        if (piece.gap < 0.0) measure(piece);
      const size_t cap = g_node_cap.load() > 0 ? g_node_cap.load() : MAX_STRETCH_NODES;
      const size_t failing = static_cast<size_t>(std::count_if(pieces.begin(), pieces.end(), [&](const Piece &piece) { return piece.gap > tolerance; }));
      if (failing == 0 || level >= MAX_HALVINGS || pieces.size() - 1 + failing > cap) break;
      std::vector<Piece> halved;
      for (const Piece &piece : pieces) {
        if (piece.gap <= tolerance) {
          halved.push_back(piece);
          continue;
        }
        halved.push_back({piece.x0, piece.p0, piece.xm, piece.pm, 0.0, 0.0, 0.0, -1.0});
        halved.push_back({piece.xm, piece.pm, piece.x1, piece.p1, 0.0, 0.0, 0.0, -1.0});
      }
      pieces = std::move(halved);
    }
    for (const Piece &piece : pieces)
      if (piece.gap > RADIUS_REFUSAL * scale)
        throw LawNodeFailure("law nodes not placed: the radius law in the arc length of the edge is still " + std::to_string(piece.gap) + " off its placement in the edge parameter at " +
                             std::to_string(piece.xm) + " of the edge after " + std::to_string(pieces.size() - 1) + " nodes in one stretch (limit " + std::to_string(g_node_cap.load() > 0 ? g_node_cap.load() : MAX_STRETCH_NODES) + ", " +
                             std::to_string(MAX_HALVINGS) + " halvings); give the edge a law with fewer or gentler nodes");
    for (size_t k = 0; k + 1 < pieces.size(); ++k) out.emplace_back(pieces[k].p1, law(pieces[k].x1));
  };
  for (size_t k = 0; k < nodes.size(); ++k) {
    if (k > 0) place_stretch(nodes[k - 1], nodes[k]);
    out.emplace_back(parameter_fraction(curve, length, nodes[k].X()), nodes[k].Y());
  }
  return out;
}

}  // namespace

bool uneven_speed(const TopoDS_Edge &edge) {
  if (BRep_Tool::Degenerated(edge)) return false;
  try {
    const BRepAdaptor_Curve curve(edge);
    const double length = GCPnts_AbscissaPoint::Length(curve, curve.FirstParameter(), curve.LastParameter());
    return length > Precision::Confusion() && uneven_curve(curve, length);
  } catch (const Standard_Failure &) {
    return false;  // an edge whose arc length cannot be inverted is OCCT's own: Add(r1, r2, e) as before this module existed
  } catch (const LawNodeFailure &) {
    return false;
  }
}

void set_law_node_cap(int32_t nodes) { g_node_cap.store(nodes > 0 ? static_cast<size_t>(nodes) : 0); }

void set_law_inversion_fault(int32_t after) {
  g_inversions.store(0);
  g_inversion_fault_after.store(after);
}

void LawSpine::add_node(double relative, double radius, int edge_in_contour, LawKind kind) {
  SetRadius(gp_XY(relative, radius), edge_in_contour);
  kind_[edge_in_contour] = kind;
}

// After the spine has computed the law of an elementary spine (one Law_Composite of constants and splines), every stretch of a spline that lies on
// an edge carrying a straight law becomes Law_Linear pieces through the knots of that very interpolation (the nodes OCCT kept), and every stretch on an
// edge carrying the monotone law becomes cubic Hermite pieces through the same knots (slopes: monotone_slopes, zero at the ends of the run). Every other
// stretch (a smooth edge, or an edge pulled into the contour by tangency with no law of its own) stays exactly the spline of OCCT, trimmed to the stretch:
// the radius is continuous at a junction, the slope jumps there.
void LawSpine::AppendElSpine(const Handle(ChFiDS_ElSpine) & elspine) {
  ChFiDS_FilSpine::AppendElSpine(elspine);
  const bool any_exact = std::any_of(kind_.begin(), kind_.end(), [](const auto &entry) { return entry.second != LawKind::Smooth; });
  if (!any_exact) return;
  const Handle(Law_Composite) composite = Law(elspine);
  if (composite.IsNull()) return;
  const auto kind_of = [&](double from, double to) {
    const auto found = kind_.find(Index(0.5 * (from + to)));
    return found == kind_.end() ? LawKind::Smooth : found->second;
  };
  Law_Laws rebuilt;
  bool changed = false;
  for (Law_Laws::Iterator it(composite->ChangeLaws()); it.More(); it.Next()) {
    const Handle(Law_Interpol) spline = Handle(Law_Interpol)::DownCast(it.Value());
    const std::vector<Knot> knots = spline.IsNull() ? std::vector<Knot>() : knots_of(spline);
    bool exact_here = false;
    for (size_t k = 0; k + 1 < knots.size(); ++k) exact_here = exact_here || kind_of(knots[k].position, knots[k + 1].position) != LawKind::Smooth;
    if (!exact_here) {
      rebuilt.Append(it.Value());
      continue;
    }
    changed = true;
    size_t run = 0;
    while (run + 1 < knots.size()) {
      const LawKind kind = kind_of(knots[run].position, knots[run + 1].position);
      size_t end = run + 1;
      // a run stays on one edge: the law of each edge is its own curve (zero slope at its ends), also where the edges chain tangentially into one spline
      const int edge = Index(0.5 * (knots[run].position + knots[run + 1].position));
      while (end + 1 < knots.size() && kind_of(knots[end].position, knots[end + 1].position) == kind &&
             Index(0.5 * (knots[end].position + knots[end + 1].position)) == edge)
        ++end;
      if (kind == LawKind::Straight) {
        for (size_t k = run; k < end; ++k) {
          Handle(Law_Linear) piece = new Law_Linear();
          piece->Set(knots[k].position, knots[k].radius, knots[k + 1].position, knots[k + 1].radius);
          rebuilt.Append(piece);
        }
      } else if (kind == LawKind::Monotone) {
        const std::vector<double> slopes = monotone_slopes(knots, run, end);
        for (size_t k = run; k < end; ++k) rebuilt.Append(hermite_piece(knots[k], slopes[k - run], knots[k + 1], slopes[k + 1 - run]));
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

// Whether the spine walks `edge` (the edge `index` of its contour) from its end to its start. An open edge: the point of the walk at the start of the edge's
// stretch is the edge's own end. A closed edge (own start = own end, a circle, a periodic spline) ties on the endpoints, so its direction is the walk's tangent
// against the edge's own tangent at its start. No contour mixes a closed edge with others (its vertex would carry three edge ends, a branch OCCT does not chain
// through), so this is the contour of that one edge, which the spine walks in the edge's own direction: pinned by the native asymmetric circle law test.
static bool walked_backwards(const Handle(LawSpine) & spine, int index, const TopoDS_Edge &edge) {
  if (spine.IsNull()) return false;
  const double from = spine->FirstParameter(index);
  const gp_Pnt walked_start = spine->Value(from), walked_end = spine->Value(spine->LastParameter(index));
  const BRepAdaptor_Curve curve(edge);
  gp_Pnt own_start, own_end;
  gp_Vec own_tangent;
  curve.D1(curve.FirstParameter(), own_start, own_tangent);
  own_end = curve.Value(curve.LastParameter());
  if (own_start.Distance(own_end) <= Precision::Confusion()) {
    gp_Pnt at;
    gp_Vec walked_tangent;
    spine->D1(from, at, walked_tangent);
    if (walked_tangent.Magnitude() > Precision::Confusion() && own_tangent.Magnitude() > Precision::Confusion()) return walked_tangent.Dot(own_tangent) < 0.0;
  }
  return walked_start.Distance(own_end) + walked_end.Distance(own_start) + 1e-9 < walked_start.Distance(own_start) + walked_end.Distance(own_end);
}

LawFillet::Slot LawFillet::slot(const TopoDS_Edge &edge) {
  builder_.add_edge(edge);
  Slot found;
  const int contour = builder_.Contains(edge, found.index);
  if (contour != 0) {
    found.spine = Handle(LawSpine)::DownCast(builder_.Value(contour));
    found.reversed = walked_backwards(found.spine, found.index, edge);
  }
  return found;
}

bool LawFillet::constant(const TopoDS_Edge &edge, double radius) {
  const Slot target = slot(edge);
  if (target.spine.IsNull()) return false;
  target.spine->add_node(0., radius, target.index, LawKind::Smooth);
  target.spine->add_node(1., radius, target.index, LawKind::Smooth);
  return true;
}

bool LawFillet::range(const TopoDS_Edge &edge, double start, double end) {
  // a difference below the confusion is the same radius, as BRepFilletAPI_MakeFillet reads it
  if (std::abs(start - end) < Precision::Confusion()) return constant(edge, 0.5 * (start + end));
  return nodes(edge, {gp_Pnt2d(0., start), gp_Pnt2d(1., end)}, LawKind::Smooth);
}

bool LawFillet::nodes(const TopoDS_Edge &edge, const std::vector<gp_Pnt2d> &nodes, LawKind kind) {
  if (nodes.size() == 1) return constant(edge, nodes.front().Y());
  const Slot target = slot(edge);
  if (target.spine.IsNull()) return false;
  bool uneven = false;
  const std::vector<gp_Pnt2d> placed = parameter_nodes(edge, nodes, kind, uneven);
  // a start and an end alone on an even edge: OCCT's own transition (its cubic differs from the monotone one by about 8e-5 of the volume: native test)
  if (!uneven && nodes.size() == 2 && kind == LawKind::Smooth) {
    target.spine->add_node(0., target.reversed ? nodes.back().Y() : nodes.front().Y(), target.index, LawKind::Smooth);
    target.spine->add_node(1., target.reversed ? nodes.front().Y() : nodes.back().Y(), target.index, LawKind::Smooth);
    return true;
  }
  if (target.reversed)
    for (auto it = placed.rbegin(); it != placed.rend(); ++it) target.spine->add_node(1. - it->X(), it->Y(), target.index, kind);
  else
    for (const gp_Pnt2d &node : placed) target.spine->add_node(node.X(), node.Y(), target.index, kind);
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
