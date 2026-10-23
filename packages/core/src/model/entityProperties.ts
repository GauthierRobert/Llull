/**
 * Entity property bag (plant 09 VIS §3.3/§3.4): the flat, read-only facts colour rules and reports match on. Core knows its own keys
 * (kind, layer, tags, material, name, component); a plugin adds domain keys through `CadPlugin.entityProperties`.
 */

import type { PropertyValue } from './display';
import type { CadDocument } from './types';

/** Key -> one value, or several (a multi-valued key such as `tag` matches when any value matches). */
export type PropertyBag = Readonly<Record<string, PropertyValue | readonly PropertyValue[]>>;

/**
 * Domain properties of entity `entityId`.
 * @invariant pure; returns {} for an entity the plugin does not own; never reads outside `doc`
 */
export type EntityPropertyProvider = (doc: CadDocument, entityId: string) => PropertyBag;

/** Property bag of an entity as seen through every installed provider (`ExecutionContext.properties`). */
export type EntityPropertyReader = (doc: CadDocument, entityId: string) => PropertyBag;
