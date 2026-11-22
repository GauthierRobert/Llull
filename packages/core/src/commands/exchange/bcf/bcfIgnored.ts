/**
 * What import_bcf does not read, by name (plant 08 DAT-VIS-FU3 / 09 VIS-FU): the optional BCF elements and attributes of a topic, a comment, a viewpoint reference and a
 * VisualizationInfo that no import field holds. Names are `Parent/Element` or `Parent/@attribute` (schema names, so the BCF 2.1 and 3.0 spellings both appear); never
 * the text of the file (untrusted). `WRITTEN` are the names export_bcf itself writes: they are listed in `data.ignored` but raise no warning on a round trip. Pure.
 */

import { type XmlElement, xmlChildren } from '../../../lib/xmlRead';

/** Names the reader consumes, per parent (children and attributes). */
const READ: Readonly<Record<string, ReadonlySet<string>>> = {
  Topic: new Set([
    'Title',
    'Priority',
    'Labels',
    'Description',
    'AssignedTo',
    'DueDate',
    'Viewpoints',
    'Comments',
    '@Guid',
    '@TopicType',
    '@TopicStatus',
  ]),
  Markup: new Set(['Topic', 'Comment', 'Viewpoints']),
  Comment: new Set(['Comment', 'Author', 'Viewpoint', '@Guid']),
  ViewPoint: new Set(['Viewpoint', '@Guid']),
  VisualizationInfo: new Set(['Components', 'PerspectiveCamera', 'OrthogonalCamera', '@Guid']),
  Components: new Set(['Selection', 'Visibility']),
  Visibility: new Set(['Exceptions', '@DefaultVisibility']),
  Camera: new Set(['CameraViewPoint', 'CameraDirection', 'CameraUpVector', 'FieldOfView', 'ViewToWorldScale']),
};

/** What export_bcf writes and import_bcf does not keep (the file's own metadata, the snapshot, the picture frame ratio). */
const WRITTEN: ReadonlySet<string> = new Set([
  'Topic/CreationDate',
  'Topic/CreationAuthor',
  'Comment/Date',
  'ViewPoint/Snapshot',
  'Camera/AspectRatio',
  'Components/Coloring',
]);

const MAX_NAMES = 40;

function unread(element: XmlElement, parent: string, into: Set<string>): void {
  const read = READ[parent] ?? new Set<string>();
  for (const child of xmlChildren(element)) if (!read.has(child.local)) into.add(`${parent}/${child.local}`);
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:') || attribute.name.startsWith('xsi:')) continue;
    if (!read.has(`@${attribute.name}`)) into.add(`${parent}/@${attribute.name.slice(0, 40)}`);
  }
}

/** Ignored names of one topic: its markup root, Topic, comments and viewpoint references (2.1 and 3.0 layouts). */
export function ignoredInMarkup(markup: XmlElement, topic: XmlElement): Set<string> {
  const names = new Set<string>();
  unread(markup, 'Markup', names);
  unread(topic, 'Topic', names);
  const comments = [...xmlChildren(topic, 'Comments').flatMap((group) => xmlChildren(group, 'Comment')), ...xmlChildren(markup, 'Comment')];
  for (const comment of comments) unread(comment, 'Comment', names);
  const views = [...xmlChildren(topic, 'Viewpoints'), ...xmlChildren(markup, 'Viewpoints')].flatMap((holder) =>
    holder.attributes.some((attribute) => attribute.name === 'Guid') ? [holder] : xmlChildren(holder, 'ViewPoint'),
  );
  for (const view of views) unread(view, 'ViewPoint', names);
  return names;
}

/** Ignored names of one VisualizationInfo: the root, Components, Visibility, the camera, and Lines / ClippingPlanes / Bitmaps by their own name. */
export function ignoredInVisualization(root: XmlElement): Set<string> {
  const names = new Set<string>();
  unread(root, 'VisualizationInfo', names);
  for (const camera of [...xmlChildren(root, 'PerspectiveCamera'), ...xmlChildren(root, 'OrthogonalCamera')])
    unread(camera, 'Camera', names);
  for (const components of xmlChildren(root, 'Components')) {
    unread(components, 'Components', names);
    for (const visibility of xmlChildren(components, 'Visibility')) unread(visibility, 'Visibility', names);
  }
  return names;
}

/** Counts of ignored names over many topics / viewpoints, sorted by name. */
export function tallyIgnored(sets: Iterable<ReadonlySet<string>>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const set of sets) for (const name of set) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_NAMES)
    .map(([name, count]) => ({ name, count }));
}

/** True for a name export_bcf does not write, so the file came from another tool and the loss is worth a warning. */
export const isForeignIgnored = (name: string): boolean => !WRITTEN.has(name);
