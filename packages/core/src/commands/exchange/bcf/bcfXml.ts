/**
 * BCF 3.0 XML writers (buildingSMART BCF-XML 3.0: bcf.version, extensions.xml, markup.bcf, *.bcfv). Lengths are converted to metres and
 * the field of view is the vertical angle in degrees, as BCF requires. Elements are written in schema order. Pure string building.
 */

import type { CadDocument, Vec3 } from '../../../model/types';
import type { ReviewIssue, ViewpointCamera } from '../../../model/review';
import { escapeXml } from '../../../lib/escapeXml';
import { toMetres } from '../../../model/units';

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

const STATUS: Readonly<Record<ReviewIssue['status'], string>> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

const number = (value: number): string => (Object.is(value, -0) ? '0' : String(value));
const xyz = (tag: string, v: Vec3): string => `<${tag}><X>${number(v[0])}</X><Y>${number(v[1])}</Y><Z>${number(v[2])}</Z></${tag}>`;
const text = (tag: string, value: string): string => `<${tag}>${escapeXml(value)}</${tag}>`;

export function bcfVersionXml(): string {
  return `${HEADER}\n<Version VersionId="3.0" />\n`;
}

/** extensions.xml: the topic types, statuses, priorities and labels used by the exported issues. */
export function bcfExtensionsXml(issues: readonly ReviewIssue[]): string {
  const list = (outer: string, inner: string, values: readonly string[]): string =>
    `<${outer}>${[...new Set(values)].map((value) => text(inner, value)).join('')}</${outer}>`;
  return (
    `${HEADER}\n<Extensions>` +
    list(
      'TopicTypes',
      'TopicType',
      issues.map((issue) => issue.type),
    ) +
    list('TopicStatuses', 'TopicStatus', Object.values(STATUS)) +
    list(
      'Priorities',
      'Priority',
      issues.map((issue) => issue.priority),
    ) +
    list(
      'TopicLabels',
      'TopicLabel',
      issues.flatMap((issue) => issue.labels),
    ) +
    '</Extensions>\n'
  );
}

export interface MarkupViewpoint {
  readonly guid: string;
  readonly file: string;
  readonly snapshot?: string;
}

/** markup.bcf of one issue; `created` is an ISO 8601 date-time (commands never read the clock). */
export function bcfMarkupXml(issue: ReviewIssue, viewpoints: readonly MarkupViewpoint[], created: string, author: string): string {
  const labels = issue.labels.length === 0 ? '' : `<Labels>${issue.labels.map((label) => text('Label', label)).join('')}</Labels>`;
  const views =
    viewpoints.length === 0
      ? ''
      : `<Viewpoints>${viewpoints
          .map(
            (view) =>
              `<ViewPoint Guid="${view.guid}">${text('Viewpoint', view.file)}${view.snapshot === undefined ? '' : text('Snapshot', view.snapshot)}</ViewPoint>`,
          )
          .join('')}</Viewpoints>`;
  return (
    `${HEADER}\n<Markup><Topic Guid="${issue.guid}" TopicType="${escapeXml(issue.type)}" TopicStatus="${STATUS[issue.status]}">` +
    text('Title', issue.title) +
    text('Priority', issue.priority) +
    labels +
    text('CreationDate', created) +
    text('CreationAuthor', author) +
    (issue.description === undefined ? '' : text('Description', issue.description)) +
    views +
    '</Topic></Markup>\n'
  );
}

/**
 * A viewpoint (*.bcfv): selection, default visibility and the camera in metres. Entities carry no IFC GUID in llull yet, so each selected
 * entity is a Component identified by OriginatingSystem "llull" + AuthoringToolId (its entity id).
 */
export function bcfVisualizationXml(
  doc: CadDocument,
  guid: string,
  camera: ViewpointCamera,
  aspectRatio: number,
  selection: readonly string[],
): string {
  const metres = (v: Vec3): Vec3 => [toMetres(doc, v[0]), toMetres(doc, v[1]), toMetres(doc, v[2])];
  const components = selection
    .map((id) => `<Component>${text('OriginatingSystem', 'llull')}${text('AuthoringToolId', id)}</Component>`)
    .join('');
  const frame = xyz('CameraViewPoint', metres(camera.eye)) + xyz('CameraDirection', camera.direction) + xyz('CameraUpVector', camera.up);
  const cameraXml =
    camera.projection === 'perspective'
      ? `<PerspectiveCamera>${frame}${text('FieldOfView', number(camera.fovDeg))}${text('AspectRatio', number(aspectRatio))}</PerspectiveCamera>`
      : `<OrthogonalCamera>${frame}${text('ViewToWorldScale', number(toMetres(doc, camera.viewHeight)))}${text('AspectRatio', number(aspectRatio))}</OrthogonalCamera>`;
  return (
    `${HEADER}\n<VisualizationInfo Guid="${guid}"><Components>` +
    (components === '' ? '' : `<Selection>${components}</Selection>`) +
    '<Visibility DefaultVisibility="true" /></Components>' +
    cameraXml +
    '</VisualizationInfo>\n'
  );
}
