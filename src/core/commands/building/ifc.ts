/**
 * IFC4 (ISO 16739-1, STEP physical file) export of the building model for OpenBIM coordination
 * (Revit, ArchiCAD, Tekla, Solibri, BIMcollab, Navisworks…).
 * Lengths are written in millimetres whatever the document unit.
 * @layer core/commands/building
 */

export { ifcGuid, ifcString, ifcReal } from './ifcStep';
export { buildIfc, exportIfc } from './ifcBuild';
export type { IfcExport } from './ifcBuild';
