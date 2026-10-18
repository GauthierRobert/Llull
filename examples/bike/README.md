# Road bike with a working chain drive + aero study

A size-L road bike built entirely through llull commands (`build_project` plans), with a 108-link chain that runs
round a 52T ring, a 15T cog and two 13T derailleur pulleys, a physics model of the drive, and an aerodynamic
comparison of three versions.

| Version | What it is |
| --- | --- |
| `baseline` | Round-tube carbon road bike, 25 mm box rims, 24/28 round spokes, external cable loops, 420 mm bars, two bottles |
| `aero` | Same geometry and rider: truncated-airfoil frame, wide-stance airfoil fork, one-piece bar-stem (360 mm, hidden hoses), 65 mm front / disc rear, integrated bottle fairing, chainring disc + chain fairing |
| `aero_fit` | `aero` + the lower front end its cockpit allows (stem −17°, no spacers, torso 38° → 26°) |

Rebuild everything (plans, documents, measurements): `./build.sh` (needs `npm install` at the repo root).
Open a document in llull: `llull describe_scene --doc baseline.llull.json`, or File › Open in the app, then press Play:
wheels, cranks and pulleys spin and the chain links travel round the chain loop (`animate` mode `follow_path`).

## Dimensions and sources

| Item | Value | Source |
| --- | --- | --- |
| Frame | stack 580, reach 401, HTA 73.3°, STA 73.5°, chainstay 413, wheelbase 1003, BB drop 70 mm | [2024 Canyon Aeroad CFR L, Bike Insights](https://bikeinsights.com/bike-geometries/669b91f7826221001b4cdb37-2024-canyon-bicycles-aeroad-cfr-l) |
| Fork offset / trail | 40.2 / 59.7 mm (derived from the geometry above) | `bike.py` |
| Wheels | ETRTO 622 mm bead seat, 28 mm tyres → 678 mm diameter | ISO 5775 |
| Crankset | 52/36 T, 172.5 mm, Q-factor 148 mm, chain plane 48.5 mm off centre | [Shimano FC-R9200 spec](https://worldwidecyclery.com/products/shimano-dura-ace-fc-r9200-crankset-170mm-12-speed-52-36t-hollowtech-ii-spindle-interface-black) |
| Cassette | 11–30, 12 speed, 3.5 mm cog pitch | Shimano road 12 s |
| Chain | 12.7 mm pitch, rollers Ø 7.75 mm, inner width 2.18 mm, outer width 5.5 mm | [BikeGremlin chain standards](https://bike.bikegremlin.com/3555/bicycle-drive-chain-dimension-standards/) |
| Sprocket pitch radius | r = p / (2 sin(π/N)): 52T 105.17, 15T 30.54, 13T 26.53 mm | chain geometry |

The chain loop is the outer belt round the four pitch circles (`draw_belt_around`). Its length is solved to a whole
number of links by swinging the derailleur cage: 108 links = 1371.6 mm (cage at 7.9°).

## Working drivetrain

- **Viewport** (`animate`): crank 90 rpm, chain speed = ω·r₅₂ (0.99 m/s), wheels ω·52/15 (312 rpm, 39.9 km/h),
  pulleys v/r₁₃. Played at 0.25× so links and spokes stay readable.
- **Physics** (`simulate_motion`, MuJoCo): crankset, rear wheel + cassette and front wheel are rigid bodies on revolute
  joints; the chain is a gear coupling crank → rear wheel (+52/15), the road a 1:1 coupling rear → front wheel, the rider
  a motor holding 90 rpm. The rear joint carries the road load at 40 km/h (aero + rolling + bearings from
  `road_load_power`) as an equivalent damping, so the motor torque is the real crank torque:

  | | crank torque | crank power | `road_load_power` at the wheel |
  | --- | --- | --- | --- |
  | baseline | 27.8 N·m | 262 W | 262 W |
  | aero_fit | 23.6 N·m | 222 W | 221 W |

## Aero method

1. `frontal_area` (silhouette rasterisation, 1500 cells) of every part, accumulated front to back so a part hidden
   behind an earlier one only counts with its exposed area; plus a yaw sweep 0–20°.
2. Each part's drag coefficient (frontal-area basis) from Hoerner's strut / cylinder fit at its own Reynolds number at
   40 km/h: Cd = 2.66/√Re·(1 + t/c)·(c/t) + t/c (+0.04 base drag for a truncated tail). Round tubes ≈ 1.03, 2 mm spokes
   ≈ 1.14, 2.8:1 Kamm tubes ≈ 0.45. Blunt parts (pedals, calipers, sprockets, derailleurs, links) 1.0.
3. Calibration on Defraeye et al. 2010 (J. Biomech. 43:1262, rider 1.83 m, hoods): rider alone 0.193 m², rider + road
   bike 0.270 m². Rider Cd = 0.193 / A_rider(baseline) = 0.46; bike interference factor = (0.270 − 0.193) / build-up = 0.71.
   The same two factors are used for every version, so the differences come from the modelled geometry.
4. `road_load_power` (Martin et al. 1998 bicycle preset): 75 kg rider, bike 8.4 / 8.0 kg; `aero_drag` for the force.

## Results (`aero_results.json`)

| | baseline | aero | aero_fit |
| --- | --- | --- | --- |
| Rider + bike CdA (m²) | 0.270 | 0.240 | 0.222 |
| Bike CdA (m²) | 0.077 | 0.050 | 0.050 |
| Power at 40 km/h (W) | 268 | 242 | 227 |
| Speed at 250 W (km/h) | 39.00 | 40.45 | 41.46 |
| 40 km at 250 W | 61:33 | 59:20 | 57:53 |

Bike drag area by part, baseline → aero (cm²): frame 150 → 71, fork 144 → 79, cockpit + cables 163 → 101, bottles
48 → 0, front wheel 177 → 163, seat 25 → 20. The chainring disc and chain fairing add 1–4 cm² at zero yaw in this
model; their expected benefit (rotating flow, crosswind) is outside what a projected-area method resolves.

Limits: no flow separation or interference model beyond the calibration factor, no wheel side-force at yaw, static rider
legs. Treat absolute values as ±10 % and the differences between versions as the result.
