/**
 * import_bcf (plant 09 VIS §6, VIS-M5): a BCF 2.1 / 3.0 archive as review issues, viewpoints and comments. The file is untrusted: see bcfRead.ts.
 * An import is never a human act: every new issue is `open` with an empty history, whatever status the file says.
 */

import type { ReviewComment, ReviewIssue, ReviewModel } from '../../../model/review';
import type { CadDocument } from '../../../model/types';
import { base64ToUint8Array } from '../../../lib/base64';
import { isoDateProblem } from '../../../lib/isoDate';
import type { CommandResult } from '../../types';
import { defineCommand, z } from '../../schema';
import { changed } from '../../noop';
import { mintReviewId, reviewOf, reviewRejection } from '../../review/reviewModel';
import { BCF_MAX_ARCHIVE_BYTES, readBcfArchive, type BcfTopicRead } from './bcfRead';
import { mapVisualization, viewpointOf } from './bcfViewpointMap';

interface BcfWarning {
  readonly code: string;
  readonly message: string;
}

const PRIORITIES: Readonly<Record<string, ReviewIssue['priority']>> = {
  low: 'low',
  minor: 'low',
  normal: 'normal',
  medium: 'normal',
  high: 'high',
  major: 'high',
  critical: 'critical',
  urgent: 'critical',
};

/** The topic fields an import sets or refreshes (not status, history, viewpoints or entities of an existing issue). */
function topicFields(
  topic: BcfTopicRead,
  warnings: BcfWarning[],
): Pick<ReviewIssue, 'title' | 'type' | 'priority' | 'labels'> & Partial<ReviewIssue> {
  const date = topic.dueDate?.slice(0, 10);
  const dueProblem = date === undefined ? null : isoDateProblem(date);
  if (dueProblem !== null)
    warnings.push({ code: 'VIS_BCF_FIELD_DROPPED', message: `topic ${topic.guid}: DueDate ignored (${dueProblem})` });
  return {
    title: topic.title,
    type: topic.type,
    priority: PRIORITIES[topic.priority.toLowerCase()] ?? 'normal',
    labels: topic.labels,
    ...(topic.description === undefined ? {} : { description: topic.description }),
    ...(topic.assignedTo === undefined ? {} : { assignedTo: topic.assignedTo }),
    ...(date !== undefined && dueProblem === null ? { dueDate: date } : {}),
  };
}

const OPEN_STATUSES = new Set(['', 'open', 'new', 'active']);

/**
 * @affects adds issues, viewpoints and comments to doc.review (affected: the issue ids created or updated); metaHistory
 * @invariant bounded hostile input (archive 64 MiB decoded, XML through readXml, entry names checked, nothing is written outside the document); imported issues are always open with no history, so no human gate is bypassed; an update never touches status, history, viewpoints or entities
 * @failure not base64 / not a zip / unsafe entry name / bad XML / no topics -> VIS_BCF_PARSE; BCF version other than 2.1 / 3.0 -> VIS_BCF_VERSION
 */
export const importBcf = defineCommand({
  name: 'import_bcf',
  description:
    'Import a BCF 2.1 or 3.0 archive (.bcfzip / .bcf) as review issues: one issue per topic (title, type, priority, labels, description, assignedTo, dueDate) with its ' +
    'viewpoints (camera metres -> document units; selected components whose OriginatingSystem is "llull" are matched by AuthoringToolId) and comments. `bcf` is the ' +
    'archive as base64 (CLI: `bcf=@review.bcf`). A topic whose Guid already names an issue follows `mergePolicy`: "skip" (default) leaves it, "update" refreshes ' +
    'its title, type, priority, labels, description, assignedTo and dueDate and appends comments it does not have. Imports are never human acts: new issues are open ' +
    '(a Closed / Resolved status in the file is reported as warning VIS_BCF_STATUS_RESET); status, history, viewpoints and entities of an existing issue are not changed. ' +
    'Limits: 64 MiB archive, 5000 topics. data { topics, created, updated, skipped, viewpoints, comments, issueIds, warnings[{code, message}] }. Errors: VIS_BCF_PARSE, VIS_BCF_VERSION. ' +
    'Warnings: VIS_BCF_GUID_UNMAPPED (components without a matching entity), VIS_BCF_VIEWPOINT_SKIPPED, VIS_BCF_TOPIC_SKIPPED, VIS_BCF_FIELD_DROPPED, VIS_BCF_STATUS_RESET.',
  annotations: { metaHistory: true },
  params: z.object({
    bcf: z.string().describe('The BCF archive, base64 (CLI: @file reads a file).'),
    mergePolicy: z
      .enum(['skip', 'update'])
      .optional()
      .describe(
        'Topics whose Guid matches an existing issue: "skip" (default) keeps the issue, "update" refreshes its topic fields and adds new comments.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string): CommandResult => reviewRejection(doc, 'import_bcf', code, message, [], ['bcf']);
    if (params.bcf.length > Math.ceil((BCF_MAX_ARCHIVE_BYTES * 4) / 3) + 4)
      return fail('VIS_BCF_PARSE', `the archive is larger than ${BCF_MAX_ARCHIVE_BYTES} bytes`);
    const bytes = base64ToUint8Array(params.bcf.replace(/\s+/g, ''));
    if (bytes === null) return fail('VIS_BCF_PARSE', 'bcf is not valid base64');
    const read = readBcfArchive(bytes);
    if (!read.ok) return fail(read.code, read.message);
    const warnings: BcfWarning[] = read.warnings.map((message) => ({ code: 'VIS_BCF_TOPIC_SKIPPED', message }));
    const policy = params.mergePolicy ?? 'skip';
    let review: ReviewModel = reviewOf(doc);
    const counts = { created: 0, updated: 0, skipped: 0, viewpoints: 0, comments: 0 };
    const issueIds: string[] = [];
    let unmapped = 0;
    const seen = new Set<string>();
    for (const topic of read.topics) {
      if (seen.has(topic.guid)) {
        warnings.push({ code: 'VIS_BCF_TOPIC_SKIPPED', message: `topic ${topic.guid} appears twice in the archive` });
        continue;
      }
      seen.add(topic.guid);
      const existing = Object.values(review.issues).find((issue) => issue.guid === topic.guid);
      if (existing !== undefined && policy === 'skip') {
        counts.skipped += 1;
        continue;
      }
      const viewpointIds = new Map<string, string>();
      const created: string[] = [];
      if (existing === undefined)
        for (const entry of topic.viewpoints) {
          if (typeof entry.visualization === 'string') {
            warnings.push({
              code: 'VIS_BCF_VIEWPOINT_SKIPPED',
              message: `topic ${topic.guid}, viewpoint ${entry.guid}: ${entry.visualization}`,
            });
            continue;
          }
          const mapped = mapVisualization(doc, entry.visualization);
          if (typeof mapped === 'string') {
            warnings.push({ code: 'VIS_BCF_VIEWPOINT_SKIPPED', message: `topic ${topic.guid}, viewpoint ${entry.guid}: ${mapped}` });
            continue;
          }
          unmapped += mapped.unmapped;
          const [id, next] = mintReviewId(review, 'vp');
          review = {
            ...next,
            viewpoints: { ...next.viewpoints, [id]: viewpointOf(id, `${topic.title} (BCF ${entry.guid.slice(0, 8)})`, mapped) },
            viewpointOrder: [...next.viewpointOrder, id],
          };
          viewpointIds.set(entry.guid, id);
          created.push(id);
          counts.viewpoints += 1;
        }
      const fields = topicFields(topic, warnings);
      let issueId: string;
      if (existing === undefined) {
        const [id, next] = mintReviewId(review, 'iss');
        const entityIds = [...new Set(created.flatMap((viewpointId) => review.viewpoints[viewpointId]?.selection ?? []))];
        const issue: ReviewIssue = { ...fields, id, guid: topic.guid, status: 'open', viewpointIds: created, entityIds, history: [] };
        review = { ...next, issues: { ...next.issues, [id]: issue }, issueOrder: [...next.issueOrder, id] };
        if (!OPEN_STATUSES.has(topic.status.toLowerCase()))
          warnings.push({
            code: 'VIS_BCF_STATUS_RESET',
            message: `${id}: status '${topic.status.slice(0, 40)}' imported as open (a status change needs the issue workflow)`,
          });
        issueId = id;
        counts.created += 1;
      } else {
        review = { ...review, issues: { ...review.issues, [existing.id]: { ...existing, ...fields } } };
        issueId = existing.id;
        counts.updated += 1;
      }
      const known = new Set(
        Object.values(review.comments)
          .filter((comment) => comment.issueId === issueId)
          .map((comment) => comment.text),
      );
      for (const entry of topic.comments) {
        if (entry.text === '' || known.has(entry.text)) continue;
        const [id, next] = mintReviewId(review, 'cm');
        const viewpointId = entry.viewpointGuid === undefined ? undefined : viewpointIds.get(entry.viewpointGuid);
        const comment: ReviewComment = {
          id,
          issueId,
          text: entry.text,
          ...(viewpointId === undefined ? {} : { viewpointId }),
          author: 'agent',
        };
        review = { ...next, comments: { ...next.comments, [id]: comment } };
        known.add(entry.text);
        counts.comments += 1;
      }
      issueIds.push(issueId);
    }
    if (unmapped > 0)
      warnings.push({
        code: 'VIS_BCF_GUID_UNMAPPED',
        message: `${unmapped} viewpoint component(s) name no entity of this document (IfcGuid only, another system, or unknown id)`,
      });
    const data = { topics: counts.created + counts.updated, ...counts, issueIds, version: read.version, warnings };
    const summary =
      `import_bcf: BCF ${read.version}: ${counts.created} issue(s) created, ${counts.updated} updated, ${counts.skipped} skipped, ` +
      `${counts.viewpoints} viewpoint(s), ${counts.comments} comment(s), ${warnings.length} warning(s)${issueIds.length > 0 ? `: ${issueIds.join(', ')}` : ''}.`;
    if (counts.created + counts.updated === 0) return { document: doc, summary, affected: [], data };
    const next: CadDocument = { ...doc, review };
    return { ...changed(next, summary, issueIds), data };
  },
});
