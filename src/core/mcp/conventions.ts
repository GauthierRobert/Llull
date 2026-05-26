/**
 * @layer core/mcp
 *
 * Agent modeling conventions guide — pure, framework-agnostic.
 *
 * This module exports the authoritative guide an MCP agent should read BEFORE
 * modeling. It is exposed as the `cad://conventions` MCP resource.
 *
 * No DOM / fetch / react — this is a pure core module (L2).
 *
 * @pure
 */

// ---------------------------------------------------------------------------
// Convention guide content (text/markdown)
// ---------------------------------------------------------------------------

/**
 * The full modeling conventions guide as a Markdown string.
 *
 * CRITICAL: This is a RESOURCE, not a tool. It must NEVER be added to the
 * command registry. The `buildMcpTools().length === listCommands().length`
 * invariant must hold.
 */
export const CONVENTIONS_GUIDE: string = `# llull CAD — Agent Modeling Conventions

Read this BEFORE creating or editing geometry. It defines the world frame,
anchor points, rotation convention, and the recommended workflow loop.

---

## 1. Units

Every llull document has a \`units\` field (default: \`"mm"\`). All coordinates,
sizes, radii, and heights you pass to commands are in those document units.
Read \`cad://document\` or \`cad://scene\` to check the current units before
placing geometry. Do NOT mix units — if the document is in \`mm\`, a box of
\`size: [1, 1, 1]\` is 1 mm × 1 mm × 1 mm.

Supported units: \`"mm"\`, \`"cm"\`, \`"m"\`, \`"in"\`, \`"ft"\`.

---

## 2. World Frame (right-handed, +Z up)

llull uses a **right-handed coordinate system with +Z pointing up**:

- **+X** → right (East)
- **+Y** → into the screen / forward (North)
- **+Z** → up

The world origin is at \`[0, 0, 0]\`. Ground plane is Z = 0.
Positive Z is above ground; negative Z is below ground.

When \`render_view\` shows the axis triad:
  - Red axis  = X
  - Green axis = Y
  - Blue axis  = Z (up)

---

## 3. Placement Anchor per Primitive

\`position\` is the **anchor point** of each primitive — NOT necessarily a
corner. Knowing the anchor lets you place objects without offset math errors.

| Command         | \`position\` anchor                              |
| --------------- | ----------------------------------------------- |
| \`add_box\`       | **center** of the box (centroid of all 8 corners) |
| \`add_cylinder\`  | **center** (geometric center; spans ±height/2 about position) |
| \`add_sphere\`    | **center** of the sphere                         |
| \`add_cone\`      | **base-center** (center of the bottom circle)    |
| \`add_torus\`     | **center** of the torus (center of the donut hole) |
| \`add_wedge\`     | **lower-front-left corner** of the bounding box  |
| \`add_pyramid\`   | **base-center** (centroid of the rectangular base) |
| \`extrude_profile\` | **origin** of the 2D profile in the XY plane  |

**Common pitfall**: center-anchored primitives are half-buried at \`position[2] = 0\`.
To sit them ON the ground (Z=0), set \`position[2]\` to half their height:
\`add_box\` → \`size[2] / 2\`, \`add_cylinder\` → \`height / 2\`, \`add_sphere\` → \`radius\`.
Only \`add_cone\` is base-anchored, so \`position[2] = 0\` already places its base ON
the ground (apex at \`+height\`).

---

## 4. Rotation Convention

\`rotation\` is an **Euler XYZ tuple in RADIANS**, not degrees.

\`\`\`
rotation: [rx, ry, rz]   // XYZ Euler, radians
\`\`\`

- \`[0, 0, 0]\` = no rotation (default orientation)
- \`[0, 0, Math.PI / 2]\` = 90° rotation around Z axis
- To convert degrees to radians: \`radians = degrees * Math.PI / 180\`

**Common pitfall**: Passing degrees (e.g. \`rotation: [0, 0, 90]\`) gives a
wildly unexpected orientation. Always use radians.

---

## 5. Recommended Agent Loop

1. **Orient** — call \`describe_scene\` to see what entities exist, their ids,
   kinds, positions, and the current scene bounds.

2. **Create / edit** — call the appropriate command(s) (e.g. \`add_box\`,
   \`move_entity\`, \`scale_entity\`). Commands return the new entity id in
   \`affected\` and a factual \`summary\`.

3. **SEE it** — call \`render_view\` with \`showAxes: true\` (default) and
   \`showGrid: true\` (default). The rendered image now shows:
   - A colored X/Y/Z triad anchored at the world origin (X=red, Y=green, Z=blue).
   - A faint grid on the Z=0 ground plane.
   - A scale label showing the unit and pixel-to-unit ratio.
   Compare the object's position relative to the origin and grid to verify
   placement matches your intent.

4. **Lint** — call \`check_model\` to catch dangling references, invalid
   dimensions, or other document issues.

5. **Iterate** — if render_view shows the object is misplaced, use
   \`move_entity\` or re-create it with corrected params.

---

## 6. Common Pitfalls

- **Wrong anchor assumption**: "I set \`position: [0,0,0]\` but the box is
  half-buried below ground." → For \`add_box\`, position is the center, so
  use \`position[2] = height/2\` to place it on the ground.

- **Rotation in degrees**: \`rotation: [0, 0, 90]\` rotates ~1571 rad around
  Z, not 90°. Use \`[0, 0, 1.5708]\` or \`[0, 0, Math.PI/2]\`.

- **Units mismatch**: A 1 m box in a mm document would be tiny. Check
  \`cad://document\` for \`units\` first.

- **Forgetting +Z up**: Y is NOT up in llull. Stacking objects vertically
  means increasing the Z component of \`position\`.

- **Not using render_view after creation**: Always visually verify. The
  axis triad and grid in the image are your spatial reference — trust them
  over mental math.

- **Large offsets from origin**: The camera auto-fits the scene. If entities
  are far from each other (e.g. [0,0,0] and [10000,0,0]), they may appear
  very small. Keep related geometry near each other and near the origin.

---

## 7. Key Commands Reference

| Command           | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| \`describe_scene\`  | Read-only: scene snapshot (entities, bounds, etc.) |
| \`render_view\`     | Render to image (use showAxes+showGrid for context) |
| \`check_model\`     | Lint the document for errors                       |
| \`add_box\`         | Create a rectangular box solid                     |
| \`add_cylinder\`    | Create a cylinder (base-center anchor)             |
| \`add_sphere\`      | Create a sphere (center anchor)                    |
| \`add_cone\`        | Create a cone (base-center anchor)                 |
| \`add_torus\`       | Create a torus/donut (center anchor)               |
| \`add_wedge\`       | Create a wedge/ramp (lower-front-left anchor)      |
| \`add_pyramid\`     | Create a rectangular pyramid (base-center anchor)  |
| \`move_entity\`     | Translate an entity by a delta vector              |
| \`delete_entity\`   | Remove an entity by id                             |
| \`set_entity_name\` | Assign a human-readable name to an entity          |
`;

/** The URI for the conventions resource. */
export const CONVENTIONS_URI = 'cad://conventions' as const;
