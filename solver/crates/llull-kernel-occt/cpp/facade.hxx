// Narrow C++ facade over OCCT for the llull native kernel (RS-1). Rust sees only these coarse operations, never OCCT classes.
// Every function either returns a shape (null = OCC refused the input) or throws; the trycatch below turns any throw, including
// OCCT's Standard_Failure (not a std::exception), into a Rust Err instead of std::terminate.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include <STEPControl_Writer.hxx>
#include <Standard_Failure.hxx>
#include <TopoDS_Shape.hxx>

#include "rust/cxx.h"

namespace rust {
namespace behavior {
template <typename Try, typename Fail>
static void trycatch(Try &&func, Fail &&fail) noexcept try {
  func();
} catch (const Standard_Failure &error) {
  std::string message = std::string(error.DynamicType()->Name()) + ": " +
                        (error.GetMessageString() != nullptr ? error.GetMessageString() : "");
  fail(message.c_str());
} catch (const std::exception &error) {
  fail(error.what());
} catch (...) {
  fail("unknown C++ exception");
}
}  // namespace behavior
}  // namespace rust

namespace llull {

struct MeshOut;
struct MassOut;
struct AnalysisOut;

class Shape {
 public:
  explicit Shape(TopoDS_Shape shape) : shape(std::move(shape)) {}
  TopoDS_Shape shape;
  // Persistent face names (SC-N1, naming.hxx), aligned with the distinct faces of `shape`; empty = unnamed.
  std::vector<std::string> names;
};

class StepWriter {
 public:
  STEPControl_Writer writer;
};

void init_runtime();
rust::String occt_version();

std::unique_ptr<Shape> make_box(rust::Slice<const double> origin, rust::Slice<const double> size);
std::unique_ptr<Shape> make_cylinder(double radius, double height);
std::unique_ptr<Shape> make_sphere(double radius);
std::unique_ptr<Shape> make_cone(double base_radius, double top_radius, double height);
std::unique_ptr<Shape> make_torus(double ring_radius, double tube_radius);
std::unique_ptr<Shape> make_prism(rust::Slice<const double> polygon, rust::Slice<const double> direction);
std::unique_ptr<Shape> make_revolution(rust::Slice<const double> polygon, rust::Slice<const double> axis, double angle);
std::unique_ptr<Shape> make_sewn_solid(rust::Slice<const double> positions, rust::Slice<const uint32_t> indices);

std::unique_ptr<Shape> placed(const Shape &shape, rust::Slice<const double> rotation, rust::Slice<const double> position,
                              rust::Slice<const double> anchor_shift);
std::unique_ptr<Shape> scaled(const Shape &shape, double factor);
std::unique_ptr<Shape> boolean_op(const Shape &a, const Shape &b, int32_t operation, bool unify);
// The same shape with every face name prefixed "<prefix>:" (a leaf entity id).
std::unique_ptr<Shape> prefixed(const Shape &shape, rust::Str prefix);

MeshOut tessellate(const Shape &shape, double linear_deflection, double angular_deflection);
MassOut mass_properties(const Shape &shape);
AnalysisOut analyze(const Shape &shape);

std::unique_ptr<StepWriter> new_step_writer();
bool step_add(StepWriter &writer, const Shape &shape);
rust::String step_finish(StepWriter &writer);

}  // namespace llull
