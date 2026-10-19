#!/usr/bin/env bash
# Build the Cervélo S5: plan -> aero measurements (un-welded parts) -> welded build on an OCC llull server -> organise
# (materials, decals, layers, animation, physics) -> s5.llull.json + renders + glTF.
#
# Needs a llull server running the exact kernel with a long OCC timeout (welds can take minutes):
#   LLULL_KERNEL=occt LLULL_OCC_TIMEOUT_MS=900000 PORT=3101 npm --prefix ../../server run dev
set -euo pipefail
cd "$(dirname "$0")"
V="${1:-s5}"  # s5 (stock) or s5x (optimised "S5 Aero+")
SERVER="${LLULL_OCC_SERVER:-http://127.0.0.1:3101}"
LOCAL="node ../../server/bin/llull.cjs"
REMOTE="$LOCAL --server $SERVER --timeout 900"

python3 s5.py "$V"
rm -f "$V.pass1.llull.json"
$LOCAL run "$V.plan.json" --validate --doc "$V.pass1.llull.json" > /dev/null
$LOCAL run "$V.plan.json" --doc "$V.pass1.llull.json" --json > "$V.pass1.run.json"
python3 aero.py "$V.pass1.llull.json" "$V.pass1.run.json"

$REMOTE clear_document > /dev/null
$REMOTE run "$V.plan.json" --no-fit --json > "$V.run.json"
python3 weld.py "$SERVER" "$V.run.json" "$V.parts.json"
python3 organize.py "$V"
$REMOTE run "$V.organize.json" --no-fit --json > "$V.organize.run.json"
$REMOTE fit_view direction=front > /dev/null
curl -sf "$SERVER/live/snapshot" | python3 -c "import json,sys; d=json.load(sys.stdin)['document']; json.dump({'format':'llull-document','version':3,'document':d}, open('$V.llull.json','w'))"
rm -f "$V.pass1.llull.json" "$V.pass1.llull.json".bak

mkdir -p renders
$LOCAL render_view view=front width=1800 height=1100 showGrid=false showAxes=false background=#f4f5f7 --doc "$V.llull.json" --save "renders/${V}_side.png"
$LOCAL render_view 'direction=[1.3,-1,0.45]' width=1600 height=1100 showGrid=false showAxes=false background=#f4f5f7 --doc "$V.llull.json" --save "renders/${V}_iso.png"
