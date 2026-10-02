/**
 * Read-only measurement / query commands.
 *
 * None of these commands mutate the document. Each returns:
 *   - `document`: the SAME reference passed in (no copy, no mutation)
 *   - `affected`: [] always
 *   - `summary`: factual, with units read from doc.units / doc.displayPrecision
 *   - `data`: a typed record (never a bare primitive) so MCP structured content works
 *
 * @layer core/commands
 */

export { measureDistance, measureAngle } from './measureDistanceAngle';
export { measureArea, measurePerimeter } from './measureAreaPerimeter';
export { measureBoundingBox, measureVolume, massProperties } from './measureSolid';
