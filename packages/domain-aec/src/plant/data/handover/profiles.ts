/**
 * Handover profiles (plant 08 DAT §5.15, TR-DAT-29): which registers exist, their file and column names, and which external class scheme supplies the class ids.
 * The `cfihos-subset` names are llull's own reading of the CFIHOS data model (tag, equipment, properties, documents); they were NOT compared with an IOGP CFIHOS
 * release (Q9), so every file of that profile is marked unverified. Data, not logic: a checked release replaces the tables, nothing else.
 */

import type { ExternalScheme } from '../model';

export const REGISTER_KEYS = ['tag_register', 'equipment_register', 'tag_properties', 'document_register'] as const;
export type RegisterKey = (typeof REGISTER_KEYS)[number];

export const PROFILE_NAMES = ['cfihos-subset', 'generic'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** Logical column ids of each register, in file order. */
export const REGISTER_FIELDS: Readonly<Record<RegisterKey, readonly string[]>> = {
  tag_register: ['tag', 'class', 'classId', 'parentTag', 'hierarchy', 'description', 'status'],
  equipment_register: ['tag', 'manufacturer', 'model', 'serialNumber'],
  tag_properties: ['tag', 'property', 'value', 'unit', 'unverified'],
  document_register: [
    'deliverable',
    'revision',
    'status',
    'contentSha256',
    'scope',
    'signedBy',
    'signatureId',
    'issuedAt',
    'contentCurrent',
  ],
};

export interface HandoverProfile {
  readonly name: ProfileName;
  /** The external class scheme whose `externalIds` fill the class id column. */
  readonly scheme: ExternalScheme;
  readonly unverified: boolean;
  readonly mappingSource: string;
  readonly notice: string;
  readonly fileStem: string;
  /** Header text per logical column, per register. */
  readonly headers: Readonly<Record<RegisterKey, Readonly<Record<string, string>>>>;
}

export const PROFILES: Readonly<Record<ProfileName, HandoverProfile>> = {
  'cfihos-subset': {
    name: 'cfihos-subset',
    scheme: 'cfihos',
    unverified: true,
    mappingSource:
      'class ids: classes[].externalIds with scheme cfihos, supplied by the project (llull ships none); file and column names: llull reading of the CFIHOS data model, not checked against an IOGP release',
    notice:
      'UNVERIFIED: the file and column names and the class ids are not checked against an IOGP CFIHOS release; do not deliver as CFIHOS-compliant.',
    fileStem: 'cfihos-subset',
    headers: {
      tag_register: {
        tag: 'TAG_NUMBER',
        class: 'TAG_CLASS_NAME',
        classId: 'TAG_CLASS_ID',
        parentTag: 'PARENT_TAG_NUMBER',
        hierarchy: 'HIERARCHY_PATH',
        description: 'TAG_DESCRIPTION',
        status: 'TAG_STATUS',
      },
      equipment_register: { tag: 'TAG_NUMBER', manufacturer: 'MANUFACTURER_NAME', model: 'MODEL_NAME', serialNumber: 'SERIAL_NUMBER' },
      tag_properties: {
        tag: 'TAG_NUMBER',
        property: 'PROPERTY_NAME',
        value: 'PROPERTY_VALUE',
        unit: 'PROPERTY_UOM',
        unverified: 'UNVERIFIED',
      },
      document_register: {
        deliverable: 'DOCUMENT_ID',
        revision: 'REVISION',
        status: 'STATUS',
        contentSha256: 'SHA256',
        scope: 'SCOPE',
        signedBy: 'SIGNED_BY',
        signatureId: 'SIGNATURE_ID',
        issuedAt: 'ISSUED_AT',
        contentCurrent: 'CONTENT_CURRENT',
      },
    },
  },
  generic: {
    name: 'generic',
    scheme: 'company',
    unverified: false,
    mappingSource: 'none: llull column names; class ids from classes[].externalIds with scheme company when given',
    notice: 'llull registers with llull column names; no external standard is claimed.',
    fileStem: 'generic',
    headers: {
      tag_register: {
        tag: 'Tag',
        class: 'Class',
        classId: 'ClassId',
        parentTag: 'ParentTag',
        hierarchy: 'Hierarchy',
        description: 'Description',
        status: 'Status',
      },
      equipment_register: { tag: 'Tag', manufacturer: 'Manufacturer', model: 'Model', serialNumber: 'SerialNumber' },
      tag_properties: { tag: 'Tag', property: 'Property', value: 'Value', unit: 'Unit', unverified: 'Unverified' },
      document_register: {
        deliverable: 'Deliverable',
        revision: 'Revision',
        status: 'Status',
        contentSha256: 'ContentSha256',
        scope: 'Scope',
        signedBy: 'SignedBy',
        signatureId: 'SignatureId',
        issuedAt: 'IssuedAt',
        contentCurrent: 'ContentCurrent',
      },
    },
  },
};

/** File name of a register: `<profile>-<register>.csv`, with an `.unverified` infix for an unverified profile (the mark travels with the file). */
export const registerFileName = (profile: HandoverProfile, key: RegisterKey): string =>
  `${profile.fileStem}-${key.replace(/_/g, '-')}${profile.unverified ? '.unverified' : ''}.csv`;
