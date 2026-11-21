// Deadline and cancel for native operations (ASC TR-ASC-04). The session sets one deadline per request (`set_deadline_ms`) and a reader
// thread may cancel one request by its id (`request_cancel(id)`; an id that is not the running request does nothing); an `OpProgress` handed to an OCCT algorithm (`Build(progress.Start())`) answers
// UserBreak() true once either holds, so the algorithm stops at its next stage poll. `throw_timeout` then raises `KRN_TIMEOUT stage=<s>
// fraction=<f>`, which the Rust side maps to the stable error code. The process stays alive.
#pragma once

#include <atomic>
#include <mutex>
#include <string>

#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressScope.hxx>

namespace llull {

class OpProgress : public Message_ProgressIndicator {
 public:
  OpProgress();
  bool broke() const;
  std::string stage();
  double fraction();

 protected:
  Standard_Boolean UserBreak() override;
  void Show(const Message_ProgressScope &scope, const Standard_Boolean force) override;

 private:
  std::mutex lock_;
  std::string stage_;
  double fraction_ = 0.0;
  int64_t limit_;
  int64_t id_;
  std::atomic<bool> broke_{false};
};

// Throws std::runtime_error("KRN_TIMEOUT stage=... fraction=...") from the state of `progress`.
[[noreturn]] void throw_timeout(OpProgress &progress);

}  // namespace llull
