# Cervélo S5 (2023, size 56) with a working chain drive

A one-piece-frame model of the 2023 Cervélo S5, built entirely through llull commands, with a running 106-link chain,
a physics model of the drive and an aero measurement on the same scale as `../bike` (round-tube road bike and aero
concepts).

Open `s5.llull.json` in llull and press Play: wheels, cranks and pulleys turn and the links run round the chain loop.

## What is modelled

| Part | How |
| --- | --- |
| Frame | 11 lofts through truncated-NACA (Kamm) sections normal to each tube: deep head tube (110 mm), down tube deep at the head tube and wide at the BB, seat tube trimmed station by station to keep 12 mm from the 28c tyre (wheel cut-out), dropped seatstays meeting the seat tube 165 mm below the top tube, chainstays inboard of the 52T ring. Welded into one solid with `blend_union` (filleted joints) on the exact OCC kernel, `boolean` union where the kernel will not fillet. |
| Fork | Crown that continues the head-tube airfoil, blades 46 mm off centre, welded |
| Cockpit | V-stem (two arms from the steerer clamp to a bar-clamp fairing), flat airfoil tops, swept drops, subdivision hoods, levers |
| Wheels | Reserve-style 52 / 63 mm toroidal rims (revolved cross-section), 28c tyres, 24 bladed spokes laced 2-cross, centre-lock 160 / 140 rotors, flat-mount calipers, thru-axles |
| Drivetrain | Roller-seat tooth profiles on the 52/36 rings, the 11–30 cassette and both 13T pulleys; derailleur cage angle solved for a whole number of links (106 = 1346.2 mm); figure-8 chain plates, 7.75 mm rollers, pins |
| Finish | Red carbon twill under clearcoat, black carbon cockpit, carbon rims, brushed alloy, rubber; CERVELO / S5 / RESERVE decals |
| Rider | 1.80 m, lofted limbs and torso, subdivision helmet and shoes, hands on the hoods (torso angle solved from the cockpit position) |

## Geometry (size 56)

Stack 542, reach 384, head and seat angles 73°, chainstay 405, wheelbase 975, BB drop 70 mm
([Bike Insights](https://bikeinsights.com/bike-geometries/674b6c8eeaeae6001b8b632c-2023-cervelo-cycles-s5-base-56)).
Derived: fork offset 45.7 mm, trail 55.9 mm. Design features from
[Wheelbase](https://www.wheelbase.co.uk/blog/new-cervelo-s5-s3-launched),
[Summit Bicycles](https://www.summitbicycles.com/articles/cervelo-s5-pg761.htm) and
[Brújula Bike](https://en.brujulabike.com/cervelo-s5-2023-new-features-range-prices-bike-tour-winner/). Shapes are
built from photos and the published numbers, not Cervélo CAD.

## Aero (`s5.aero.json`)

Same method and calibration as `../bike` (Hoerner strut / cylinder drag coefficients, front-to-back exposed areas,
Defraeye 2010 calibration, Martin 1998 power model):

| | round tube | aero concept | concept + fit | **S5** |
| --- | --- | --- | --- | --- |
| Bike CdA (m²) | 0.077 | 0.050 | 0.050 | **0.048** |
| Rider CdA (m²) | 0.193 | 0.190 | 0.172 | 0.177 |
| Rider + bike CdA (m²) | 0.270 | 0.240 | 0.222 | **0.225** |
| Power at 40 km/h (W) | 268 | 242 | 227 | **229** |
| 40 km at 250 W | 61:33 | 59:20 | 57:53 | **58:06** |

The S5's lower stack (542 mm) puts the same rider lower than on the other frames, so the bike row is the
like-for-like comparison. Physics check: with the rear-wheel road load, the rider motor holds 90 rpm at 23.8 N·m =
224 W (road-load power at the wheel: 223.5 W).

## Build

```bash
LLULL_KERNEL=occt LLULL_OCC_TIMEOUT_MS=900000 PORT=3101 npm --prefix ../../server run dev   # exact-kernel server
./build.sh
```

`s5.py` writes the plan; `aero.py` measures the un-welded parts; `weld.py` fuses the frame, fork and stem on the
server (each joint tries fillet radii 8 → 2 mm, then a plain union); `organize.py` adds materials, decals, layers, the
animation and the physics. Weld outcomes are recorded in `s5.welds.json`: in this build 9 of 10 frame joints fused
(6 filleted) and the seatstay pair stays a separate solid touching the seat tube and dropouts; the fork fused 3 of 4 joints (one fork tip stays separate) and the stem all 5 (1 filleted).
