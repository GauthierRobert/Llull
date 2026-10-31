// A fillet maker whose radius laws can be exact straight pieces (BLD 13.15). BRepFilletAPI_MakeFillet gives every evolving radius a cubic
// Law_Interpol with zero slope at both ends (ChFiDS_FilSpine::ComputeLaw -> mklaw), and its Add(Law_Function) discards the law it is given
// (ChFiDS_FilSpine::SetRadius(Law_Function) builds a Law_Composite and drops it). LawFillet runs the same ChFi3d_FilBuilder over a spine
// (LawSpine) that replaces the spline of a straight law by Law_Linear pieces as soon as the spine has computed its laws, so the radius is
// the polyline through the given nodes, not an approximation of it. The method names and results are those of BRepFilletAPI_MakeFillet.
#pragma once

#include <map>
#include <vector>

#include <BRepBuilderAPI_MakeShape.hxx>
#include <ChFi3d_FilBuilder.hxx>
#include <ChFiDS_ErrorStatus.hxx>
#include <ChFiDS_FilSpine.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopTools_MapOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Pnt2d.hxx>

namespace llull {

// How the radius runs between the nodes of the law of an edge: the cubic spline of OCCT, exact straight pieces, or the monotone C1 cubic (no overshoot).
enum class LawKind : int { Smooth = 0, Straight = 1, Monotone = 2 };

// A fillet spine remembering which law kind each of its edges carries.
class LawSpine : public ChFiDS_FilSpine {
 public:
  explicit LawSpine(double tolerance) : ChFiDS_FilSpine(tolerance) {}

  // Radius `radius` at the relative position `relative` (0 = start, 1 = end) of the contour edge `edge_in_contour` (1-based).
  void add_node(double relative, double radius, int edge_in_contour, LawKind kind);

  void AppendElSpine(const Handle(ChFiDS_ElSpine) & elspine) override;

  DEFINE_STANDARD_RTTI_INLINE(LawSpine, ChFiDS_FilSpine)

 private:
  std::map<int, LawKind> kind_;
};

// ChFi3d_FilBuilder::Add(E) with a LawSpine as the spine of the new contour.
class LawBuilder : public ChFi3d_FilBuilder {
 public:
  explicit LawBuilder(const TopoDS_Shape &shape) : ChFi3d_FilBuilder(shape, ChFi3d_Rational) {}

  void add_edge(const TopoDS_Edge &edge);
};

class LawFillet : public BRepBuilderAPI_MakeShape {
 public:
  explicit LawFillet(const TopoDS_Shape &shape);

  // The law of `edge`, which starts a contour (or joins the one it is in): false when OCCT does not take the edge (a seam, a degenerate one).
  bool constant(const TopoDS_Edge &edge, double radius);
  bool range(const TopoDS_Edge &edge, double start, double end);
  // (relative position, radius) nodes from 0 to 1: a cubic spline through them (OCCT's own), straight pieces between them, or the monotone cubic.
  bool nodes(const TopoDS_Edge &edge, const std::vector<gp_Pnt2d> &nodes, LawKind kind);

  void Build(const Message_ProgressRange &range = Message_ProgressRange()) override;
  const TopTools_ListOfShape &Generated(const TopoDS_Shape &shape) override;
  const TopTools_ListOfShape &Modified(const TopoDS_Shape &shape) override;
  bool IsDeleted(const TopoDS_Shape &shape) override;

  int NbContours() const;
  int Contour(const TopoDS_Edge &edge) const;
  int NbEdges(int contour) const;
  const TopoDS_Edge &Edge(int contour, int k) const;
  ChFiDS_ErrorStatus StripeStatus(int contour) const;
  int NbFaultyVertices() const;
  TopoDS_Vertex FaultyVertex(int k) const;
  bool HasResult() const;

 private:
  struct Slot {
    Handle(LawSpine) spine;
    int index = 0;
  };
  Slot slot(const TopoDS_Edge &edge);

  LawBuilder builder_;
  TopTools_MapOfShape faces_;
};

}  // namespace llull
