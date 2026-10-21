/**
 * Typed extension point for plugin-owned document slices (architecture L10): core declares no domain data. A plugin package augments this
 * interface from its own model file with an OPTIONAL member, e.g.
 * `declare module '@core/model/documentExtensions' { interface DocumentExtensions { building?: BuildingModel } }`;
 * `CadDocument` extends it, so `doc.building` is typed wherever the plugin's model file is part of the program.
 * @invariant every member is optional (a slice is absent until the plugin's first command); core code never reads a member
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by plugin packages via module augmentation
export interface DocumentExtensions {}
