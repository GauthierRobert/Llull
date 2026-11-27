// Multi-tool boolean (ASC TR-ASC-03, TECHNICAL_SPEC 5.1): ONE General Fuse / Cut of `a` with every tool, no pre-union.
// Options: parallel, oriented bounding boxes, the inverted-solid check ON (OCCT's default: BRepCheck_Analyzer does not detect an inside-out solid, so it cannot gate it off), non-destructive
// (the cached input shapes stay valid); the history stays on because persistent face names are carried through it (naming.hxx).
// A result that is null, errored or invalid answers null with `ToolList::note` set: the host then runs the balanced-tree recipe.
// A deadline / cancel (progress.hxx) raises KRN_TIMEOUT instead.
#include <atomic>
#include <stdexcept>

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopTools_ListOfShape.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/progress.hxx"

namespace llull {

std::unique_ptr<ToolList> new_tool_list() { return std::make_unique<ToolList>(); }

void tool_list_push(ToolList &list, const Shape &shape) { list.items.push_back(&shape); }

rust::String tool_list_note(const ToolList &list) { return rust::String(list.note); }

namespace {

std::atomic<bool> many_fault{false};

template <class Builder>
std::unique_ptr<Shape> run_many(const Shape &a, const ToolList &tools, bool unify) {
  TopTools_ListOfShape arguments, toolShapes;
  arguments.Append(a.shape);
  bool refined = a.refined_mass;
  std::vector<naming::Named> inputs{naming::named(a)};
  for (const Shape *tool : tools.items) {
    toolShapes.Append(tool->shape);
    refined = refined || tool->refined_mass;
    inputs.push_back(naming::named(*tool));
  }
  Builder builder;
  builder.SetArguments(arguments);
  builder.SetTools(toolShapes);
  builder.SetRunParallel(Standard_True);
  builder.SetUseOBB(Standard_True);
  builder.SetCheckInverted(Standard_True);
  builder.SetNonDestructive(Standard_True);
  builder.SetToFillHistory(Standard_True);
  Handle(OpProgress) progress = new OpProgress;
  builder.Build(progress->Start());
  if (progress->broke()) throw_timeout(*progress);
  if (!builder.IsDone() || builder.HasErrors()) {
    tools.note = "the General Fuse reported errors";
    return nullptr;
  }
  const TopoDS_Shape result = builder.Shape();
  if (many_fault.load() || result.IsNull() || !BRepCheck_Analyzer(result).IsValid()) {
    tools.note = "the General Fuse result is not valid";
    return nullptr;
  }
  std::vector<std::string> names = naming::inherit(result, inputs, builder.History(), "boolean");
  std::unique_ptr<Shape> made;
  if (unify) {
    try {
      // on a copy with its own geometry, as boolean_op (facade.cxx): the merge must not edit edges shared with the operands
      BRepBuilderAPI_Copy copy(result, Standard_True, Standard_False);
      const TopoDS_Shape isolated = copy.Shape();
      const std::vector<naming::Named> original{naming::Named{result, names}};
      const std::vector<naming::Named> split{
          naming::Named{isolated, naming::inherit(isolated, original, naming::history_of(original, copy), "copy")}};
      ShapeUpgrade_UnifySameDomain unifier(isolated, Standard_True, Standard_True, Standard_False);
      unifier.AllowInternalEdges(Standard_False);
      unifier.Build();
      if (unifier.Shape().IsNull() || !BRepCheck_Analyzer(unifier.Shape(), Standard_True).IsValid()) throw Standard_Failure("unify: invalid result");
      made = naming::wrap_named(unifier.Shape(), naming::inherit(unifier.Shape(), split, unifier.History(), "unify"));
    } catch (const Standard_Failure &) {
      made = nullptr;
    }
  }
  if (!made) made = naming::wrap_named(result, std::move(names));
  if (made) made->refined_mass = refined;
  return made;
}

}  // namespace

void set_many_fault(bool on) { many_fault.store(on); }

std::unique_ptr<Shape> boolean_many(const Shape &a, const ToolList &tools, int32_t operation, bool unify) {
  tools.note.clear();
  if (tools.items.empty()) throw std::invalid_argument("boolean_many: no tools");
  if (operation == 0) return run_many<BRepAlgoAPI_Fuse>(a, tools, unify);
  if (operation == 1) return run_many<BRepAlgoAPI_Cut>(a, tools, unify);
  throw std::invalid_argument("boolean_many: only union and subtract take several tools");
}

}  // namespace llull
