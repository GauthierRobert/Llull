// Netgen and OCCT print progress on std::cout; llull-mesh's stdout carries its response line. While a Quiet lives, std::cout
// discards everything (std::cerr is kept: it is the host's diagnostic tail when the mesher dies).
#pragma once

#include <iostream>
#include <streambuf>

namespace llull_netgen {

class Quiet {
 public:
  Quiet() : saved_(std::cout.rdbuf(&discard_)) {}
  ~Quiet() { std::cout.rdbuf(saved_); }
  Quiet(const Quiet &) = delete;
  Quiet &operator=(const Quiet &) = delete;

 private:
  class Discard : public std::streambuf {
   protected:
    int_type overflow(int_type c) override { return traits_type::not_eof(c); }
    std::streamsize xsputn(const char *, std::streamsize n) override { return n; }
  };
  Discard discard_;
  std::streambuf *saved_;
};

}  // namespace llull_netgen
