#!/usr/bin/env bash
# Live-edit demo: drives the shared live document through the llull CLI while the browser watches.
# Every step is an ordinary command; the UI animates it (grow, travel, morph, dissolve, ripple, "CLI · <command>" badge).
#   npm --prefix server run dev &   npm run dev &   open http://localhost:5173   then: scripts/demo-live-edits.sh
set -euo pipefail
export LLULL_SERVER="${LLULL_SERVER:-http://localhost:3001}"
PAUSE="${PAUSE:-1.6}"
CLI="$(dirname "$0")/../server/bin/llull.cjs"

step() { node "$CLI" "$@" --quiet; sleep "$PAUSE"; }
# Runs a command and prints the first affected id.
first_id() {
  node "$CLI" "$@" --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).affected[0]))'
  sleep "$PAUSE"
}

step clear_document
step set_camera target=[0,0,3.6] azimuth=0.75 polar=1.12 distance=27
step add_box size=[10,7,0.6] position=[0,0,0.3] color='#64748b'
node "$CLI" run - --quiet <<'PLAN'
{ "actions": [
  { "command": "add_cylinder", "params": { "radius": 0.35, "height": 4, "position": [-4, -2.6, 2.6], "color": "#38bdf8" } },
  { "command": "add_cylinder", "params": { "radius": 0.35, "height": 4, "position": [4, -2.6, 2.6], "color": "#38bdf8" } },
  { "command": "add_cylinder", "params": { "radius": 0.35, "height": 4, "position": [-4, 2.6, 2.6], "color": "#38bdf8" } },
  { "command": "add_cylinder", "params": { "radius": 0.35, "height": 4, "position": [4, 2.6, 2.6], "color": "#38bdf8" } },
  { "command": "add_box", "params": { "size": [10, 7, 0.4], "position": [0, 0, 4.8], "color": "#94a3b8" } }
] }
PLAN
sleep "$PAUSE"
SPHERE=$(first_id add_sphere radius=1.1 position=[0,0,1.8] color='#f97316')
step move_entities ids="[\"$SPHERE\"]" delta=[0,0,4.3]
step scale_entity id="$SPHERE" factor=1.5
TORUS=$(first_id add_torus ringRadius=1.4 tubeRadius=0.3 position=[3,0,7.4] color='#a855f7')
step rotate_entity id="$TORUS" delta=[1.5708,0,0]
step array_polar id="$TORUS" count=4 center=[0,0,7.4]
step delete_entities ids="[\"$SPHERE\"]"
step draw_rectangle width=3 height=2 position=[-1.5,-6,0]
# Any REST caller is shown too (labelled "API"):
curl -s -X POST "$LLULL_SERVER/command" -H 'Content-Type: application/json' \
  -d '{"name":"add_cone","params":{"radius":0.8,"height":1.6,"position":[0,-6,0.8],"color":"#f59e0b"}}' >/dev/null
sleep "$PAUSE"
step add_planetary_gearset module=0.15 sunTeeth=12 planetTeeth=12 planetCount=3 faceWidth=0.4 ringOuterRadius=3.1 position=[0,0,0.8]
step undo
step redo
