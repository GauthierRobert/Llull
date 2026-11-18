# Viewport interaction (UI behaviour)

Presentation only: every change still goes through one registered command (`store.dispatch`).

## Shell: where things are (UX-1)

The rule: **a tool the user needs is visible by name; what a selection can become is offered next to it.** Nothing a newcomer needs
sits behind an unlabelled icon. Rationale and references: `docs/decisions/UX1-discoverable-shell.md`.

- **Command bar** (bottom centre, `components/toolbar/Toolbar.tsx`): `Select`, then the tool families `Sketch`, `Solid`, `Modify`,
  `Inspect` (icon + name + caret), `Search commands` (the palette, Ctrl K) and Undo / Redo. A family opens a flyout of labelled
  tiles with their shortcut key; the flyout footer describes the pointed tool. With one flyout open, pointing at another family
  switches to it. The Sketch button carries the armed draw tool (icon + name); `Select` puts any tool down.
- **Modify / Inspect** list registry commands by plain name (`toolbar/commandTools.ts`): picking one opens that command's generated
  form with the selection filled in (`paletteStore.openCommand(name, presetParams)`); Union / Subtract / Intersect preset `op`, `a`
  (first selected solid) and `b` (the others). Extrude / Fillet / Shell start the drag handle when the sole selection offers it.
- **Selection bar** (above the command bar, only while something is selected, `toolbar/SelectionBar.tsx`): the selection's name or
  count (click to clear), Move / Rotate / Scale, then what THIS selection offers (Extrude for a sketch; Fillet, Shell, Edit faces
  for a solid; Union, Subtract, Intersect for several solids), Duplicate, Hide, Delete and More (the palette).
- **Command palette**: an empty query opens on "Suggested for the selection" (`commandPalette/paletteSuggestions.ts`), then recents,
  then the whole catalog.
- **Header**: left, browser toggle + project › selection; right, the always-visible **3D | 2D** switch, Help (shortcut sheet) and More.
- **Start card** (empty document): Sketch a shape / Drop a solid / Find a command, templates, the agent route, and how to orbit,
  pan, zoom and fit.
- Keys added with it: **Ctrl A** selects everything visible, **F** (3D) zooms to fit. A solid added from the UI keeps the model in
  view (local mode only: online the camera is shared).

## 3D rendering defaults (UX-1)

- **Curved solids** are tessellated with 48 to 128 radial segments (`viewport/3d/lodSegments.ts`): a cylinder reads as round.
- **Feature edges and the selection outline** (`effects/EdgeOverlayPass.ts`) are on by default in Standard up to 200 entities;
  **ambient occlusion** up to 50. Selected solids are also on `SELECTION_LAYER`; the pass draws their outer rim in the selection
  colour over everything, so a part hidden behind another still shows where it is. Low / Draft keep the plain render (emissive tint).
- **Edge quality**: the edge pass averages four sub-pixel evaluations per pixel on a multisampled normal/depth target (normals on
  half-texel arms = one-pixel creases, depth on full-texel arms = slightly heavier silhouettes) and an FXAA pass ends the chain.
  One all-or-nothing evaluation per pixel drew stair-stepped lines of uneven weight.
- **Wire** display mode is a hidden-line view: surfaces are unlit paper in the background colour (`hiddenLineSurface`) and the edge
  pass, forced on, draws the part in the theme's `wireLine` colour. A triangle wireframe showed the tessellation, not the part.
- **Shadows**: the key light's frustum hugs the scene (`keyLightRig.ts`), comes from the front-left of the default view, and a
  shadow catcher on the ground shows its shadow. Softness is three's own PCF blur (`shadowRadius`): drei's PCSS patch produced no
  shadow at all with three r186, where the shadow map is a comparison texture.

## Live previews and drag handles (SC-A2)

- **Preview** = the command with the current params run on the current document through the same `execute`
  (pure, so nothing is mutated) by `src/ui/preview/`. The result entities are drawn as a translucent ghost
  (`PreviewLayer`), the entities the command would replace fade. Debounced (120 ms), a newer request cancels the
  older one, and **nothing is dispatched until the user commits**.
- **Command palette dialogs** preview automatically for any mutating, non-destructive command with a numeric
  field (extrude depth, fillet radius, shell thickness, move distance, ...). A refused preview shows the command's
  own refusal under the fields ("Preview unavailable ...").
- **Handles**: select one sketch profile (circle, rectangle, ellipse, polyline, spline) and press **Extrude**, or
  one solid and press **Fillet** / **Shell** (in the selection bar above the command bar, or under Modify). An arrow handle appears:
  drag it, or type in the on-canvas value box. Releasing the handle or pressing Enter commits ONE dispatch;
  Esc / Cancel discards the preview.
- **Join / cut** for an extrusion that reaches an existing solid: Auto = outward (along the profile normal) joins,
  inward (negative distance) cuts; New / Join / Cut override it. `extrude_profile` has no boolean param, so a
  join / cut commits as a single `build_project` (`extrude_profile` then `boolean`), i.e. one Undo step. The
  body in reach is the first solid whose bounding box meets the swept profile box.
- The preview runs in the renderer with the renderer's kernel (Manifold). Kernel-bound commands (fillet, chamfer,
  shell need the native OCCT kernel) therefore refuse in the preview when that kernel is not installed in the
  renderer; the refusal is shown and the commit button does not dispatch a refused plan.

## 3D mouse (SC-A3, desktop app)

- 3Dconnexion SpaceMouse over **WebHID** (vendor `0x256f`, or `0x046d` for older units, multi-axis controller
  usage). `desktop/src/hid.ts` grants the HID permission to the app origin for those devices only and auto-selects
  one in the picker; the renderer reconnects an already granted device on start and offers **3D mouse** (bottom
  left of the 3D view) to connect and tune it.
- Reports: id 1 translation (or the combined 6-axis report of newer devices), id 2 rotation, id 3 buttons
  (parsed, unused). Defaults: sideways = pan, lift/press = pan up/down, push/pull = dolly, twist = orbit, tilt =
  orbit up/down; roll is unused. Settings (per-axis invert, pan / zoom / orbit speed, dominant-axis only) persist in
  `localStorage` (`llull-spacemouse`). Camera motion goes through the camera bridge (presentation only).
- Not verified on hardware: the axis sign conventions follow the 3Dconnexion HID layout; flip an axis with Invert
  if a device differs.
- **Linux spacenavd is not supported yet.** WebHID reads the hidraw node directly; if `spacenavd` / udev holds it
  the picker lists nothing.

## Reporting an internal failure (SC-A4)

When a command fails INTERNALLY (it threw: `<name> failed: …; document unchanged.` or `Command <name> failed:`, an HTTP 5xx, or a
kernel `OCC_FAILURE` / `PANIC`), the status bar shows **Report this…** next to the summary. Invalid params, guard refusals and
`NATIVE_UNSUPPORTED` ("not supported") are user-facing notices and never offer it (`src/ui/report/classifyFailure.ts`).

The dialog (`ReportIssueDialog`) shows exactly what would be included, all editable: title, description (error, command + params,
llull version, platform) and the **reproducer**, a minimal `build_project` plan (the document recipe up to the failing command, or
the backend crash report when `GET /crashes/latest` has one for this failure). Params are redacted like crash reports (human
signatures dropped, home directory becomes `~`). The reproducer can be unticked; the document itself is never attached.

- **Copy** puts the text on the clipboard; **Save reproducer…** downloads `llull-reproducer.json`; **Open GitHub issue draft**
  opens a prefilled `issues/new?title=&body=` link through `window.open` (the desktop window-open handler routes https links to
  the system browser). llull sends nothing itself and works offline (the crash report fetch is optional).
- The link is capped at 7000 characters: the reproducer, then the description, is cut and the text says to attach the saved file.
