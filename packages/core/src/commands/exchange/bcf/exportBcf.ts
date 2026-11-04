/**
 * export_bcf (plant 09 VIS §6, VIS-M5 slice + VIS-M9 snapshots): the review issues as a BCF 3.0 or 2.1 archive. One topic per issue, one
 * viewpoint file per issue viewpoint (with its colour profile as Coloring), a PNG snapshot per viewpoint drawn with the profile and material-class colours by the reference raster
 * (deterministic: the archive sha256 is reproducible) or by the native raster (`snapshotRenderer: 'native'`, a picture).
 */

import type { ReviewIssue } from '../../../model/review';
import { nameUuid } from '../../../lib/nameUuid';
import { sha256Hex } from '../../../lib/sha256';
import { uint8ArrayToBase64 } from '../../../lib/base64';
import { clamp } from '../../../lib/clamp';
import { type ZipEntry, zipStore } from '../../../lib/zip';
import type { CommandResult } from '../../types';
import { confirmExportControlled, defineCommand, z } from '../../schema';
import { exportRefusal, report } from '../../noop';
import { reviewOf, reviewRejection } from '../../review/reviewModel';
import { surfaceShadingOf } from '../../render/surfaceShading';
import { FRAME_BACKGROUND, hexRgb, renderCameraPng, sceneCenter } from '../../render/frames';
import { nativeRun } from '../../render/rendererProvenance';
import { rasterScenePixels } from '../../render/raster';
import { styleViewpoint, type ViewpointStyle } from './bcfColouring';
import { bcfExtensionsXml, bcfMarkupXml, bcfVersionXml, bcfVisualizationXml, type MarkupComment, type MarkupViewpoint } from './bcfXml';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @affects nothing — read-only; data.base64 is the .bcf archive (`--save review.bcf`)
 * @invariant reference snapshots: the same document and params give the same archive bytes (sha256)
 * @failure export-controlled content -> MAT_EXPORT_CONTROLLED; no / unknown issues -> VIS_ISSUE_NOT_FOUND; bad creationDate -> VIS_BCF_INVALID; a viewpoint
 *   naming a deleted profile -> VIS_PROFILE_NOT_FOUND; native snapshots without port -> NATIVE_TOOL_MISSING; over 1000 coloured components in a viewpoint -> warning
 *   VIS_BCF_COLOURING_LARGE (legend labels instead of Coloring)
 */
export const exportBcf = defineCommand({
  name: 'export_bcf',
  description:
    'Export review issues (create_review_issue) as a BCF 3.0 (default) or 2.1 archive for other BIM / review tools: one topic per issue (title, type, ' +
    'status, priority, labels, description), one viewpoint per issue viewpoint (camera in metres, vertical field of view in degrees, the ' +
    'issue entities selected by AuthoringToolId, the colour profile of the viewpoint (else the active one) and the material-class colours written as Coloring, one Color per colour) ' +
    'and a PNG snapshot of each viewpoint drawn with those colours (colours: false = the entities as they are). Above 1000 coloured components in a viewpoint no Coloring is written: ' +
    'the profile goes out as legend labels of the topic and the warning VIS_BCF_COLOURING_LARGE names the viewpoints. data: { fileName, base64, bytes, sha256, version, topics, ' +
    'viewpoints, snapshots, coloured, warnings } — save with `--save review.bcf`. snapshotRenderer "reference" (default) keeps the archive ' +
    'byte-reproducible; "native" draws the snapshots on the GPU with llull-compute (CLI / desktop only; data.deterministic false). ' +
    'Entities have no IFC GUID yet: warning VIS_BCF_GUID_UNMAPPED. Errors: VIS_ISSUE_NOT_FOUND, VIS_PROFILE_NOT_FOUND, VIS_BCF_INVALID, NATIVE_TOOL_MISSING.',
  annotations: { readOnly: true },
  params: z.object({
    issueIds: z.array(z.string()).optional().describe('Issues to export (iss-<n>), in this order. Default: every issue.'),
    version: z
      .enum(['3.0', '2.1'])
      .optional()
      .describe('BCF version: "3.0" (default) or "2.1" (no extensions.xml, no AspectRatio, 2.1 markup layout).'),
    colours: z
      .boolean()
      .optional()
      .describe(
        'Apply the viewpoint colour profile and material-class colours to the snapshots and write them as Coloring. Default true; false keeps the entity colours.',
      ),
    snapshots: z.boolean().optional().describe('Embed a PNG snapshot per viewpoint. Default true.'),
    snapshotRenderer: z.enum(['reference', 'native']).optional().describe('"reference" (default, reproducible) or "native" (GPU).'),
    snapshotWidth: z.number().optional().describe('Snapshot width in pixels, clamped to [64, 1500]. Default 800.'),
    snapshotHeight: z.number().optional().describe('Snapshot height in pixels, clamped to [64, 1500]. Default 600.'),
    creationDate: z.string().optional().describe('Topic CreationDate, ISO 8601 date-time. Default "1970-01-01T00:00:00Z".'),
    author: z.string().optional().describe('Topic CreationAuthor (e.g. an e-mail). Default "llull".'),
    fileName: z.string().optional().describe('Suggested file name. Default "review.bcf".'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_bcf', 'share', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      reviewRejection(doc, 'export_bcf', code, message, ids, paths);
    const version = params.version ?? '3.0';
    const created = params.creationDate ?? '1970-01-01T00:00:00Z';
    if (!ISO_DATE_TIME.test(created))
      return fail('VIS_BCF_INVALID', `creationDate "${created}" is not an ISO 8601 date-time`, [], ['creationDate']);
    const review = reviewOf(doc);
    const ids = [...new Set(params.issueIds ?? review.issueOrder)];
    const missing = ids.filter((id) => review.issues[id] === undefined);
    if (missing.length > 0) return fail('VIS_ISSUE_NOT_FOUND', `unknown issue(s) ${missing.join(', ')}`, missing, ['issueIds']);
    if (ids.length === 0) return fail('VIS_ISSUE_NOT_FOUND', 'the document has no review issue to export');
    const issues = ids.map((id) => review.issues[id]).filter((issue): issue is ReviewIssue => issue !== undefined);
    const present = (entityIds: readonly string[]): string[] => entityIds.filter((id) => doc.entities[id] !== undefined);
    const native = params.snapshotRenderer === 'native' && params.snapshots !== false ? (ctx?.raster ?? null) : undefined;
    if (native === null)
      return fail('NATIVE_TOOL_MISSING', 'no native raster (llull-compute) is installed in this host', [], ['snapshotRenderer']);
    const run = native === undefined ? null : nativeRun(native, 'gpu');
    const width = clamp(Math.round(params.snapshotWidth ?? 800), 64, 1500);
    const height = clamp(Math.round(params.snapshotHeight ?? 600), 64, 1500);
    const background = hexRgb(FRAME_BACKGROUND) ?? [0, 0, 0];
    const center = sceneCenter(doc);
    const snapshotCache = new Map<string, Uint8Array>();
    const styles = new Map<string, ViewpointStyle>();
    const large: Array<{ viewpointId: string; coloured: number }> = [];
    const exported: ReviewIssue[] = [];
    const entries: ZipEntry[] = [];
    const encoder = new TextEncoder();
    let viewpointCount = 0;
    for (const issue of issues) {
      const markupViews: MarkupViewpoint[] = [];
      const viewpointGuids = new Map<string, string>();
      const legendLabels: string[] = [];
      for (const viewpointId of new Set(issue.viewpointIds)) {
        const viewpoint = review.viewpoints[viewpointId];
        if (viewpoint === undefined) continue;
        const guid = nameUuid(`llull-bcf-viewpoint|${issue.guid}|${viewpoint.guid}`);
        let style = styles.get(viewpointId);
        if (style === undefined) {
          const resolved = styleViewpoint(doc, viewpointId, ctx, params.colours !== false);
          if ('code' in resolved)
            return fail(resolved.code, resolved.message, [viewpointId], resolved.paths.length > 0 ? resolved.paths : ['issueIds']);
          style = resolved;
          styles.set(viewpointId, style);
          if (style.large) large.push({ viewpointId, coloured: style.coloured });
        }
        if (style.large) legendLabels.push(...style.legend);
        const visinfo = bcfVisualizationXml(
          doc,
          guid,
          viewpoint.camera,
          width / height,
          present(issue.entityIds),
          version,
          style.colouring,
        );
        entries.push({ name: `${issue.guid}/${guid}.bcfv`, data: encoder.encode(visinfo) });
        viewpointGuids.set(viewpointId, guid);
        viewpointCount += 1;
        if (params.snapshots === false) {
          markupViews.push({ guid, file: `${guid}.bcfv` });
          continue;
        }
        const png =
          snapshotCache.get(viewpointId) ??
          renderCameraPng(
            style.scene,
            viewpoint.camera,
            width,
            height,
            background,
            center,
            run?.pixels ?? rasterScenePixels,
            surfaceShadingOf(doc, ctx),
          );
        snapshotCache.set(viewpointId, png);
        entries.push({ name: `${issue.guid}/${guid}.png`, data: png });
        markupViews.push({ guid, file: `${guid}.bcfv`, snapshot: `${guid}.png` });
      }
      const comments: MarkupComment[] = Object.values(review.comments)
        .filter((comment) => comment.issueId === issue.id)
        .map((comment) => {
          const viewpointGuid = comment.viewpointId === undefined ? undefined : viewpointGuids.get(comment.viewpointId);
          return {
            guid: nameUuid(`llull-bcf-comment|${issue.guid}|${comment.id}`),
            text: comment.text,
            author: comment.importedAuthor ?? comment.author,
            ...(viewpointGuid === undefined ? {} : { viewpointGuid }),
          };
        });
      const topic = legendLabels.length === 0 ? issue : { ...issue, labels: [...new Set([...issue.labels, ...legendLabels])] };
      exported.push(topic);
      entries.push({
        name: `${issue.guid}/markup.bcf`,
        data: encoder.encode(bcfMarkupXml(topic, markupViews, created, params.author ?? 'llull', comments, version)),
      });
    }
    entries.unshift(
      { name: 'bcf.version', data: encoder.encode(bcfVersionXml(version)) },
      ...(version === '3.0' ? [{ name: 'extensions.xml', data: encoder.encode(bcfExtensionsXml(exported)) }] : []),
    );
    const outcome = run?.result();
    if (outcome !== undefined && 'code' in outcome) return fail(outcome.code, outcome.message, [], ['snapshotRenderer']);
    const archive = zipStore(entries);
    const unmapped = [...new Set(issues.flatMap((issue) => present(issue.entityIds)))];
    const warnings = [
      ...(unmapped.length === 0 ? [] : [{ code: 'VIS_BCF_GUID_UNMAPPED', ids: unmapped }]),
      ...(large.length === 0
        ? []
        : [{ code: 'VIS_BCF_COLOURING_LARGE', ids: large.map((item) => item.viewpointId), counts: large.map((item) => item.coloured) }]),
    ];
    const coloured = [...styles.values()].reduce((sum, style) => sum + (style.large ? 0 : style.coloured), 0);
    const provenance =
      outcome !== undefined && !('code' in outcome)
        ? { snapshotRenderer: 'native', ...outcome }
        : { snapshotRenderer: 'reference', deterministic: true };
    const snapshotCount = params.snapshots === false ? 0 : viewpointCount;
    return report(
      doc,
      `Exported ${issues.length} BCF ${version} topic(s), ${viewpointCount} viewpoint(s), ${snapshotCount} snapshot(s), ${coloured} coloured component(s) (${archive.length} bytes). ` +
        `Save with --save ${params.fileName ?? 'review.bcf'}.${unmapped.length > 0 ? ` VIS_BCF_GUID_UNMAPPED: ${unmapped.length} entit(ies) referenced by AuthoringToolId.` : ''}` +
        `${large.length > 0 ? ` VIS_BCF_COLOURING_LARGE: ${large.length} viewpoint(s) over 1000 coloured components, the profile is written as legend labels.` : ''}`,
      {
        fileName: params.fileName ?? 'review.bcf',
        base64: uint8ArrayToBase64(archive),
        bytes: archive.length,
        sha256: sha256Hex(archive),
        version,
        topics: issues.length,
        viewpoints: viewpointCount,
        snapshots: snapshotCount,
        coloured,
        warnings,
        ...provenance,
      },
    );
  },
});
