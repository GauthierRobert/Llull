#!/usr/bin/env bash
# HALO "how it works" film: render the frames with llull (renderFrames.ts), then encode with captions.
#   designs/halo/video/render.sh [framesDir]      -> designs/halo/video/halo_how_it_works.mp4
# Needs: node + the repo's npm install (server/), ffmpeg with drawtext. ~2 s per frame and process.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
frames="${1:-$here/frames}"
doc="$repo/designs/halo/halo_v2.llull.json"
bundle="$repo/server/dist/halo-renderFrames.cjs"
font=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
fontLight=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

if [ ! -f "$frames/f1127.png" ]; then
  (cd "$repo/server" && node -e "require('esbuild').buildSync({entryPoints:['../designs/halo/video/renderFrames.ts'],absWorkingDir:process.cwd(),tsconfig:'tsconfig.json',bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',outfile:'dist/halo-renderFrames.cjs',logLevel:'error'})")
  mkdir -p "$frames"
  node "$bundle" "$doc" "$frames" 0 375 & node "$bundle" "$doc" "$frames" 376 751 & node "$bundle" "$doc" "$frames" 752 1127 &
  wait
fi

# caption <start> <end> <title> <subtitle>: fades in/out over 0.4 s
filters=""
caption() {
  local a=$1 b=$2 title=$3 sub=$4
  local alpha="if(lt(t,$a+0.4),(t-$a)/0.4,if(gt(t,$b-0.4),($b-t)/0.4,1))"
  filters+=",drawbox=x=0:y=ih-150:w=iw:h=150:color=black@0.45:t=fill:enable='between(t,$a,$b)'"
  filters+=",drawtext=fontfile=$font:text='$title':fontcolor=white:fontsize=33:expansion=none:x=60:y=h-128:alpha='$alpha':enable='between(t,$a,$b)'"
  filters+=",drawtext=fontfile=$fontLight:text='$sub':fontcolor=0xcfe3ff:fontsize=23:expansion=none:x=62:y=h-70:alpha='$alpha':enable='between(t,$a,$b)'"
}
caption 0.3 5 "HALO  -  a drone with no arms and no open propellers" "one ring is the duct, the wing, the guard and the landing gear   |   440 mm   |   1.10 kg"
caption 5 12 "Inside — hollow CFRP ring, two hub motors, 8 x 21700 cells" "144 Wh split around the motors sets the CG ahead of the neutral point (+8.5 % margin)"
caption 12 20 "Hover — two contra-rotating toroidal rotors inside a duct" "closed-loop blades, ~30 m/s tips (a quad ~75 m/s)  |  est. ~82 W, 15-20 dB(A) quieter"
caption 20 27 "Transition — the exit flaps pitch it 90 degrees nose-first" "the duct becomes an annular wing   |   no tilting mechanism, no extra motors"
caption 27 34 "Cruise — the ring is the wing  -  span efficiency ~2" "25 m/s cruise, ~55 m/s top speed (est.)   |   shown slowed down"
caption 34 42 "Landing — back to hover, it sits on four TPU feet" "nothing to fold, nothing exposed to break"
caption 42 46.8 "HALO v2  -  designed, checked and rendered in llull" "~80 min hover   |   ~145 km at 25 m/s   |   estimates — see designs/halo/README.md"
filters+=",drawtext=fontfile=$fontLight:text='llull':fontcolor=white@0.55:fontsize=22:x=w-90:y=24"

ffmpeg -loglevel error -y \
  -f lavfi -i "gradients=s=1280x720:c0=0x9fb8d4:c1=0x1b2433:x0=640:y0=0:x1=640:y1=720:d=47:r=24" \
  -framerate 24 -i "$frames/f%04d.png" \
  -filter_complex "[0][1]overlay=shortest=1,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=46.2:d=0.8${filters}" \
  -c:v libx264 -preset slow -crf 20 -movflags +faststart "$here/halo_how_it_works.mp4"
echo "wrote $here/halo_how_it_works.mp4"
