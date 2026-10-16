# Research A — How mature CAD/CAE products model and simulate driven closed-loop mechanisms

Scope: piston / slider-crank -> crankshaft -> gearbox -> propeller style mechanisms. For each product:
(1) bodies/joints/closed loops/redundancy, (2) drivers and gas force, (3) pre-run checks and messages,
(4) outputs, (5) review UX. Every claim is tagged with the source it was read from ([Rn], list at the end).
"NOT FOUND" means the fetched official sources did not state it; "(secondary)" means non-vendor source;
"(uncertain)" flags inference.

Access notes: SOLIDWORKS help and Autodesk Fusion help are JS-rendered and were read through a headless
browser. CATIA V5 DMU Kinematics was read from a public mirror of the Dassault V5 user guide
(catiadoc.free.fr) — content is the official V5 doc text, but the host is unofficial. Siemens NX/Simcenter
help (docs.sw.siemens.com) requires login; Siemens content came from public Siemens fact sheets and the
Siemens community. MSC Adams content came from the official Hexagon Adams 2021.0.2 Solver and View user
guide PDFs. No official Adams Engine documentation was reachable.

---

## 1. SOLIDWORKS Motion (Motion Study: Animation / Basic Motion / Motion Analysis)

### 1.1 Study types and model definition
- Motion studies are timeline-based (MotionManager) graphical simulations of assembly motion; they do not
  change the assembly model. Three study types: **Animation** (core; motors + key points, interpolated
  motion), **Basic Motion** (core; approximates motors, springs, contact, gravity; takes mass into
  account; fast), **Motion Analysis** (SOLIDWORKS Motion add-in, Premium; forces, springs, dampers,
  friction; "computationally strong kinematic solvers"; accounts for material, mass, inertia; plots) [R2].
- Bodies = assembly components; joints = ordinary assembly **mates** reused by the solver. A Motion
  Analysis study "combines motion study elements with mates in motion calculations" and "also calculates
  loads that can be used to define load cases for structural analyses" [R18].
- Mate restrictions for Motion Analysis: width and slot mates not supported; coincident mates of
  coordinate systems not supported; symmetry mates only with two geometries [R19].
- Rigid groups / rigid subassemblies for components fixed relative to each other [R3].

### 1.2 Closed loops and redundancy
- "When you use a Motion Analysis study to calculate motion, it calculates the number of degrees of freedom
  in your mechanism and removes redundant mates as it determines and solves the equations of motion" [R3].
- Closed-loop example: "There are three redundant mates in a four-bar linkage when all of the mates are
  concentric", because each side of the loop constrains the coupler to stay in-plane; "The software
  attempts to resolve constraints imposed by the redundant mates automatically" [R3].
- "For Motion Analysis studies, having redundant mates is the equivalent of over-defining a SOLIDWORKS
  model." Door-with-two-hinges example: only one hinge carries the vertical force — "You can see this when
  you plot the forces." "Automatic redundant constraint handling can yield erroneous results." [R1]
- Consequence on forces: "A Motion Analysis study eliminates redundant mates when calculating motion. This
  results in a calculation of zero force at the mate locations of the affected parts." Option **Replace
  redundant mates with bushings** (Motion Study Properties) makes forces computed at those locations;
  bushing stiffness/damping editable afterwards [R5][R4]. It "significantly slows down the simulation" [R1].
- Recommended remediation order: rigid subassemblies/rigid groups -> replace redundant mate pairs forming a
  hinge with **hinge mates** -> **mate primitives** -> **bushings** [R3].

### 1.3 Drivers and forces (gas-force applicability)
- **Motor** types: Rotary, Linear (actuator), Path Mate Motor (MA only). Motion profiles: Constant speed,
  Distance (displacement, start, duration), Oscillating (amplitude, frequency, phase), **Servo Motor (MA
  only; displacement / velocity / acceleration, for event-based studies)**, Segments, **Data Points**
  ("interpolated data set as a function of time, cycle angle, or motion study results"), **Expression**
  ("mathematical expression of time, cycle angle, or motion study results"), load from .sldfcn file [R6].
- Motors "are not forces. Motor strength does not vary based on component size or mass" [R6].
- **Force**: Linear force or Torsional (torque); **Action only** or **Action & reaction** (equal and
  opposite on a reaction part); functions Constant, Step, Harmonic, Segments, Data Points, Expression;
  "Load bearing faces" for transfer to Simulation [R7].
- **Cycle settings** (Motion Study Properties): cycle rate (cycles/s) or cycle time "defines the cycle
  angle used in custom Motor or Force profiles" [R4]. => A piston gas force can be applied as an
  action-and-reaction linear force between piston and cylinder/block with a Data Points profile versus
  cycle angle or versus a motion result (e.g. crank angle) (inference from [R4][R6][R7]; no
  engine-specific feature documented).
- Contact: 3D solid-body contact and 2D curve-to-curve contact, friction from materials or explicit
  coefficients; contact groups [R17].

### 1.4 Pre-run checks
- "Click Calculate (MotionManager toolbar). Right-click Mates (MotionManager tree) and click Degrees of
  Freedom. The Degrees of Freedom dialog box provides the degrees of freedom in the model and a list of the
  redundant constraining mates." "Redundant constraints can provide inaccurate motion calculations." [R3]
  (Note: the check is available after a Calculate, not as a pure static pre-check.)
- "Show all Motion Analysis messages" option shows messages during computations [R4].
- Integrator: GSTIFF (default), SI2_GSTIFF, WSTIFF; max iterations default 25, "If the program exceeds this
  limit, a convergence failure is recorded"; min/max/initial step size, Jacobian re-evaluation [R16].
- Troubleshooting FAQ: incorrect joint reactions -> check units, component densities, redundant mates;
  "If working with linkages, remove redundancies to improve the accuracy of the force results" [R13].

### 1.5 Outputs
- Results PropertyManager categories [R8]:
  - Displacement/Velocity/Acceleration: **Trace Path** ("on-screen graphics, tracing the path of a
    vertex"), Center of Mass Position, linear/angular displacement, velocity, acceleration.
  - Forces: **Motor Force, Motor Torque, Reaction Force, Reaction Moment**, Friction Force/Moment,
    Contact Force.
  - Momentum/Energy/Power: momenta, kinetic energies, potential energy delta, **Power Consumption**.
  - Other: Euler / Bryant / pitch-yaw-roll / Rodriguez / projection angles, **Reflected Load
    Mass/Inertia** (motor sizing).
- Each result picks a Feature (face/edge/vertex/**mate**), optional Reference Part, result component;
  plot vs **Time** or **Frame** or **another result** ("New Result") [R9].
- **Show vector in the graphics window** for reaction force/moment and linear displacement/velocity/
  acceleration [R9].
- **Motion data sensors** with criterion Model Max / Min / Average / RMS / Value at a specific time, and
  **Sensor Alert** (operators: greater than, less than, between, not between, ...) — "When a sensor
  triggers an alert, the sensor is flagged in the FeatureManager design tree" [R9].
- **Interference over time** ("Find Interferences Over Time"): select parts, Start Frame, End Frame,
  Increment, Find Now; output lists **frame, simulation time, parts, interference volume**; Details shows
  **volume, area, bounding box**; Zoom to Selection; selecting an entry displays that frame with the
  intersection geometry and bounding box. Also finds "the place where the first interference occurs ...
  The assembly is moved to the position where the interference occurred" [R10][R11].
- FEA hand-off: with SOLIDWORKS Simulation, stress/FoS/deformation of components "without setting up loads
  and boundary conditions. The required loads are obtained automatically from a calculated Motion Analysis
  study", for isolated times or time ranges; or export loads at a time of interest to Simulation [R12].
- Export: plot -> right-click -> **Export CSV** [R13]; **Export to ADAMS** (.adm + .xmt_bin; key-point
  manipulations and USER functions not exportable) [R15].

### 1.6 Review UX
- MotionManager: design tree + **timeline**, **time bar** (current time), **changebars** between key
  points, key frames/key points, Autokey (Animation only) [R14].
- Frames per second setting; "Animate during simulation" toggle; save animation to video; troubleshooting
  advises 100-200 frames [R4][R13].

---

## 2. Siemens NX Motion / Simcenter 3D Motion

(Official help not publicly reachable; facts below are from Siemens fact sheets / solution guide /
community.)

### 2.1 Model definition
- Links (motion bodies) defined from CAD master model, associative, mass properties overridable; "CAD
  assembly defined with mating conditions can be directly mapped to a motion model consisting of links and
  joints" [R44]; Simcenter 3D Motion Modeling "will convert assembly constraints into the most appropriate
  mechanism joint types" [R43].
- Joints: revolute, cylindrical, spherical, translational, screw, gear, planar, universal; constraint
  primitives in-line, in-plane, parallel, perpendicular, orientation; curve/surface joints point-curve,
  point-surface, curve-curve; friction; submechanisms [R43].
- **Constraint Optimization** (Advanced Solution Options): merges motion bodies connected by fixed joints
  into one body; identical results, less CPU (8.6 s -> 5.5 s example) [R47].
- Redundant constraints / Gruebler: Siemens training lists "Joints", "Motion drivers", "Working with
  results", "Load Transfer" [R49]; NX Open API exposes a Gruebler-count method (search snippet only, not
  fetched — uncertain). Exact redundant-constraint messages: NOT FOUND.

### 2.2 Drivers
- "Movement is activated by one or more of the following: motion drivers, applied forces, torques or
  gravity"; drivers and loads defined with an integrated **function builder**; functions/graphs stored in
  .afu files for reuse [R44]. Input curves importable from CSV, MATLAB, RPC III, DAC, etc. [R43].
- Solution types: normal run (kinematics, dynamics, static, time and step), **Articulation** (quasi-static
  or kinematic, interactively driven), **Spreadsheet** (driven via live Excel table) [R43][R48].
  Articulation: "The Simcenter Motion solver is solving quasi-static and writing out the results during the
  whole Articulation dialog is up. Hence you can review the animation and XY graph." [R46]
- Engine/gas-force-specific features: NOT FOUND.

### 2.3 Outputs and review
- Results: displacements, velocities, accelerations, **reaction forces**, flexible-body results [R48].
- Sensors "to report reaction, position, velocity and acceleration"; **Result measure**: "capture the
  time-dependent result quantity as an expression; for example, to extract the maximum torque reaction and
  automatically compare with a requirement" [R43].
- Postprocessing: animation, XY graphing (math ops, FFT), **motion envelope, interference check, point
  trace**, load vectors, capture assembly arrangements during animation, **load transfer to Simcenter 3D
  Engineering Desktop**, JT/VRML/movie output [R48]; "Synchronize graph animation with visual mechanism
  animation"; "trace geometries and envelope, interference and clearance, dynamic measurements" [R43].
- Interference set semantics (quoting NX 11 docs via Siemens PM): one set => all objects in the set vs each
  other; two sets => each object of set 1 vs each object of set 2 [R45].

---

## 3. CATIA V5 DMU Kinematics (KIN) / 3DEXPERIENCE

### 3.1 Model definition and the DOF=0 rule
- Mechanism = products connected by joints; 16 joint types (Revolute, Prismatic, Cylindrical/Actuator,
  Planar, Rigid, Spherical, Universal, Point-Surface, Point-Curve, Roll-Curve, Slide-Curve, Screw, **Gear**,
  **Rack**, **Cable**, CV); joints can be generated from Assembly Design constraints [R32][R34].
- A **Fixed Part** is defined (Insert > Fixed Part); task pages show "the mechanism can be simulated" once
  joints + fixed part + commands are complete [R29][R24].
- Commands: angle- or length-driven flags on a joint ("Angle driven", "Length driven") [R29].
- Glossary: "kinematics mechanism ... It can be simulated when the number of commands is equal to degrees
  of freedom (in this case the mechanism is said to be complete)" [R21].
- "When the degree of freedom with commands of the mechanism reaches 0, the mechanism can be simulated."
  [R22]. After creating joints/fixed part the doc repeatedly shows an information message "The mechanism
  can be simulated" [R33 (IBM APAR quoting the info window)], [R24 family pages].
- Closed loops: command sense-of-motion arrow is **blue** when the absolute motion direction can be
  determined ("case of all open chain mechanisms") and stays **green** "because the selected command
  belongs to a joint involved in a loop" [R29]. Loop closure is handled by the solver implicitly; no
  redundancy/over-constraint diagnostic text found in the V5 KIN guide (NOT FOUND).
- **Mechanism Analysis** dialog: per joint — type, parts, geometry, command, validity; message
  "invalid joint!" when a part is deleted; DOF displayed by default (can be hidden in the tree);
  "Show joints" visualization; export to .xls / .txt [R23]. Imported sub-mechanisms show "DOF=0" in the
  tree label [R23 (kinugat0902/0904 pages)].

### 3.2 Drivers
- **Simulation with Commands**: sliders per command, Immediate or On request (steps) modes [R24].
- **Simulation with Laws**: laws (commands as functions of time), time range and number of steps, VCR
  buttons (Start, Play Back, Step Back, Pause, Step Forward, Play Forward, End) [R25]; laws from
  Knowledgeware formulas or 2D curves (guide sections, not individually cited).
- KIN is kinematic only — forces/gas pressure are not part of DMU Kinematics (inference from all KIN pages:
  no force entity is documented; uncertain for 3DEXPERIENCE Mechanical Systems).

### 3.3 Checks during motion and outputs
- **Sensors** (Activate Sensors): joint values, measures (distances/angles), joint limits (Check Limits:
  on / stop), speeds and accelerations; History tab with values over the run [R25][R26].
- **Clash**: interference object (Contact + Clash, between two selections); during simulation the
  **Nbclash** sensor; "The parts in collision are highlighted in the geometry area and in the specification
  tree"; automatic clash detection with **Stop** mode: "The simulation is stopped once a clash is
  detected" [R27][R28]; KIN also offers "Stop on collision" and dynamic clearance/minimum distance [R32].
- **Trace** of a point on a moving part (for cam design) and **swept volume** of a part over its range of
  motion; swept volumes reusable in clash analysis; swept volume needs DMU Space Analysis [R32][R30].
- **Plots**: sensor vs time during law-based simulation, and sensor vs sensor, e.g. "engine inlet valve
  position against crankshaft rotation" [R32]; instantaneous tangent / rotation vector plotting [R31].
- Recording: Simulation object records positions, replay with VCR buttons, can drive several mechanisms;
  replay/video [R35][R32].

---

## 4. PTC Creo Mechanism (Mechanism Design / Mechanism Dynamics)

### 4.1 Model, loops, redundancy
- Workflow: make connections -> motion-axis settings -> **drag** assembly -> servo motors -> initial
  conditions -> measures -> position / kinematic analysis -> playback, interference, measures, trace curves,
  motion envelopes [R38].
- **Loop connections**: "joints that connect a loop of parts back onto itself"; failed-assembly advice: remove
  loop connections to see if a simpler mechanism assembles; last resort disable a loop connection in the
  Drag dialog, reposition, re-enable; check assembly tolerance (absolute tolerance derived from relative
  tolerance x characteristic length); a failed position analysis "is most likely due to invalid servo motor
  values"; message that the mechanism could not be assembled [R40].
- Redundancies: "excess constraints that do not apply any restrictions to a rigid body's motion"; door with
  two pins — "the second pin joint does not constrain the door's motion"; motion results stay correct, but
  "you may not get accurate values for measure connection reactions or load reactions"; "it is critical
  that you eliminate redundancies" for reactions; DOF and redundancies calculated by default each time
  motion is analysed; read them via a Dynamic/Static/Force Balance analysis and the **Measure Results**
  dialog [R36].

### 4.2 Drivers
- **Servo motor**: position, velocity or acceleration of a motion axis or geometric entity versus time;
  servos determine motion even if loads are present; reaction data still obtainable [R41]. Tutorial: servo
  on a connection rotation axis switched to angular velocity 45, Kinematic analysis [R37].
- **Force motor**; sizing a force motor: run dynamics with a servo producing the ideal motion, measure the
  load reaction at the servo; a zero-position servo locks a joint and shows the holding force [R41].
- Gas-force/engine feature: NOT FOUND (a force motor with a user function would be the generic route —
  inference).

### 4.3 Outputs and review
- **Connection reaction measures**: force or moment exerted by a joint on either body, in a chosen
  coordinate system, with a shaded direction arrow; cam-follower normal/tangential force and slip; slot
  follower; gear pair torque/force incl. pitch-point forces; belts; 3D contact; use **net load measures**
  for the applied load of a servo or force motor [R42].
- Measures plotted with Graph (Chart-Tool) from a result set [R37].
- **Playback** dialog: view interference between parts during playback; save a **motion envelope** (volume
  swept by parts, saved as a part file); each run saved as a playback file reusable in other sessions;
  export AVI/MPEG/JPEG/TIFF/BMP; track a measure during playback [R39]; **trace curves** from kinematic
  results [R38].

---

## 5. Autodesk Fusion (joints, motion links, contact sets, motion study)

- Joints define motion (only required DOF left open); constraints lock DOF; Rigid Group; **Drive Joints**
  (set rotation angle / distance per DOF: Rotate, Slide, Axis, Normal, Pitch, Yaw); **Motion Link** (relate
  DOF of selected joints with values, reverse, animate); Animate Joint / Animate Model; Edit Joint Limits
  (min, max, rest) [R50][R53][R54].
- **Contact sets**: components only move until they contact; "If interference is detected, the components
  do not move"; "requires more computation than a motion joint"; Enable/Disable All Contact [R55].
- **Motion Study**: "kinematic motion analysis based on joints"; select joints, specify points and values;
  table of Joint / DOF / Value at slider position; play forward/backward, step, mode (one direction,
  back-and-forth, loop), speed slider [R51][R52].
- Forces, dynamics, reactions, redundancy checks, plots: NOT FOUND in Fusion assembly help (Fusion motion is
  kinematic). Closed-loop handling/DOF messages: NOT FOUND.

---

## 6. Onshape (mates, mate relations, animate, simulation)

- Mates: Fastened, Slider, Revolute, Pin Slot, Planar, Cylindrical, Ball, Parallel, Tangent, Width, Group;
  limits (min/max, drawn as dashed lines); **Animate** drives one DOF of one mate "while honoring other
  Mates" with start/end values (up to 36000 deg), steps (min 2, ~60 steps/s), playback Single /
  Reciprocate (Loop in video), read-only current value; red mate indicators show a problem [R56].
- **Mate relations**: Gear (two rotational DOF), Rack and Pinion (rotational to linear, distance per
  revolution), Screw (single cylindrical mate), Linear (constant ratio) [R57].
- **Onshape Simulation** = linear static FEA and modal only; mates define connectivity; "Any range
  prescribed in a Mate has no effect on the simulation"; Gear/Rack-pinion/Screw/Linear relations, Tangent,
  Pin Slot, Parallel, Width mates are not translated into simulation; no motion/dynamics simulation [R58].
- Over-constraint / redundancy diagnostics: NOT FOUND.

---

## 7. MSC Adams (Adams View / Adams Solver; Adams Engine)

### 7.1 DOF and redundancy (official Solver/View user guides)
- Gruebler: "Degrees of freedom = [ 6 * (Number of movable bodies) ] - (Number of constraints)", ground not
  counted, prescribed motions subtract DOF. Worked example: 3 bodies, 1 rotational motion, 3 revolutes, 1
  translational => "DOF = (6*3) - (1+5+5+5+5) = 18 - 21 = -3"; "When the Gruebler equation yields a DOF
  count less than zero, it indicates that the model definitely has one or more constraints that are
  redundant"; replacing one revolute by spherical and one by cylindrical gives 0; ">= 0 ... you cannot be
  positive that the mechanical system does not contain constraints that are redundant" [R59].
  (This example is exactly a slider-crank / four-bar closed loop.)
- Solver behaviour: Adams "subjectively determines which constraints are redundant, deletes them from the
  set of equations"; "Systems with redundant constraints do not have a unique solution"; door example —
  ignores five equations, "subjectively sets the reaction forces to zero at the redundant hinge"; can solve
  overconstrained models only if redundant constraints are **consistent**; "Adams Solver stops execution as
  soon as the redundant constraints become inconsistent" (planetary gear misalignment accumulating);
  initial conditions are not checked for redundancy; remedies: joint primitives or flexible connections;
  the message file lists how many and which constraints were removed [R59]. Best practice: "Adams
  eliminates them by looking at pivots in a constraint Jacobian, which are in no particular order. As a
  result, the physical meaning may be disregarded." and "Models should have no warnings during simulation
  (for example, redundant constraints ...)" [R59].
- Kinematic analysis = "An analysis of a mechanical model with zero degrees of freedom. Adams Solver
  calculates the reaction and applied forces as well as the motion of the model." If dynamics is requested
  for a zero-DOF system, Adams Solver (C++) issues a warning and runs kinematics instead [R59].
- Adams View **Model Verify** tool (Simulation Controls or Tools > Model Verify): information window;
  checks misaligned joints, unconstrained parts, massless parts in dynamic models; Gruebler count used as
  rough DOF estimate [R60].
- Exact redundant-constraint warning texts (Adams View), e.g. for a four-bar with four revolutes:
  "Joint_1 unnecessarily removes Rotation Between Zi and Xj", "Joint_1 unnecessarily removes Rotation
  Between Zi and Yj", "Joint_3 unnecessarily removes Rotation Between Zi and Xj" => change Joint_1 to
  spherical and Joint_3 to universal, or one revolute to inline. "Adams Solver does not calculate joint
  reaction forces in any directions associated with redundant constraint equations ... you may also want
  to select your joint types based on where you want to measure joint reaction forces." [R60]
- Each joint's equation set listed (fixed 6, spherical 3, revolute 5, translational 5, inline 2) [R60].

### 7.2 Drivers, outputs, review
- Measures tracked "during and after a simulation" with **strip charts** shown live as the simulation
  occurs; requests for displacement/velocity/acceleration/force; result-set components are time series
  such as "the y torque in a joint"; object characteristics computed automatically [R60].
- **Create Trace Spline** (Results tab > Review): trace a point/circle relative to a part, producing a 2D or
  3D spline (cam/slot design) [R60]. Adams PostProcessor for plotting/animation (named in [R60]).
- **Adams Engine gas force vs crank angle**: NOT FOUND in official Hexagon documentation (no Adams Engine
  guide reachable). Secondary literature (search results only, not fetched): ADAMS/Engine used to derive
  crankshaft torsion and main-bearing reactions from piston gas forces; gas-force spline per cylinder with
  phase shift; measured cylinder pressure as input (uncertain, secondary).

---

## 8. RecurDyn (FunctionBay) — includes a dedicated engine toolkit

- **RecurDyn/Crank** toolkit: system builder; geometries engine block, crankshaft, conrod, piston pin,
  piston, flywheel, torsional damper, balancing shaft; connecting elements **bearing** (bushing, EHD,
  constraint, ball), engine mount, **piston liner connector** (constraint / cylinder contact / surface
  contact), piston lubrication, **gas force**, balancing screw coupler; workflow: pre-global data ->
  global data (cylinder layout) -> Component Builder -> values -> build -> run [R61].
- **Gas Force**: "defined with two bodies ... between a cylinder (an engine block) and a piston. This force
  occurred at a firing angle." Properties: **Angle Offset** of the profile, **No. of Cycles**, **Scale
  Factor** on pressure, **Area** (Calc. button computes it), **Use Step**, **Profile** grid editable with a
  Gas Force Profile Editor (Draw), import/export of profile data, "Applied on the Only Action Body (usually
  piston)" [R62]. (Units / pressure-vs-crank-angle axis convention not stated — uncertain; the
  per-cylinder angle offset strongly suggests a pressure-vs-crank-angle profile.)
- Balancing screw coupler documents its torque law T1 = [K(-Ratio*th1 - th2) + C(...)]*Ratio and reaction
  force components [R65].
- Redundancy: solver option **Check Redundant**: "Every Step" (default) or "Once at Simulation Start";
  option **Stop Simulation when Occurring Redundant Constraint**; "Show Warning Message" to the Message
  Window [R63]. FAQ: redundant constraints are common (two fixed joints on one body = 6 redundant); "The
  solver removes them automatically, but the results may not match what you intended"; replace joints by
  stiff bushings (~1e5) [R64].
- Siemens shipped "NX Motion Simulation-RecurDyn": clearance checking, graphs, movie, spreadsheet-driven
  articulation, load transfer to structural simulation, motion envelopes [R44].

---

## 9. Simscape Multibody (MathWorks)

- Closed loops are handled by **cut joints**: "Joints removed to open the model's closed kinematic loops.
  The number of cut joints equals the number of closed loops present in the system." A cut joint
  contributes "six minus the DOF it provides" position constraint equations [R66].
- Model statistics: tree DOF, tree joint DOF, cut joints, constraints, **position constraint equations
  (total)** and **(non-redundant)** — "Simscape Multibody tries to remove redundant equations"; **Mechanism
  degrees of freedom (minimum)** = unconstrained DOF minus non-redundant equations (a lower bound because
  some equations become redundant only in certain configurations); average DOF in kinematic loops [R66].
- Four-bar example: four revolute joints; ground replaced by two rigidly connected pivots to World; state
  targets for assembly checked in Variable Viewer (green = met precisely, yellow = approximately);
  Mechanics Explorer shows assembly and 3D animation [R67].
- KinematicsSolver: general closed-loop problems with multiple targets; ignores contacts, limits,
  actuation; statusFlag 1 = all constraints and targets satisfied; returns a kinematically feasible state
  if targets cannot all be met [R68].
- Sensing: joint motion; **actuation**, **constraint** and **total** force/torque between base and
  follower frames; prescribe a trajectory and sense joint actuation forces (inverse pattern) [R69].
- Gas force: no engine block found (would be an external force from a lookup table — inference).

---

## 10. Cross-vendor confirmations (Altair Inspire / MotionSolve, bonus)

- Gruebler "Moving Parts DOF - Constrained DOF = Total System DOF"; door +6 - 5 - 5 = -4; alert title
  "Model May Be Overconstrained"; solver removes redundant equations "semi-random"; removed DOF report no
  reaction; remedies flexible joints, flexible bodies, contact, "virtual joints" [R70].
- MotionSolve warning header "WARNING: The following redundant constraints were removed:" then one line per
  removed equation, e.g. "Joint/301004 : DOT1 between X of Part/30101 & Z of Part/30103" (DOT1/DOT2
  perpendicularity, SPH_X/Y/Z coincidence, DIST distance); removed constraint forces reported as zero and
  others may be unrealistically high [R71].

---

## 11. Cross-product patterns (synthesis)

1. **Same assembly, motion layered on top**: SOLIDWORKS reuses mates; NX/Simcenter and CATIA convert
   assembly constraints to joints; Fusion joints are the assembly relationships [R18][R43][R32][R50].
2. **DOF accounting is universal; redundancy is tolerated but flagged**: every dynamic solver (SW Motion,
   Adams, RecurDyn, Simscape, MotionSolve, Creo) auto-removes redundant constraint equations, keeps motion
   correct, and makes reactions at removed directions zero/non-unique [R3][R5][R59][R64][R66][R71][R36].
   Closed loops of revolutes are the canonical source (four-bar: 3 redundant in SW; Adams messages).
3. **Kinematic (DOF=0) vs dynamic**: CATIA requires commands == DOF ("mechanism can be simulated");
   Adams calls a zero-DOF run "kinematic" and still computes reactions; Creo separates position/kinematic
   from dynamic/static/force-balance analyses [R21][R22][R59][R38].
4. **Drivers**: position/velocity/acceleration motors (servo) vs force/torque motors; function builders
   with data points vs time / cycle angle / another result [R6][R7][R41][R44].
5. **Engine gas force**: only RecurDyn/Crank documents a first-class gas-force element (cylinder<->piston,
   profile, angle offset per cylinder, area, scale) [R62]; others use a generic action-reaction force with
   a tabulated function [R7][R4].
6. **Interference during motion**: frame range + increment, per-hit frame/time/parts/volume (SW); stop on
   clash (CATIA, KIN); one-set/two-set (NX); playback interference (Creo) [R11][R28][R45][R39].
7. **Packaging outputs**: trace path/curve and swept volume / motion envelope saved as geometry
   [R8][R32][R39][R48][R60].
8. **Load hand-off to FEA**: SW Motion -> Simulation automatic loads; Simcenter load transfer; RecurDyn
   load transfer; Creo connection-reaction for bearing rating [R12][R48][R44][R42].
9. **Review UX**: timeline + time bar (SW), VCR buttons + step counts (CATIA), live strip charts (Adams),
   graph synchronized with animation (Simcenter), sensors with max/min/RMS criteria and alerts (SW) or
   result measures compared to requirements (Simcenter) [R14][R25][R60][R43][R9].

---

## References (all accessed 2026-10)

- [R1] Redundant Mates (2024) — Dassault Systèmes SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_Redundant_Mates_SWMotion.htm (accessed 2026-10)
- [R2] Introduction to Motion Studies — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_Introduction_to_Motion_Studies.htm (accessed 2026-10)
- [R3] Degrees of Freedom / Checking Degrees of Freedom and Redundancies — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_degrees_freedom_motion.htm (accessed 2026-10)
- [R4] Motion Study Properties PropertyManager — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/HIDD_MOTION_STUDY_PROPERTIES.htm (accessed 2026-10)
- [R5] Redundant Mate Force Results — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_redundant_mate_force_results.htm (accessed 2026-10)
- [R6] Motor PropertyManager — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/HIDD_DVE_AEMSIM_MOTORS_NEW.htm (accessed 2026-10)
- [R7] Force PropertyManager — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/HIDD_DVE_SIM_FORCE.htm (accessed 2026-10)
- [R8] Categories and Subcategories for Motion Analysis Results — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/r_cats_subcats_motion_results.htm (accessed 2026-10)
- [R9] Results PropertyManager (Motion Analysis only) — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/HIDD_DVE_COSMOS_RESULTS.htm (accessed 2026-10)
- [R10] Detecting Interference — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/t_detecting_interference_motion.htm (accessed 2026-10)
- [R11] Find Interferences Over Time Dialog Box — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/HIDD_INTERFERENCE_CHECK_DLG.htm (accessed 2026-10)
- [R12] Stress Analysis for Motion — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_stress_analysis_motion.htm (accessed 2026-10)
- [R13] Motion Study Troubleshooting — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_motion_study_troubleshooting.htm (accessed 2026-10)
- [R14] MotionManager Interface — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_MotionManager_Interface.htm (accessed 2026-10)
- [R15] Exporting a Motion Study to ADAMS — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/t_exportingtoadams_motion.htm (accessed 2026-10)
- [R16] Advanced Motion Analysis Options Dialog Box — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/HIDD_MOTION_STUDY_CM_ADV_OPTS.htm (accessed 2026-10)
- [R17] Component Contact — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_component_contact.htm (accessed 2026-10)
- [R18] Motion Analysis Overview — SOLIDWORKS Help — https://help.solidworks.com/2024/english/SolidWorks/motionstudies/c_Motion_Analysis.htm (accessed 2026-10)
- [R19] Using Mates for Motion Analysis Studies — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_Mates_Motion_Analysis_Studies.htm (accessed 2026-10)
- [R20] Motor and Force Profiles — SOLIDWORKS Help — https://help.solidworks.com/2024/English/SolidWorks/motionstudies/c_motor_force_profiles.htm (accessed 2026-10)
- [R21] DMU Kinematics Simulator Glossary (V5 user guide, mirror) — Dassault Systèmes doc via catiadoc.free.fr — http://catiadoc.free.fr/online/kinug_C2/kinuggl.htm (accessed 2026-10)
- [R22] Accessing Command Value Sense of Motion — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0513.htm (accessed 2026-10)
- [R23] Analyzing a Mechanism — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugat0200.htm (accessed 2026-10); also Importing a Mechanism and its Dressup — http://catiadoc.free.fr/online/kinug_C2/kinugat0902.htm and More about Importing Mechanisms Dressup — http://catiadoc.free.fr/online/kinug_C2/kinugat0904.htm (DOF=0 labels)
- [R24] Simulating with Commands — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0202.htm (accessed 2026-10); "The mechanism can be simulated" messages also in http://catiadoc.free.fr/online/kinug_C2/kinugbt0703.htm , kinugbt0604.htm , kinugbt0610.htm
- [R25] Simulating with Laws — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0201.htm (accessed 2026-10)
- [R26] Using Sensors — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugat0105.htm (accessed 2026-10)
- [R27] Detecting Clashes in V5 — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugat0108.htm (accessed 2026-10)
- [R28] Detecting Clashes Automatically in V5 — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0305.htm (accessed 2026-10)
- [R29] Defining Commands — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0504.htm (accessed 2026-10); Defining a Fixed Part — http://catiadoc.free.fr/online/kinug_C2/kinugbt0503.htm
- [R30] Mechanism Analysis (swept volume requires DMU Space Analysis) — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugat2000.htm (accessed 2026-10)
- [R31] Plotting Instantaneous Vectors — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugat2400.htm (accessed 2026-10)
- [R32] DMU Kinematics Simulator 2 (KIN) — Dassault Systèmes 3DSwym CATIA user community wiki — https://3dswym.3dexperience.3ds.com/wiki/catia-user-community/dmu-kinematics-simulator-2-kin_5TFJgAkXQbuBy3zwMAj1dg (accessed 2026-10)
- [R33] APAR HD68393 (DMU KIN simulation does not move; info window "The mechanism can be simulated") — IBM Support — https://www.ibm.com/support/pages/apar/HD68393 (accessed 2026-10)
- [R34] About Joints — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0506.htm (accessed 2026-10)
- [R35] Recording Positions — CATIA V5 KIN guide (mirror) — http://catiadoc.free.fr/online/kinug_C2/kinugbt0302.htm (accessed 2026-10)
- [R36] About Redundancies — PTC Creo Help — https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/simulate/mech_des/connections/dof_redundancies.html (accessed 2026-10)
- [R37] Motion Analysis (tutorial) — PTC Creo Help — https://support.ptc.com/help/creo/creo_pma/r11.0/usascii/tutorials_pma/motion_analysis.html (accessed 2026-10)
- [R38] Mechanism Design Kinematics Workflow — PTC Creo Help — https://support.ptc.com/help/creo/creo_plus/usascii/simulate/mech_des/mdx_kin_workflow.html (accessed 2026-10)
- [R39] About Playback — PTC Creo Help — https://support.ptc.com/help/creo/creo_plus/usascii/simulate/mech_des/about_playback.html (accessed 2026-10)
- [R40] Tip: Fixing a Failed Assembly — PTC Creo Help — https://support.ptc.com/help/creo/creo_pma/r13/usascii/simulate/mech_des/fix_failed_assmb.html (accessed 2026-10)
- [R41] To Use Servo Motors in Mechanism Dynamics — PTC Creo Help — https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/simulate/mech_des/overview/using_servos_mdo.html (accessed 2026-10)
- [R42] About Connection Reaction Measures — PTC Creo Help — https://support.ptc.com/help/creo/creo_plus/usascii/simulate/mech_des/conn_reaction_measures.html (accessed 2026-10)
- [R43] Simcenter 3D Motion Modeling fact sheet — Siemens PLM (hosted by Emixa) — https://www.emixa.com/hubfs/Emixa/Marketing/PDF%20downloads%20-%20Siemens%20PLM/Simcenter-3D-Motion-Modeling-Fact-Sheet.pdf (accessed 2026-10)
- [R44] NX Motion Simulation-RecurDyn fact sheet — Siemens PLM (hosted by CES Grauer) — https://ces-grauer.de/wp-content/uploads/2015/11/NX_Motion_Simulation.pdf (accessed 2026-10)
- [R45] Interference during motion (Siemens PM answer quoting NX 11 docs) — Siemens Community — https://community.sw.siemens.com/s/question/0D54O000061xnSVSAY/interference-during-motion (accessed 2026-10)
- [R46] Simcenter 3D Motion and NX Motion - How to run Motion Articulation solutions — Siemens Community — https://community.sw.siemens.com/s/article/Simcenter-3D-Motion-and-NX-Motion-How-to-Motion-Articulation (accessed 2026-10)
- [R47] Using Constraint Optimization in Simcenter 3D Motion — Siemens Community — https://community.sw.siemens.com/s/article/Using-Constraint-Optimization-in-Simcenter-3D-Motion (accessed 2026-10)
- [R48] Simcenter 3D for motion simulation — Solution Guide — Siemens (hosted by Maya HTT) — https://www.mayahtt.com/brochures/Siemens%20SW%20Simcenter%203D%20for%20motion%20simulation%20Solution%20Guide.pdf (accessed 2026-10)
- [R49] Siemens Xcelerator Academy: Simcenter 3D Motion course — Siemens — https://training.plm.automation.siemens.com/ilt/iltdescription.cfm?pID=LMSTRCL-B-3D-MS3D__2212.00B1019 (accessed 2026-10)
- [R50] Assembly relationships — Autodesk Fusion Help — https://help.autodesk.com/view/fusion360/ENU/?guid=ASM-JOINTS (accessed 2026-10)
- [R51] Motion studies — Autodesk Fusion Help — https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-1B0EEBBF-3923-47E3-BB58-E5955D9EA738 (accessed 2026-10)
- [R52] Motion Study reference — Autodesk Fusion Help — https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-6FEC8081-9E93-4A5F-B31E-8B7AA86790F6 (accessed 2026-10)
- [R53] Motion Link reference — Autodesk Fusion Help — https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-074622A9-EC62-4A2E-9BBC-DB61748C869F (accessed 2026-10)
- [R54] Drive Joints reference — Autodesk Fusion Help — https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-5C53B081-B3A1-4D2C-8929-9494A9DD08F0 (accessed 2026-10)
- [R55] Contact sets — Autodesk Fusion Help — https://help.autodesk.com/view/fusion360/ENU/?guid=ASM-CONTACT-SETS (accessed 2026-10)
- [R56] Mates — Onshape Help — https://cad.onshape.com/help/Content/Assembly/mates.htm (accessed 2026-10)
- [R57] Mate relations — Onshape Help — https://cad.onshape.com/help/Content/Assembly/relations.htm (accessed 2026-10)
- [R58] Simulation — Onshape Help — https://cad.onshape.com/help/Content/simulation.htm (accessed 2026-10)
- [R59] Adams 2021.0.2 Adams Solver User's Guide (PDF) — Hexagon — https://help-be.hexagonmi.com/bundle/Adams_2021.0.2_Adams_Solver_User_Guide/raw/resource/enus/Adams_2021.0.2_Adams_Solver_User_Guide.pdf (accessed 2026-10)
- [R60] Adams 2021.0.2 Adams View User's Guide (PDF) — Hexagon — https://help-be.hexagonmi.com/bundle/Adams_2021.0.2_Adams_View_User_Guide/raw/resource/enus/Adams_2021.0.2_Adams_View_User_Guide.pdf (accessed 2026-10)
- [R61] 32. Crank (RecurDyn Help 2023) — FunctionBay — https://dev.functionbay.com/RecurDynOnlineHelp/2023/Crank/Crank_ch00_index.html (accessed 2026-10); Connecting Entities — https://dev.functionbay.com/RecurDynOnlineHelp/2023/Crank/Crank_ch03_s00_index.html
- [R62] 32.3.4 Gas Force (RecurDyn Help 2023) — FunctionBay — https://dev.functionbay.com/RecurDynOnlineHelp/2023/Crank/Crank_ch03_s04_00_index.html (accessed 2026-10)
- [R63] 3.5.7.1 General Page (Simulation dialog) — FunctionBay RecurDyn Help 2023 — https://dev.functionbay.com/RecurDynOnlineHelp/2023/Home/Home_ch05_s07_01.html (accessed 2026-10)
- [R64] FAQ: Can remove redundant constraints? — FunctionBay Technical Support — https://support.functionbay.com/en/faq/single/267/can-remove-redundant-constraints (accessed 2026-10)
- [R65] 32.3.5 Balancing Screw Coupler — FunctionBay RecurDyn Help 2023 — https://dev.functionbay.com/RecurDynOnlineHelp/2023/Crank/Crank_ch03_s05_00_index.html (accessed 2026-10)
- [R66] 3-D Multibody System Statistics — MathWorks Simscape documentation — https://www.mathworks.com/help/simscape/ug/3-d-multibody-system-statistics.html (accessed 2026-10)
- [R67] Model a Four-Bar Linkage — MathWorks Simscape Multibody documentation — https://www.mathworks.com/help/sm/ug/model-four-bar.html (accessed 2026-10)
- [R68] simscape.multibody.KinematicsSolver — MathWorks — https://www.mathworks.com/help/sm/ref/simscape.multibody.kinematicssolver.html (accessed 2026-10)
- [R69] Sensing — MathWorks Simscape Multibody documentation — https://www.mathworks.com/help/sm/ug/sensing.html (accessed 2026-10)
- [R70] Redundant Constraints — Altair Inspire Help — https://help.altair.com/inspire/en_us/topics/inspire/motion/redundant_constraints_r.htm (accessed 2026-10)
- [R71] Model Constraints — Altair MotionSolve Help 2024 — https://2024.help.altair.com/2024/hwsolvers/ms/topics/solvers/ms/modeling_constraints.htm (accessed 2026-10)

### Gaps / not reached
- Official Siemens NX/Simcenter help on redundant constraints, Gruebler messages, joint reactions: login-gated.
- Official Adams Engine (cylinder pressure vs crank angle) documentation: not reachable; only secondary papers via search.
- Official 3DEXPERIENCE (Mechanical Systems Experience) help: login-gated; V5 KIN guide used instead.
- PTC KB CS37579 (trace curve and motion envelope steps): HTTP 403.
- Javelin and Autodesk Learn tutorials: HTTP 403.
