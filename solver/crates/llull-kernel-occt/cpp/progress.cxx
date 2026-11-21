// Deadline / cancel state of the running request and the progress indicator that polls it: see progress.hxx.
#include "llull-kernel-occt/cpp/progress.hxx"

#include <chrono>
#include <sstream>
#include <stdexcept>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

namespace {

// The deadline belongs to the request thread (tests run requests on several threads); OpProgress copies it, because OCCT polls from its own workers.
thread_local int64_t deadline_ns = 0;
std::atomic<bool> cancelled{false};

int64_t now_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

}  // namespace

OpProgress::OpProgress() : limit_(deadline_ns) {}

void set_deadline_ms(double milliseconds) {
  cancelled.store(false);
  deadline_ns = milliseconds > 0.0 ? now_ns() + static_cast<int64_t>(milliseconds * 1e6) : 0;
}

void clear_deadline() {
  deadline_ns = 0;
  cancelled.store(false);
}

void request_cancel() { cancelled.store(true); }

bool OpProgress::broke() const { return broke_.load(); }

Standard_Boolean OpProgress::UserBreak() {
  if (!cancelled.load() && (limit_ == 0 || now_ns() < limit_)) return Standard_False;
  broke_.store(true);
  return Standard_True;
}

void OpProgress::Show(const Message_ProgressScope &scope, const Standard_Boolean) {
  std::lock_guard<std::mutex> guard(lock_);
  if (scope.Name() != nullptr) stage_ = scope.Name();
  fraction_ = GetPosition();
}

std::string OpProgress::stage() {
  std::lock_guard<std::mutex> guard(lock_);
  return stage_;
}

double OpProgress::fraction() {
  std::lock_guard<std::mutex> guard(lock_);
  return fraction_;
}

void throw_timeout(OpProgress &progress) {
  std::ostringstream text;
  const std::string stage = progress.stage();
  text << "KRN_TIMEOUT stage=" << (stage.empty() ? "boolean" : stage) << " fraction=" << progress.fraction();
  throw std::runtime_error(text.str());
}

}  // namespace llull
