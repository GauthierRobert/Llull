/** Stable `DAT_*` codes of the plant data plugin with their one-line fixes (plant 08 DAT, TECHNICAL_SPEC §7). */

import { tableRejection } from '@core/commands/noop';

export type FindingSeverity = 'fail' | 'warn' | 'info';

export interface DataFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const REMEDIATION: Readonly<Record<string, string>> = {
  DAT_PARAM_INVALID: 'Fix the parameter named in paths.',
  DAT_HIERARCHY_INVALID:
    'Give parent as the code (or S1/P1/U10 path) of an existing node of a higher kind (site > plant > area > unit > system); only a site has no parent.',
  DAT_HIERARCHY_DUPLICATE_CODE: 'Rename one of the two nodes: codes are unique among the children of one parent.',
  DAT_HIERARCHY_UNKNOWN: 'Call define_plant_hierarchy first, then pass the node code, its S1/P1/U10 path or its id.',
  DAT_CLASS_EXISTS: 'Choose another class name, or subclass the existing class (parent).',
  DAT_CLASS_UNKNOWN: 'List the classes with plant_data_table (data.classes) or load the library with load_plant_class_library.',
  DAT_CLASS_ABSTRACT: 'Assign a concrete subclass (plant_data_table lists them), or define one with parent = this class.',
  DAT_CLASS_PARENT_UNKNOWN: 'Define or load the parent class first.',
  DAT_CLASS_CYCLE: 'A class cannot inherit from itself: pick another parent.',
  DAT_LIBRARY_CLASS_LOCKED: 'A library class is read-only: define a subclass with parent = this class.',
  DAT_LIBRARY_UNKNOWN: 'Use library "llull-default-process".',
  DAT_PROPERTY_DEFINITION_INVALID:
    'Names are identifiers without spaces; a physical type needs one of its units; an enum needs enumValues; a subclass may only tighten an inherited property (required, a narrower enum, a default), never change its type or unit.',
  DAT_IFC_MAPPING_INVALID: 'Use an IFC entity and PredefinedType of the IFC4X3_ADD2 schema, or USERDEFINED with objectType.',
  DAT_TAG_FORMAT_INVALID:
    'A format is literal text and {field} / {field:width} parts ({{ and }} write braces); fields are classCode, hierarchy.<kind>.<property>, or an identifier.',
  DAT_TAG_FORMAT: 'Omit tag and give tagFields (the generated tag is always valid), or type a tag that matches the class format.',
  DAT_TAG_FIELD_MISSING: 'Add the field to tagFields or properties, or define the hierarchy property / class code it reads.',
  DAT_TAG_DUPLICATE: 'Pass nextSequence: true, or use the free tag named in the message.',
  DAT_TAG_CASE_COLLISION: 'Rename one of the tags: tags are compared case-sensitively but a case-only difference is almost always a typo.',
  DAT_TAG_MODEL_MISMATCH:
    'The model object still carries another tag (renamed after tagging): re-run set_plant_properties on a tag-driving property, or rename the model object back.',
  DAT_TARGET_UNKNOWN: 'Pass an element id (building_schedule), a routed line id (piping_takeoff), { provider, id } or "reserved".',
  DAT_TARGET_ALREADY_TAGGED: 'Call unassign_plant_object on the existing object first.',
  DAT_TARGET_TAG_READONLY:
    'This provider cannot rename its object: omit tag so the existing model tag is adopted, or rename the object with its own command first.',
  DAT_OBJECT_UNKNOWN:
    'List the objects with plant_data_table (id and tag columns); a tag shared by several scopes must be given as the id.',
  DAT_PROPERTY_UNKNOWN: 'The class does not define the property: plant_data_table columns lists them, or subclass the class and add it.',
  DAT_PROPERTY_READONLY: 'The value is derived (tag, geometry, hierarchy): change its source instead.',
  DAT_PROPERTY_TYPE:
    'Send a value of the property type (number for physical types, one of enumValues for an enum, text matching the pattern).',
  DAT_PROPERTY_UNIT: 'Send { value, unit } with a unit of the same family as the property (a gauge pressure never converts to absolute).',
  DAT_REQUIRED_PROPERTY_MISSING: 'Send the value with set_plant_properties.',
  DAT_LINE_END_UNRESOLVED:
    'Tag the object the line ends at, or name the end BL-... / TI-... (settings.batteryLimitPattern) when it leaves the unit.',
  DAT_LINE_SIZE_MISMATCH: 'Make the line nominalSize equal to the DN of its pipe, or re-size the pipe.',
  DAT_OBJECT_ORPHAN: 'Unassign the object, or re-create the model element it stood for.',
  DAT_UNCLASSIFIED_ELEMENT: 'Classify the element with assign_plant_object.',
  DAT_OUTSIDE_HIERARCHY: 'Re-assign the object to an existing hierarchy node (the file was edited by hand).',
  DAT_VALUE_UNVERIFIED: 'Verify the value against its source and send it again with set_plant_properties without the unverified flag.',
  DAT_RESERVED_TAG_UNMODELLED: 'Nothing to fix: the tag is held for a future object; assign it to a model object when it exists.',
  DAT_COLUMN_UNKNOWN: 'plant_data_table (without columns) returns the column names of the class.',
};

export const refuseDat = tableRejection(REMEDIATION);

/** A finding with its table remediation. */
export function datFinding(
  code: string,
  severity: FindingSeverity,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): DataFinding {
  return { code, severity, ids, paths, message, remediation: REMEDIATION[code] ?? 'see the command description' };
}
