# UX-1 — A discoverable shell (2026-11-18)

Owner request: review the front end and make the app as intuitive as possible, taking the CAD tools released in the last years
(Shapr3D, Onshape, Plasticity) as references rather than the legacy ones.

## What the review found

The "Lens" shell was clean but **over-minimal**: it hid the product behind three unlabelled entry points.

| #   | Finding                                                                                                                                            | Effect on a newcomer                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Every tool sat behind one unlabelled `+` button; the bar itself only said "Search or run a command".                                               | "How do I draw / add a box?" has no visible answer. |
| 2   | No modelling operation (extrude, revolve, fillet, boolean, mirror, pattern, measure) was visible anywhere except by searching 1158 commands.       | The core CAD loop is undiscoverable.                |
| 3   | What a selection offers was split in three places: icon-only buttons in the dark bar, text chips at the top right of the view, the context menu.   | Select something, then look around the screen.      |
| 4   | The 3D / 2D switch lived inside the Tools panel.                                                                                                   | After arming a sketch tool, no visible way back.    |
| 5   | The palette opened on the full catalog in registry order, whatever was selected.                                                                   | Search requires knowing the command's name.         |
| 6   | The start card led with the CLI route and five equal chips.                                                                                        | No "what do I do first", no navigation help.        |
| 7   | Ctrl A selected the interface text; a second solid could be dropped outside the view; the first solid filled the whole viewport (fit padding 1.2). | Small "is it broken?" moments.                      |

## What the references do

- **Shapr3D** (adaptive UI): the interface is built "around your implicit and explicit actions": selecting a sketch surfaces Extrude,
  a face Offset, two bodies the booleans. Its own users asked that tools stay predictable instead of vanishing, hence fixed anchors
  next to the adaptive part.
- **Onshape** (UX principles): minimal UI per operation, non-blocking feedback, whitespace over decoration, no jargon.
- **Plasticity**: very fast for palette / hotkey users, and criticised for exactly that: commands "behind a wall" for people who do
  not know their names. A palette is a complement to visible tools, not a replacement.
- Common to all: selection-driven contextual actions, direct manipulation on the model, few permanently visible but **named** tools.

## Decision

1. **Fixed anchor: the command bar names its tool families** (`Select · Sketch · Solid · Modify · Inspect · Search · Undo/Redo`).
   Each family opens a flyout of labelled tiles; the footer says what the pointed tool does. Never an unlabelled entry point.
2. **Adaptive part: one selection bar** above the command bar holds everything the selection offers, features first
   (Extrude / Fillet / Shell / Edit faces / Union / Subtract / Intersect), in words. The top-right chips are gone.
3. **Modify and Inspect are views over the registry** (L5): a tile opens the command's generated form with the selection (and, for the
   booleans, the operation and operands) filled in. No new command, no bypass (L1): `toolbar/commandTools.ts` is presentation data.
4. **The palette answers "what can I do with this?"**: an empty query starts with suggestions for the selection.
5. **The view switch and Help are always visible** in the header.
6. **The start card teaches the two ways to begin** (sketch → extrude, or drop a solid) and how to move around the view.
7. Ctrl A, F (zoom to fit), keep-in-view after a UI-created solid, and a roomier automatic framing (padding 1.7).

## Not done here (next candidates)

- The 2D modify palette (left of the 2D view) duplicates Modify › Edit a sketch; it stays because it hosts the value input.
- Command descriptions in the palette are written for agents (long, technical); a short human line per command would need a
  `summary` field on `defineCommand` (core, Lane 1).
- `tests/e2e` (legacy browser Playwright, LC1) still targets the old `Tools` button; it is not part of `npm run check`.

Sources: Shapr3D "Behind the user interface refresh" and "Adaptive user interface" (help center), Onshape "The 10 guiding principles
for improving UX", Creative Bloq review of Plasticity, NOVEDGE "How modern UX is reducing CAD learning curves".
