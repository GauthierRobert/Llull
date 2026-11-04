/**
 * BCF XML writers (buildingSMART BCF-XML 3.0 and 2.1: bcf.version, extensions.xml (3.0 only), markup.bcf, *.bcfv). Lengths are converted to metres and
 * the field of view is the vertical angle in degrees, as BCF requires. Elements are written in schema order. 2.1 differs: DetailedVersion in bcf.version, no
 * extensions.xml, unwrapped Labels / Comment and one `Viewpoints Guid` element per viewpoint in the markup, no AspectRatio in the camera, no `Components`
 * wrapper in a Coloring Color. Pure string building.
 */

import type { CadDocument, Vec3 } from '../../../model/types';
import type { ReviewIssue, ViewpointCamera } from '../../../model/review';
import { escapeXml } from '../../../lib/escapeXml';
import { toMetres } from '../../../model/units';

export type BcfVersion = '3.0' | '2.1';

/** Components of a viewpoint painted one colour (`colour` is 6 hex digits, no #). */
export interface ViewpointColouring {
  readonly colour: string;
  readonly ids: readonly string[];
}

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

export function bcfVersionXml(version: BcfVersion = '3.0'): string {
  return version === '3.0'
    ? `${HEADER}\n<Version VersionId="3.0" />\n`
    : `${HEADER}\n<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>\n`;
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

export interface MarkupComment {
  readonly guid: string;
  readonly text: string;
  readonly author: string;
  /** GUID of the topic viewpoint the comment cites (one of the `viewpoints` of the markup). */
  readonly viewpointGuid?: string;
}

/** markup.bcf of one issue; `created` is an ISO 8601 date-time (commands never read the clock) and dates every comment too. */
export function bcfMarkupXml(
  issue: ReviewIssue,
  viewpoints: readonly MarkupViewpoint[],
  created: string,
  author: string,
  comments: readonly MarkupComment[] = [],
  version: BcfVersion = '3.0',
): string {
  if (version === '2.1') return bcfMarkup21Xml(issue, viewpoints, created, author, comments);
  const discussion =
    comments.length === 0
      ? ''
      : `<Comments>${comments
          .map(
            (comment) =>
              `<Comment Guid="${comment.guid}">${text('Date', created)}${text('Author', comment.author)}${text('Comment', comment.text)}${comment.viewpointGuid === undefined ? '' : `<Viewpoint Guid="${comment.viewpointGuid}" />`}</Comment>`,
          )
          .join('')}</Comments>`;
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
    (issue.dueDate === undefined ? '' : text('DueDate', `${issue.dueDate}T00:00:00Z`)) +
    (issue.assignedTo === undefined ? '' : text('AssignedTo', issue.assignedTo)) +
    (issue.description === undefined ? '' : text('Description', issue.description)) +
    discussion +
    views +
    '</Topic></Markup>\n'
  );
}

/** markup.bcf of BCF 2.1: no Header, Labels and Comment elements directly in Topic / Markup, one `Viewpoints Guid` element per viewpoint. */
function bcfMarkup21Xml(
  issue: ReviewIssue,
  viewpoints: readonly MarkupViewpoint[],
  created: string,
  author: string,
  comments: readonly MarkupComment[],
): string {
  const discussion = comments
    .map(
      (comment) =>
        `<Comment Guid="${comment.guid}">${text('Date', created)}${text('Author', comment.author)}${text('Comment', comment.text)}${comment.viewpointGuid === undefined ? '' : `<Viewpoint Guid="${comment.viewpointGuid}" />`}</Comment>`,
    )
    .join('');
  const views = viewpoints
    .map(
      (view) =>
        `<Viewpoints Guid="${view.guid}">${text('Viewpoint', view.file)}${view.snapshot === undefined ? '' : text('Snapshot', view.snapshot)}</Viewpoints>`,
    )
    .join('');
  return (
    `${HEADER}\n<Markup><Topic Guid="${issue.guid}" TopicType="${escapeXml(issue.type)}" TopicStatus="${STATUS[issue.status]}">` +
    text('Title', issue.title) +
    text('Priority', issue.priority) +
    issue.labels.map((label) => text('Labels', label)).join('') +
    text('CreationDate', created) +
    text('CreationAuthor', author) +
    (issue.dueDate === undefined ? '' : text('DueDate', `${issue.dueDate}T00:00:00Z`)) +
    (issue.assignedTo === undefined ? '' : text('AssignedTo', issue.assignedTo)) +
    (issue.description === undefined ? '' : text('Description', issue.description)) +
    `</Topic>${discussion}${views}</Markup>\n`
  );
}

/**
 * A viewpoint (*.bcfv): selection, default visibility, the `colouring` groups (Coloring, one Color per group) and the camera in metres. Entities carry no IFC GUID in llull yet,
 * so each component is identified by OriginatingSystem "llull" + AuthoringToolId (its entity id).
 */
export function bcfVisualizationXml(
  doc: CadDocument,
  guid: string,
  camera: ViewpointCamera,
  aspectRatio: number,
  selection: readonly string[],
  version: BcfVersion = '3.0',
  colouring: readonly ViewpointColouring[] = [],
): string {
  const metres = (v: Vec3): Vec3 => [toMetres(doc, v[0]), toMetres(doc, v[1]), toMetres(doc, v[2])];
  const component = (id: string): string => `<Component>${text('OriginatingSystem', 'llull')}${text('AuthoringToolId', id)}</Component>`;
  const components = selection.map(component).join('');
  const coloring =
    colouring.length === 0
      ? ''
      : `<Coloring>${colouring
          .map((group) => {
            const members = group.ids.map(component).join('');
            return `<Color Color="${group.colour}">${version === '3.0' ? `<Components>${members}</Components>` : members}</Color>`;
          })
          .join('')}</Coloring>`;
  const aspect = version === '3.0' ? text('AspectRatio', number(aspectRatio)) : '';
  const frame = xyz('CameraViewPoint', metres(camera.eye)) + xyz('CameraDirection', camera.direction) + xyz('CameraUpVector', camera.up);
  const cameraXml =
    camera.projection === 'perspective'
      ? `<PerspectiveCamera>${frame}${text('FieldOfView', number(camera.fovDeg))}${aspect}</PerspectiveCamera>`
      : `<OrthogonalCamera>${frame}${text('ViewToWorldScale', number(toMetres(doc, camera.viewHeight)))}${aspect}</OrthogonalCamera>`;
  return (
    `${HEADER}\n<VisualizationInfo Guid="${guid}"><Components>` +
    (components === '' ? '' : `<Selection>${components}</Selection>`) +
    '<Visibility DefaultVisibility="true" />' +
    coloring +
    '</Components>' +
    cameraXml +
    '</VisualizationInfo>\n'
  );
}
