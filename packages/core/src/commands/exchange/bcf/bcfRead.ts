/**
 * BCF archive reader (BCF 2.1 and 3.0 zip) for untrusted input. Only `bcf.version`, `<topic>/markup.bcf` and `<topic>/*.bcfv` are inflated (snapshots and
 * other entries never are); entry names are checked (no `..`, no absolute or drive path, one folder level); sizes and counts are bounded; XML goes
 * through `readXml` (no DTD / entities). Never throws. Pure.
 */

import { unzip } from '../../../lib/zipRead';
import { readXml, xmlAttr, xmlChildren, xmlText, type XmlElement } from '../../../lib/xmlRead';
import { BCF_XML_LIMITS, childText, parseVisualizationInfo, xmlChild, type BcfVisualization } from './bcfVisualizationRead';

/** Largest archive accepted, decoded (bytes), and the largest total of the inflated parts. */
export const BCF_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
const MAX_TOPICS = 5_000;
const MAX_VIEWPOINTS_PER_TOPIC = 64;
const MAX_COMMENTS_PER_TOPIC = 500;
const MAX_LABELS = 100;
const MAX_TEXT = 20_000;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type BcfVersion = '2.1' | '3.0';

export interface BcfViewpointRead {
  readonly guid: string;
  /** The visualization, or why the viewpoint file is unusable. */
  readonly visualization: BcfVisualization | string;
}

export interface BcfCommentRead {
  readonly text: string;
  readonly author: string;
  readonly viewpointGuid?: string;
}

export interface BcfTopicRead {
  readonly guid: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly priority: string;
  readonly labels: readonly string[];
  readonly description?: string;
  readonly assignedTo?: string;
  /** DueDate as written (an ISO 8601 date or date-time). */
  readonly dueDate?: string;
  readonly viewpoints: readonly BcfViewpointRead[];
  readonly comments: readonly BcfCommentRead[];
}

export type BcfRead =
  | { readonly ok: true; readonly version: BcfVersion; readonly topics: readonly BcfTopicRead[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly code: 'VIS_BCF_PARSE' | 'VIS_BCF_VERSION'; readonly message: string };

const clip = (text: string): string => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);

/** True when an archive entry name could leave its folder (parent segment, absolute path, backslash, drive or NUL). */
function unsafeName(name: string): boolean {
  return name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..');
}

const decode = (data: Uint8Array): string => new TextDecoder('utf-8').decode(data);

function versionOf(entries: ReadonlyMap<string, Uint8Array>): BcfVersion | BcfRead {
  const raw = entries.get('bcf.version');
  if (raw === undefined) return { ok: false, code: 'VIS_BCF_PARSE', message: 'the archive has no bcf.version' };
  const parsed = readXml(decode(raw), BCF_XML_LIMITS);
  if (!parsed.ok) return { ok: false, code: 'VIS_BCF_PARSE', message: `bcf.version: ${parsed.error.code} ${parsed.error.message}` };
  const id = xmlAttr(parsed.root, 'VersionId')?.trim();
  if (parsed.root.local !== 'Version' || id === undefined)
    return { ok: false, code: 'VIS_BCF_PARSE', message: 'bcf.version is not a Version element with VersionId' };
  if (id === '2.1' || id === '3.0') return id;
  return { ok: false, code: 'VIS_BCF_VERSION', message: `BCF version '${clip(id).slice(0, 40)}' is not supported (read 2.1 and 3.0)` };
}

function viewpointRefs(topic: XmlElement, markup: XmlElement): { guid: string; file: string }[] {
  const refs: { guid: string; file: string }[] = [];
  for (const holder of [...xmlChildren(topic, 'Viewpoints'), ...xmlChildren(markup, 'Viewpoints')]) {
    const own = xmlAttr(holder, 'Guid');
    const entries = own === undefined ? xmlChildren(holder, 'ViewPoint') : [holder];
    for (const entry of entries) {
      const guid = xmlAttr(entry, 'Guid');
      if (guid === undefined || !GUID.test(guid)) continue;
      refs.push({ guid, file: childText(entry, 'Viewpoint') || 'viewpoint.bcfv' });
    }
  }
  return refs.slice(0, MAX_VIEWPOINTS_PER_TOPIC);
}

function commentsOf(topic: XmlElement, markup: XmlElement): BcfCommentRead[] {
  const holders = [...xmlChildren(topic, 'Comments').flatMap((group) => xmlChildren(group, 'Comment')), ...xmlChildren(markup, 'Comment')];
  const comments: BcfCommentRead[] = [];
  for (const holder of holders.slice(0, MAX_COMMENTS_PER_TOPIC)) {
    const text = clip(childText(holder, 'Comment') ?? '');
    const viewpoint = xmlChild(holder, 'Viewpoint');
    const viewpointGuid = viewpoint === undefined ? undefined : xmlAttr(viewpoint, 'Guid');
    comments.push({
      text,
      author: clip(childText(holder, 'Author') ?? ''),
      ...(viewpointGuid !== undefined && GUID.test(viewpointGuid) ? { viewpointGuid } : {}),
    });
  }
  return comments;
}

function topicOf(markup: XmlElement, files: ReadonlyMap<string, Uint8Array>, folder: string): BcfTopicRead | string {
  const topic = xmlChild(markup, 'Topic');
  if (topic === undefined) return 'markup.bcf has no Topic';
  const guid = xmlAttr(topic, 'Guid');
  if (guid === undefined || !GUID.test(guid)) return 'the Topic has no valid Guid';
  const title = clip(childText(topic, 'Title') ?? '').trim();
  if (title === '') return `topic ${guid} has no Title`;
  const labels = xmlChildren(topic, 'Labels')
    .flatMap((holder) => (xmlChild(holder, 'Label') === undefined ? [holder] : xmlChildren(holder, 'Label')))
    .slice(0, MAX_LABELS)
    .map((label) => clip(xmlText(label)).trim())
    .filter((label) => label !== '');
  const viewpoints = viewpointRefs(topic, markup).map((ref): BcfViewpointRead => {
    const bytes = /[/\\]/.test(ref.file) || ref.file.includes('..') ? undefined : files.get(`${folder}/${ref.file}`);
    return {
      guid: ref.guid,
      visualization:
        bytes === undefined
          ? `viewpoint file '${clip(ref.file).slice(0, 80)}' is not in the topic folder`
          : parseVisualizationInfo(decode(bytes)),
    };
  });
  const description = childText(topic, 'Description');
  const assignedTo = childText(topic, 'AssignedTo');
  const dueDate = childText(topic, 'DueDate');
  return {
    guid,
    title,
    type: clip(xmlAttr(topic, 'TopicType') ?? '').trim() || 'Issue',
    status: clip(xmlAttr(topic, 'TopicStatus') ?? '').trim(),
    priority: clip(childText(topic, 'Priority') ?? '').trim(),
    labels,
    ...(description === undefined || description === '' ? {} : { description: clip(description) }),
    ...(assignedTo === undefined || assignedTo === '' ? {} : { assignedTo: clip(assignedTo) }),
    ...(dueDate === undefined || dueDate === '' ? {} : { dueDate }),
    viewpoints,
    comments: commentsOf(topic, markup),
  };
}

/** The topics of a BCF 2.1 / 3.0 archive, or the coded reason it cannot be read. */
export function readBcfArchive(bytes: Uint8Array): BcfRead {
  const unsafe: string[] = [];
  let raw: ReturnType<typeof unzip>;
  try {
    raw = unzip(bytes, {
      maxBytes: MAX_INFLATED_BYTES,
      select: (name) => {
        if (unsafeName(name)) {
          unsafe.push(name);
          return false;
        }
        return name === 'bcf.version' || /^[^/]+\/(markup\.bcf|[^/]+\.bcfv)$/.test(name);
      },
    });
  } catch (error) {
    return { ok: false, code: 'VIS_BCF_PARSE', message: `not a readable zip: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (unsafe.length > 0) return { ok: false, code: 'VIS_BCF_PARSE', message: `unsafe archive entry name '${unsafe[0]?.slice(0, 80)}'` };
  const files = new Map(raw.map((entry) => [entry.name, entry.data] as const));
  const version = versionOf(files);
  if (typeof version !== 'string') return version;
  const folders = [...files.keys()].filter((name) => name.endsWith('/markup.bcf')).map((name) => name.slice(0, -'/markup.bcf'.length));
  if (folders.length > MAX_TOPICS)
    return { ok: false, code: 'VIS_BCF_PARSE', message: `the archive has ${folders.length} topics (limit ${MAX_TOPICS})` };
  const topics: BcfTopicRead[] = [];
  const warnings: string[] = [];
  for (const folder of folders) {
    const data = files.get(`${folder}/markup.bcf`);
    const parsed = data === undefined ? undefined : readXml(decode(data), BCF_XML_LIMITS);
    if (parsed === undefined || !parsed.ok) {
      warnings.push(
        `topic folder ${folder.slice(0, 80)}: markup.bcf ${parsed === undefined ? 'is missing' : `${parsed.error.code} ${parsed.error.message}`}`,
      );
      continue;
    }
    const topic = topicOf(parsed.root, files, folder);
    if (typeof topic === 'string') warnings.push(`topic folder ${folder.slice(0, 80)}: ${topic}`);
    else topics.push(topic);
  }
  if (folders.length === 0) return { ok: false, code: 'VIS_BCF_PARSE', message: 'the archive has no <topic>/markup.bcf' };
  return { ok: true, version, topics, warnings };
}
