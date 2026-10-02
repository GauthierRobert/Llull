/**
 * Geometry commands. Each is a pure function over the document.
 *
 * This file intentionally shows the *pattern* with a few representative
 * commands (add box, extrude, move, delete). Adding a new tool = adding one
 * `CommandDefinition` here. The UI, AI, and MCP layers pick it up automatically
 * from the registry.
 */

export type { PlacementAnchor } from './geometryShared';
export { addBox, extrude, move, deleteEntity } from './geometryBasic';
export { addCylinder, addSphere, addCone, addTorus } from './geometryRound';
export { addWedge, addPyramid } from './geometryPrismatic';
