# Cervélo S5 (2025, size 56) with a working chain drive

A one-piece-frame model of the 2025 Cervélo S5 (Ultegra Di2 build, Reef Blue), built entirely through llull commands,
with a running 106-link chain, a physics model of the drive and an aero measurement on the same scale as `../bike`
(round-tube road bike and aero concepts).

Open `s5.llull.json` in llull and press Play: wheels, cranks and pulleys turn and the links run round the chain loop.

## Where the shapes come from

The frame is traced from Cervélo's official size-56 geometry drawing. The frame fill was segmented, the drawing scaled
from the wheelbase (982 mm between the axle centres), and every tube was sampled every 10 mm along its centre line.
Each station was re-centred between the tube's two edges and its depth measured normal to the tube. `frame.py` holds
the result (`TT`, `DT`, `ST`, `SS`, `CS`, `BLADES` and the head-block `BAYONET` rows). Lateral widths are not in a side
drawing, so they come from photos. Overlaid on the drawing, the model's side silhouette matches the official one to
within a few mm, apart from the seatpost (its saddle height is the 1.80 m rider's, not the drawing's).

| Part | How |
| --- | --- |
| Frame | Kamm-section lofts on the traced centre lines: shallow 23 mm top tube that flares into the head, 76–86 mm down tube, a slim seat tube curved round the rear tyre, a seat mast up into the cluster, straight dropped seatstays meeting the mast 160 mm below the top tube, deep chainstays, flat-mount dropouts. Welded into one solid with `blend_union` (filleted joints) on the exact OCC kernel, with a plain `boolean` union where the kernel will not fillet. |
| Fork | Bayonet: the crown runs up the front of the head tube to the top cap (nose 52–63 mm ahead of the steering axis). Wide crown stepped under the down tube, blades 66 → 47 mm deep. Offset 43.5 mm, trail 55 mm. Welded. |
| Cockpit | One-piece carbon bar/stem (HB19, 100 mm stem, 40 cm at the hoods flaring to 44 cm in the drops), proportions from the side photo: a slim 22 mm stem blade rising 22° out of the top cap into the bar centre, flat aero tops swept about 70 mm forward to the hoods, compact drops tucked under the hoods and ending just ahead of the head tube, Di2 hoods with a tall horn, levers |
| Seat | Black D-shaped aero seatpost, clamp head, saddle |
| Wheels | Reserve 57 / 64 toroidal rims (revolved cross-section), 28c tyres, 24 bladed spokes laced 2-cross, centre-lock 160 / 140 rotors, flat-mount calipers, thru-axles |
| Drivetrain | Roller-seat tooth profiles on the 52/36 rings, the Ultegra 11–34 cassette and both 13T pulleys, 170 mm cranks. Derailleur cage angle solved for a whole number of links (106 = 1346.2 mm). Figure-8 chain plates, 7.75 mm rollers, pins |
| Finish | Reef Blue metallic carbon under clearcoat, lime CERVELO on the down tube, black carbon cockpit and seatpost, carbon rims, brushed alloy, rubber |
| Rider | 1.80 m, lofted limbs and torso, subdivision helmet and shoes, hands on the hoods (torso angle solved from the cockpit position) |

## Geometry (size 56, Cervélo)

Reach 392, stack 565, head angle 73.5°, seat angle 73°, head tube 125, top tube 565, chainstay 405, wheelbase 982,
BB drop 72, fork offset 43.5, trail 55.6 mm (Cervélo geometry chart, 2025 S5).

## Aero (`s5.aero.json`, `s5x.aero.json`, `s5xf.aero.json`)

Same method and calibration as `../bike`: Hoerner strut and cylinder drag coefficients, exposed areas accumulated front
to back, Defraeye 2010 calibration and the Martin 1998 power model. Stock S5 drag ranking (bike CdA share): front wheel 174 cm², cockpit 127, fork 105, frame 56, crankset 31, seat 20.

| | round tube | aero concept | concept + fit | **S5 2025** | S5 Aero+ | **S5 Aero+ fit** |
| --- | --- | --- | --- | --- | --- | --- |
| Bike CdA (m²) | 0.0770 | 0.0498 | 0.0497 | 0.0534 | 0.0452 | 0.0450 |
| Rider CdA (m²) | 0.1930 | 0.1904 | 0.1723 | 0.1828 | 0.1662 | 0.1456 |
| Rider + bike CdA (m²) | 0.2700 | 0.2402 | 0.2220 | 0.2363 | 0.2114 | 0.1906 |
| Power at 40 km/h (W) | 268 | 242 | 227 | 239 | 217 | 200 |
| 40 km at 250 W | 61:33 | 59:20 | 57:53 | 59:00 | 57:00 | 55:13 |

The 2025 S5's taller front end (stack 565 mm, rising one-piece cockpit) sits the same rider higher than the 542 mm
stack of the earlier frames, so its rider CdA is higher. The bike row is the like-for-like comparison.

**S5 Aero+** (`python3 s5.py s5x`; options in `options.py`) attacks that ranking:

- frame tubes 12% deeper and 15% narrower
- bayonet fork and blades 15% deeper and 18% narrower
- deeper, narrower seatpost
- 65 mm front rim with 18 bladed spokes and a 25c tyre
- 1× 52T with a flush ring cover and no front derailleur
- 360 mm bar, −17° stem, narrower hoods and saddle

That takes 82.9 cm² off the bike CdA. **Aero+ fit** (`s5xf`) adds the position the bike is built for: 330 mm hoods,
forearms level, torso 17°, aero road helmet. That gives −19% system CdA, 39 W less at 40 km/h and 3:48 saved over
40 km at 250 W.

## Build

```bash
LLULL_KERNEL=occt LLULL_OCC_TIMEOUT_MS=900000 PORT=3101 npm --prefix ../../server run dev   # exact-kernel server
./build.sh
```

`s5.py` writes the plan; `aero.py` measures the un-welded parts; `weld.py` fuses the frame, fork and stem on the
server (each joint tries fillet radii 8 → 2 mm, then a plain union); `organize.py` adds materials, decals, layers, the
animation and the physics. Weld outcomes (fillet radius per joint, or plain union) are recorded in `s5.welds.json`.
`./build.sh s5x` or `./build.sh s5xf` builds an Aero+ variant the same way.
