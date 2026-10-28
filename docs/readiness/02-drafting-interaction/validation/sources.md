# UXD — sources (all accessed 2026-10-28)

Access method: **DL** = downloaded and read (sha256 recorded, file not redistributed); **WF** = page fetched and read through the
research fetch tool; **SR** = search-engine extract of the page only (never gates). Grades as in
[`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md): **A** primary source read, reference code run, or ≥ 2 independent sources
agree; **B** one secondary extract; **C** located, content not confirmed. Only grade A values, closed forms and spec budgets gate.
Vendor behaviour (AutoCAD, BricsCAD, SOLIDWORKS, Fusion, Onshape, Revit) is used to define **what** llull must offer; the pass /
fail values of the cases are closed forms on llull's own fixture or budgets of this spec, so a grade B vendor page never decides a
result.

## 1. Incumbent behaviour (2D drafting)

| Id | Source | URL | Method | Taken | Grade |
| -- | ------ | --- | ------ | ----- | ----- |
| R1 | AutoCAD 2025 Help, *To Manage Command Aliases* | https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Customization/files/GUID-D4CACED6-DFBA-43C3-BC42-8D980AB3AE75.htm | SR | aliases in acad.pgp / acadlt.pgp, plain-text editable, `abbreviation,*command`, `;` comments, REINIT reload; user edits go to acaduser.pgp in recent releases | A with R2 (syntax); B otherwise |
| R2 | L. Ambrosius (Autodesk, Inc.), *AutoCAD Customization Boot Camp: Basic*, AU class AS468502-L | https://static.au-uw2-stg.autodesk.com/AS468502-L_Optional_Additional_Class_Materials_AS468502L_Lee_Ambrosius.pdf | DL, sha256 `ee88aaf16e5a139db7dc547fd6b9002f7df09ac3f99fb7cad67a956defdacb21` | "the Command prompt remains the fastest and most efficient way to execute a command"; syntax `abbreviation, *command`; examples `C, *CIRCLE` `E, *ERASE` `L, *LINE` `P, *PAN` `Z, *ZOOM`; "the last definition … is the one loaded"; aliases cannot carry options or values | A |
| R3 | AutoCAD LT 2026 Help, *Object Snap Tab (Drafting Settings Dialog Box)* | https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-50383F73-4F23-4F70-B4FC-52D5748D80AF.htm | WF | 14 running modes: Endpoint, Midpoint, Center, Geometric Center, Node, Quadrant, Intersection, Extension, Insertion, Perpendicular, Tangent, Nearest, Apparent Intersection, Parallel; Select All / Clear All; Object Snap On (OSMODE); Object Snap Tracking On (AUTOSNAP); TAB cycles | A |
| R4 | AutoCAD LT 2018 Help, *Function Key Reference*; AutoCAD 2025 Customization *Shortcut keys* | https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-LT/files/GUID-ACAA0279-047D-458E-889F-60BBFDD40489.htm ; https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Customization/files/GUID-B6A9C126-230D-47F5-8973-464BC80E3736.htm | SR | F3 object snap, F8 ortho, F10 polar, F11 object snap tracking, F12 dynamic input; F8 and F10 mutually exclusive | B |
| R5 | AutoCAD 2024 Help, *Coordinate Entry with Dynamic Input*; AutoCAD LT 2021 *Pointer Input Settings* | https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DidYouKnow/files/GUID-683349C0-E5C2-4E16-8846-5523E71172A9.htm ; https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-LT/files/GUID-F18D7834-44D2-4301-A5BC-768594D6C30F.htm | SR | with Dynamic Input, second and later points default to relative (no `@` needed); `#` forces absolute (`#0,0`); `<` switches to polar, `,` to Cartesian; DYNPIFORMAT / DYNPICOORDS | B |
| R6 | AutoCAD LT 2026 Help, *SELECT (Command)* | https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-0DD5DA73-9DC5-4424-8FED-7BBE3BE52A4D.htm | SR | corners left→right = window (fully inside), right→left = crossing (inside or touching); lasso; Spacebar cycles Window / Crossing / Fence during lasso | B |
| R7 | AutoCAD LT 2016 Help, *SELECTIONCYCLING (System Variable)*; LT 2021 *Selection Cycling Tab* | https://help.autodesk.com/cloudhelp/2016/ENU/AutoCAD-LT/files/GUID-08FA6975-49A7-4029-A3F3-ABDA3B2A7122.htm ; https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-LT/files/GUID-BD08721C-A2BB-472E-B706-B3E6DC8FCEC7.htm | SR | Shift+Space cycles overlapping objects; 0 off / 1 badge / 2 badge + list | B |
| R8 | AutoCAD Help, *To Modify Polylines With Grips*; *The Stretch and Lengthen Commands* (Did You Know) | https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-LT-MAC/files/GUID-2070C02C-E18A-4333-BDC4-240F49F1C102.htm ; https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DidYouKnow/files/GUID-19FDC9E4-049E-40BA-AB6D-58A4C2557570.htm | SR | hover a polyline vertex grip → Stretch Vertex / Add Vertex / Remove Vertex; endpoint grip of line / arc → Stretch / Lengthen | B |
| R9 | AutoCAD repeat and transparent commands: CMU course chapter; Autodesk community reply | https://www.andrew.cmu.edu/course/48-568/PDFs/AutoCAD2D/Chapter14.pdf ; https://forums.autodesk.com/t5/autocad-forum/command-interrupt-not-working/m-p/10161442/highlight/true | SR | Enter / Space / right-click at the Command prompt repeats the last command; `'ZOOM` runs transparently inside LINE (only some commands) | C |
| R10 | AutoCAD LT 2016 Help, *QPMODE*; *Quick Properties Tab* | https://help.autodesk.com/cloudhelp/2016/ENU/AutoCAD-LT/files/GUID-1803CDBC-C0C9-4AB9-B76B-FF6AB214D97B.htm ; https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-5D1EA6CC-2F6A-42D2-B49F-6F1B2634E32D.htm | SR | Quick Properties palette on selection: 0 off / 1 all / 2 configured types | B |
| R11 | AutoCAD LT 2021 Help, *Property Settings Dialog Box* (MATCHPROP) | https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-LT/files/GUID-E228268B-F773-4911-9E61-588155B1B2C9.htm | SR | chooses which properties MATCHPROP copies from the source to the destinations | B |
| R12 | AutoCAD LT 2026 Help, *To Work With Layer States* / *Layer States Manager* | https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-CD3DA238-70EE-4931-815C-34BED7227BE2.htm | SR | save, restore, edit, import, export named sets of layer settings; choose which properties restore | B |
| R13 | AutoCAD LT Help, *To Work With the Command Line Suggestion List*; *Input Search Options* | https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-74478DCE-92D4-49B1-93E9-DCF09D57FA0D.htm ; https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-3179393F-958F-42EA-8A92-E9975A1D160B.htm | SR | AutoComplete (prefix and mid-string), AutoCorrect, synonym search, named-object search at the command line | B |
| R14 | BricsCAD V12 / V16 Help, *The Quad cursor menu* | https://developer.bricsys.com/bricscad/help/en_US/V16/UsrGui/source/03_Drawing_Accurately/03_12_Quad.htm | SR | hover menu as an alternative to grip editing; content depends on the entity under the cursor; QuadShowDelay default 500 ms (V12) | B |
| R15 | BricsCAD Help, *Entity snap tracking* | https://help.bricsys.com/en-us/document/bricscad/drawing-accurately/entity-snap-tracking | SR | STRACK needs ≥ 1 entity snap; tracking lines parallel to UCS X / Y | B |
| R22 | Revit LT Help, *About Temporary Dimensions* | https://help.autodesk.com/cloudhelp/2023/ENU/RevitLT-DocumentPresent/files/GUID-74FFB00B-FB29-44B7-8FEA-613DBE010AD4.htm | SR | listening dimension while placing; a value typed during placement sets it; snap increment follows zoom | B |

## 2. Incumbent behaviour (3D modelling, navigation)

| Id | Source | URL | Method | Taken | Grade |
| -- | ------ | --- | ------ | ----- | ----- |
| R16 | SOLIDWORKS 2024 Help, *Shortcut Bars* | https://help.solidworks.com/2024/English/SolidWorks/Sldworks/Chunk150219028.htm | SR | S key opens a customisable shortcut bar; four versions (part, assembly, drawing, sketch); the key itself is rebindable | B |
| R17 | SOLIDWORKS 2023 Help, *Mouse Gestures* | https://help.solidworks.com/2023/english/SolidWorks/sldworks/c_mouse_sestures.htm | SR | right-drag gestures; guide with 2, 3, 4, 8 or 12 directions; default 4 | B |
| R18 | SOLIDWORKS Help, *Inferencing*; *Using Automatic Relations* | https://help.solidworks.com/2017/English/SolidWorks/acadhelp/c_Inferencing.htm ; https://help.solidworks.com/2015/English/SolidWorks/sldworks/t_Using_Automatic_Relations.htm | SR | dotted inference lines; relations added while sketching; Ctrl held suppresses; clearing snapping clears automatic relations | B |
| R19 | SOLIDWORKS 2025 Help, *Rollback Bar* | https://help.solidworks.com/2025/English/SolidWorks/Sldworks/c_rollback_bar.htm | SR | drag the bar to roll the model back; features can be added while rolled back; Roll to End; saved with the bar in place | B |
| R20 | Autodesk Fusion blog, *Pan, Zoom, Orbit preferences* | https://www.autodesk.com/products/fusion-360/blog/quick-tip-pan-zoom-orbit-preferences/ | SR | presets Fusion (default: middle = pan, Shift+middle = orbit, wheel = zoom), SolidWorks, Inventor, Tinkercad, Alias, PowerMill; sources disagree on Inventor F2/F3/F4 | B |
| R21 | Onshape Help, *Keyboard Shortcuts and Hotkeys* | https://cad.onshape.com/help/Content/shortcut_keys.htm | SR | every shortcut customisable (general, Part Studio, assembly, 3D view, sketch, drawing), edit / disable / reset one / reset all | B |
| R23 | 3Dconnexion, *Certification Requirements* (Aug 2020) | https://3dconnexion.com/uk/wp-content/uploads/sites/1/2020/08/3Dconnexion-Certification-Requirements.pdf | DL, sha256 `c0bcfc00039e6df3bedfc5b65950d9db1946fd125763b8a066544fe1ab423b62` | protocol: Navigation Library or 3DconnexionJS, SDK ≥ 4.0; frame rate during SpaceMouse navigation similar to 2D-mouse manipulation; centre of rotation visualised; enabled by default; all commands exported through the action interface; standard buttons Fit, Front / Top / Iso, custom views, QuickZoom | A |
| R24 | 3Dconnexion, *Software Developer Program* | https://3dconnexion.com/au/?p=3174 | SR | free developer program, SDKs for Windows and macOS | B |

## 3. HCI evidence

| Id | Source | URL | Method | Taken | Grade |
| -- | ------ | --- | ------ | ----- | ----- |
| R25 | D. Kieras, *Using the Keystroke-Level Model to Estimate Execution Times*, University of Michigan, 1993 | https://www.cs.umd.edu/~golbeck/INST631/KSM.pdf | DL, sha256 `57e0bcde6ba4b66421605adc62528ee572cbd7afc79d6cbe255262132b841c02` | K .12–1.2 s, .28 recommended; K .20 average skilled typist; P 1.1 s (range .8–1.5); B .1 s; BB .2 s; H .4 s; M .6–1.35 s, use 1.2 s; W system wait; "Consistency in M placement is more important than absolute accuracy" | A (with R26 for K, P, B, H) |
| R26 | Wikipedia, *Keystroke-level model* | https://en.wikipedia.org/wiki/Keystroke-level_model | WF | same K, P, H, B values; M 1.35 s (CMN); "root-mean-square error of 21%" | B |
| R27 | S. K. Card, T. P. Moran, A. Newell, *The keystroke-level model for user performance time with interactive systems*, CACM 23(7), 1980 | https://doi.org/10.1145/358886.358895 (DOI as listed in R26, not resolved) | located (paywalled) | original model | C |
| R28 | I. S. MacKenzie, *Fitts' law as a research and design tool in human-computer interaction*, HCI 7, 91–139, 1992 | https://www.yorku.ca/mack/hci1992.html | SR | Shannon formulation ID = log2(A/W + 1); throughput as a device metric | B |
| R29 | J. Nielsen, *Response Times: The 3 Important Limits* (NN/g, from *Usability Engineering* 1993) | https://www.nngroup.com/articles/response-times-3-important-limits/ | WF | "0.1 second is about the limit for having the user feel that the system is reacting instantaneously"; 1.0 s flow of thought; 10 s attention | A (primary text read; underlying R30) |
| R30 | R. B. Miller, *Response time in man-computer conversational transactions*, AFIPS FJCC 33, 267–277, 1968 | cited by R29 (no URL checked) | located | origin of the limits | C |
| R34 | T. Grossman, P. Dragicevic, R. Balakrishnan, *Strategies for accelerating on-line learning of hotkeys*, CHI 2007 | https://www.dgp.toronto.edu/~ravin/papers/chi2007_learninghotkeys.pdf | DL, sha256 `08ab3a1fbfe5e0c338f0f7e3ce1268b1acd9a701c1b418cd38a39384d5090326` | "even the simplest keystroke level analysis indicates that using a hotkey will be faster than clicking on an icon"; audio feedback and disabling the menu item "increase hotkey use by over 100%"; HOTKEY USE 70 % audio, 69.2 % disabled, 59.1 % delayed, 57.1 % control, 50 % visual (pilot, 5 participants) | A |
| R35 | D. M. Lane, H. A. Napier, S. C. Peres, A. Sándor, *Hidden costs of graphical user interfaces: failure to make the transition from menus and icon toolbars to keyboard shortcuts*, IJHCI 18(2), 2005 | https://dblp.dagstuhl.de/pid/65/2289.html (bibliographic record) | SR | experienced users rarely used keyboard shortcuts although they were the most efficient method | B |
| R36 | J. Matejka, W. Li, T. Grossman, G. Fitzmaurice, *CommunityCommands: command recommendations for software applications*, UIST 2009 | https://www.research.autodesk.com/people/george-fitzmaurice/ | SR | collaborative-filtering command recommendations from usage logs (AutoCAD) | C |
| R37 | S. Malacria et al., *Skillometers*, UIST 2013 | https://www.research.autodesk.com/?p=2393 | SR | reflective widgets encourage earlier hotkey learning | C |

## 4. Standards

| Id | Source | URL | Method | Taken | Grade |
| -- | ------ | --- | ------ | ----- | ----- |
| R31 | NIST Office of Weights and Measures, *SI Units – Length* | https://www.nist.gov/pml/owm/si-units-length | WF | "The value for the inch, derived from the value of the Yard effective July 1, 1959, is exactly equivalent to 25.4 mm" | A |
| R32 | W3C, *Understanding SC 2.5.7 Dragging Movements* (WCAG 2.2, Level AA) | https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html | WF | "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging, unless dragging is essential…"; example: click one corner then the other instead of dragging a selection rectangle | A |
| R33 | W3C, *What's New in WCAG 2.2* | https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ | SR | 2.4.11 Focus Not Obscured (Minimum) AA; 2.5.7 Dragging Movements AA; 2.1.1 Keyboard (A, unchanged) | B |

## 5. llull measurements and code reads

| Id | What | Method | Result | Grade |
| -- | ---- | ------ | ------ | ----- |
| M1 | `plans/task_fixture.json` on origin/main f1351cff: `llull run … --validate`, then `llull run …` (default document, gitignored `model.llull.json`) | CLI, 2026-10-28 | "Plan valid: 25 step(s) ready"; 25 / 25 steps ok (`line-*`, `poly-*`, `rect-*`, `circ-*`, `box-24.1`, `ext-25.1`) | A |
| M2 | Code audit of `src/ui/**` and the command registry (file paths in TECHNICAL_SPEC §1) | read, 2026-10-28 | the "today" column of the parity checklist and the `baseline` fields of expected_results.json | A |
| M3 | `generate_refs.mjs` run | node, 2026-10-28 | `data/klm_predictions.json`, `expected` fields of `data/coordinate_grammar_cases.json` and `data/snap_cases.json` | A (closed form) |
