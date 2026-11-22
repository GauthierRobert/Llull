/**
 * BCF viewpoint reader (*.bcfv, BCF 2.1 and 3.0 VisualizationInfo) for untrusted XML: the camera in metres and degrees, the selected and exceptional
 * components. Never throws: a defect is returned as a message. Pure.
 */

import type { Vec3 } from '../../../model/vectors';
import { ignoredInVisualization } from './bcfIgnored';
import { readXml, xmlAttr, xmlChildren, xmlText, type XmlElement } from '../../../lib/xmlRead';

/** Limits of one XML part of a BCF archive (the reader refuses more, `readXml` codes). */
export const BCF_XML_LIMITS = { maxChars: 8_000_000, maxDepth: 64, maxElements: 200_000 } as const;

/** A well-formed IFC GlobalId: 22 characters of the IFC base-64 alphabet. Anything else is untrusted text, never kept or echoed. */
const IFC_GUID = /^[0-9A-Za-z_$]{22}$/;

/** Most components kept per viewpoint list (selection, exceptions). */
const MAX_COMPONENTS = 20_000;

export interface BcfCamera {
  readonly projection: 'perspective' | 'orthographic';
  /** Camera position in metres. */
  readonly eyeM: Vec3;
  readonly direction: Vec3;
  readonly up: Vec3;
  /** Perspective: vertical field of view in degrees. */
  readonly fovDeg?: number;
  /** Orthographic: visible height in metres (ViewToWorldScale). */
  readonly viewHeightM?: number;
}

export interface BcfVisualization {
  readonly camera: BcfCamera;
  /** DefaultVisibility of the Visibility element, when present. */
  readonly defaultVisible?: boolean;
  /** The selected components as written (llull id and / or IfcGuid), for resolution by IfcGuid when the id is missing or names no entity. */
  readonly selectionRefs: readonly BcfComponentRef[];
  readonly exceptionRefs: readonly BcfComponentRef[];
  /** Names of the elements / attributes present in the file that no import field holds (bcfIgnored.ts). */
  readonly ignored: readonly string[];
}

/** One `Component`: its llull AuthoringToolId (when OriginatingSystem is "llull") and its IfcGuid attribute, when present. */
export interface BcfComponentRef {
  readonly id?: string;
  readonly ifcGuid?: string;
}

/** First direct child named `local`. */
export const xmlChild = (element: XmlElement, local: string): XmlElement | undefined => xmlChildren(element, local)[0];

/** Trimmed text of the child `local`, or undefined. */
export function childText(element: XmlElement, local: string): string | undefined {
  const child = xmlChild(element, local);
  return child === undefined ? undefined : xmlText(child).trim();
}

function finite(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function vector(element: XmlElement, local: string): Vec3 | undefined {
  const holder = xmlChild(element, local);
  if (holder === undefined) return undefined;
  const [x, y, z] = ['X', 'Y', 'Z'].map((axis) => finite(childText(holder, axis)));
  return x === undefined || y === undefined || z === undefined ? undefined : [x, y, z];
}

function cameraOf(root: XmlElement): BcfCamera | string {
  const perspective = xmlChild(root, 'PerspectiveCamera');
  const orthogonal = xmlChild(root, 'OrthogonalCamera');
  const element = perspective ?? orthogonal;
  if (element === undefined) return 'no PerspectiveCamera or OrthogonalCamera';
  const eyeM = vector(element, 'CameraViewPoint');
  const direction = vector(element, 'CameraDirection');
  const up = vector(element, 'CameraUpVector');
  if (eyeM === undefined || direction === undefined || up === undefined)
    return 'CameraViewPoint, CameraDirection and CameraUpVector need finite X, Y and Z';
  if (perspective !== undefined) {
    const fovDeg = finite(childText(perspective, 'FieldOfView'));
    return fovDeg === undefined
      ? 'PerspectiveCamera needs a numeric FieldOfView'
      : { projection: 'perspective', eyeM, direction, up, fovDeg };
  }
  const viewHeightM = finite(childText(element, 'ViewToWorldScale'));
  return viewHeightM === undefined
    ? 'OrthogonalCamera needs a numeric ViewToWorldScale'
    : { projection: 'orthographic', eyeM, direction, up, viewHeightM };
}

/** The `Component` children of `holder` as written. */
function components(holder: XmlElement | undefined): { refs: BcfComponentRef[] } {
  const refs: BcfComponentRef[] = [];
  for (const component of holder === undefined ? [] : xmlChildren(holder, 'Component').slice(0, MAX_COMPONENTS)) {
    const id = childText(component, 'AuthoringToolId');
    const declared = xmlAttr(component, 'IfcGuid')?.trim();
    const ifcGuid = declared !== undefined && IFC_GUID.test(declared) ? declared : undefined;
    const llullId = childText(component, 'OriginatingSystem') === 'llull' && id !== undefined && id !== '' ? id : undefined;
    refs.push({ ...(llullId === undefined ? {} : { id: llullId }), ...(ifcGuid === undefined ? {} : { ifcGuid }) });
  }
  return { refs };
}

/** A parsed VisualizationInfo, or why the text is not one. */
export function parseVisualizationInfo(xml: string): BcfVisualization | string {
  const parsed = readXml(xml, BCF_XML_LIMITS);
  if (!parsed.ok) return `${parsed.error.code}: ${parsed.error.message} (line ${parsed.error.line})`;
  const root = parsed.root;
  if (root.local !== 'VisualizationInfo') return `root element is ${root.local}, expected VisualizationInfo`;
  const camera = cameraOf(root);
  if (typeof camera === 'string') return camera;
  const holder = xmlChild(root, 'Components');
  const selection = components(holder === undefined ? undefined : xmlChild(holder, 'Selection'));
  const visibility = holder === undefined ? undefined : xmlChild(holder, 'Visibility');
  const exceptions = components(visibility === undefined ? undefined : xmlChild(visibility, 'Exceptions'));
  const declared = visibility === undefined ? undefined : xmlAttr(visibility, 'DefaultVisibility')?.trim().toLowerCase();
  return {
    camera,
    selectionRefs: selection.refs,
    exceptionRefs: exceptions.refs,
    ignored: [...ignoredInVisualization(root)],
    ...(declared === 'true' || declared === 'false' ? { defaultVisible: declared === 'true' } : {}),
  };
}
