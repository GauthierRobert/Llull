# Viewport interaction (UI behaviour)

Presentation only: every change still goes through one registered command (`store.dispatch`).

## Live previews and drag handles (SC-A2)

- **Preview** = the command with the current params run on the current document through the same `execute`
  (pure, so nothing is mutated) by `src/ui/preview/`. The result entities are drawn as a translucent ghost
  (`PreviewLayer`), the entities the command would replace fade. Debounced (120 ms), a newer request cancels the
  older one, and **nothing is dispatched until the user commits**.
- **Command palette dialogs** preview automatically for any mutating, non-destructive command with a numeric
  field (extrude depth, fillet radius, shell thickness, move distance, ...). A refused preview shows the command's
  own refusal under the fields ("Preview unavailable ...").
- **Handles**: select one sketch profile (circle, rectangle, ellipse, polyline, spline) and press **Extrude**, or
  one solid and press **Fillet** / **Shell** (chips at the top right of the 3D view). An arrow handle appears:
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
