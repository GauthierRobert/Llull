#!/usr/bin/env bash
# Build the three bike documents, measure their aerodynamics, then organise + animate them (physics carries the road load).
set -euo pipefail
cd "$(dirname "$0")"
LLULL="node ../../server/bin/llull.cjs"
VARIANTS="baseline aero aero_fit"
for v in $VARIANTS; do
  python3 bike.py "$v" > "$v.plan.json"
  rm -f "$v.llull.json"
  $LLULL run "$v.plan.json" --validate --doc "$v.llull.json" > /dev/null
  $LLULL run "$v.plan.json" --doc "$v.llull.json" --json > "$v.run.json"
done
python3 aero.py
for v in $VARIANTS; do
  python3 organize.py "$v" > "$v.organize.json"
  $LLULL run "$v.organize.json" --doc "$v.llull.json" --no-fit --json > "$v.organize.run.json"
  $LLULL fit_view direction=front --doc "$v.llull.json" > /dev/null
done
