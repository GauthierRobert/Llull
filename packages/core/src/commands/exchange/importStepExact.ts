/**
 * import_step_exact: STEP -> exact healed B-rep solids stored as document blobs (aerospace 01 M4 MVP, TR-KRN-20..24) and, with an XDE-capable kernel,
 * the product tree of the file as components / instances with provenance and a geometric-validation-property check (aerospace 04 M3, TR-XCH-08).
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand } from '../schema';
import { changed } from '../noop';
import { sha256Hex } from '../../lib/sha256';
import { summarizeStep21 } from '../../lib/step21/summary';
import { withKernelStamp } from '../../model/kernelSettings';
import type { ExchangeModel } from '../../model/exchange';
import { stepImportReport } from './stepImportReport';
import { gvpPolicy } from './gvpBands';
import { MAX_INSTANCE_DEPTH } from '../brep/stepTargets';
import { describeProvenance } from './importProvenance';
import { verifyImportedProducts } from './importVerify';
import { type PmiImportOutcome, importProductPmi, recordPmiImport } from './importPmi';
import { importStepExactParams, type StepParams } from './importStepExactSchema';
import { type Placed, type SourceRead, placeBodies, openStepSource } from './importStepExactRun';

type ExchangeReport = ReturnType<typeof describeProvenance>;

/** The provenance of the product tree and its geometric-validation-property check; the document's exchange model with it merged. */
function describeExchange(
  doc: CadDocument,
  params: StepParams,
  read: SourceRead,
  placed: Placed,
): { readonly exchange: ExchangeModel | undefined; readonly exchangeReport: ExchangeReport | null } {
  const { kernel, text, tree } = read;
  const { bodies, structure, solidIds } = placed;
  if (tree === null || structure === null) return { exchange: doc.exchange, exchangeReport: null };
  const verify = params.verify !== false;
  const policy = gvpPolicy(params.gvpPolicy);
  const summary = summarizeStep21(text);
  const masses = verify
    ? bodies.map((body) => {
        const shape = kernel.evaluate({ op: 'brep', blob: body.blob.sha256, format: 'occt-brep-v1' });
        return shape === null ? null : (kernel.massProperties?.(shape) ?? null);
      })
    : null;
  const verifications = masses === null ? null : verifyImportedProducts(tree, masses, summary, policy);
  const perProduct = new Map(tree.products.map((product, index) => [index, product.solids.map((solid) => solidIds[solid] ?? '')] as const));
  const exchangeReport = describeProvenance({
    unit: doc.units,
    imported: tree,
    placements: structure.placements,
    solidIds: perProduct,
    verifications,
    summary,
    policy,
    fileName: params.fileName,
    sha256: params.sha256 ?? sha256Hex(text),
  });
  const flagged = Object.fromEntries(
    structure.nonRigidParents.flatMap((id) => {
      const record = exchangeReport.provenance[id];
      return record === undefined || record.unverified.reasons.includes('non_rigid_occurrence')
        ? []
        : [
            [
              id,
              { ...record, unverified: { value: true, reasons: [...record.unverified.reasons, 'non_rigid_occurrence' as const] } },
            ] as const,
          ];
    }),
  );
  const exchange: ExchangeModel = { provenance: { ...doc.exchange?.provenance, ...exchangeReport.provenance, ...flagged } };
  return { exchange, exchangeReport };
}

/** The semantic PMI of each product of an AP242 file, attached through apply_pmi_set. */
function importPmi(
  assembled: CadDocument,
  params: StepParams,
  read: SourceRead,
  solidIds: readonly string[],
  exchangeReport: ExchangeReport | null,
): { readonly document: CadDocument; readonly pmiOutcomes: PmiImportOutcome[] } {
  const { kernel, tree } = read;
  const pmiOutcomes: PmiImportOutcome[] = [];
  let withPmi = assembled;
  if (params.importPmi !== false && exchangeReport !== null && tree !== null) {
    for (const product of exchangeReport.report.products) {
      if (product.pmi === undefined) continue;
      const solids = tree.products[product.index]?.solids.map((solid) => solidIds[solid] ?? '') ?? [];
      const outcome = importProductPmi(withPmi, kernel, product.pmi, solids, params.fileName ?? 'the STEP file');
      withPmi = outcome.document;
      pmiOutcomes.push(outcome);
    }
    withPmi = recordPmiImport(withPmi, params.fileName ?? 'the STEP file', pmiOutcomes);
  }
  return { document: withPmi, pmiOutcomes };
}

function run(doc: CadDocument, params: StepParams, ctx: ExecutionContext | undefined): CommandResult {
  const read = openStepSource(doc, params, ctx);
  if ('document' in read) return read;
  const placed = placeBodies(doc, params, read);
  if ('document' in placed) return placed;
  const { tolerance, options, imported, tree } = read;
  const { bodies, structure, depth, original, staged, ids, solidIds, entities, components, stamp } = placed;
  const { exchange, exchangeReport } = describeExchange(doc, params, read, placed);
  const assembled: CadDocument = {
    ...(doc.kernelSettings === undefined && stamp !== null ? withKernelStamp(staged, stamp) : staged),
    entities,
    order: [...doc.order, ...ids],
    components,
    ...(exchange === undefined ? {} : { exchange }),
  };
  const { document, pmiOutcomes } = importPmi(assembled, params, read, solidIds, exchangeReport);
  const pmiTotals = {
    items: pmiOutcomes.reduce((sum, outcome) => sum + outcome.items, 0),
    unresolved: pmiOutcomes.reduce((sum, outcome) => sum + outcome.unresolved, 0),
    unmapped: pmiOutcomes.reduce((sum, outcome) => sum + outcome.unmapped, 0),
  };
  const base = stepImportReport({
    ids: solidIds,
    solids: bodies.map((body) => body.solid),
    imported,
    tolerance,
    options,
    doc,
    fileName: params.fileName,
    original: original?.sha256,
    blobs: bodies.map((body) => body.blob.sha256),
  });
  const report = {
    ...base,
    ...(exchangeReport === null ? {} : { exchange: exchangeReport.report }),
    ...(pmiOutcomes.length === 0 ? {} : { pmi: pmiTotals }),
    skipped: [
      ...base.skipped,
      ...(structure?.nonRigid ?? []).map((name) => `occurrence '${name}' is mirrored or scaled: placed without rotation`),
      ...(depth > MAX_INSTANCE_DEPTH
        ? [`the assembly nests ${depth} instance levels: levels below ${MAX_INSTANCE_DEPTH} are not expanded by export or display`]
        : []),
    ],
    warnings: [...base.warnings, ...(exchangeReport?.warnings ?? [])],
    reviewRequired: (() => {
      const reasons = [
        ...base.reviewRequired.reasons,
        ...(exchangeReport?.reasons ?? []),
        ...((structure?.nonRigid.length ?? 0) > 0 ? ['non_rigid_occurrence'] : []),
        ...(depth > MAX_INSTANCE_DEPTH ? ['assembly_depth_limit'] : []),
        ...(pmiTotals.items > 0 ? ['pmi_review_required'] : []),
      ];
      return { value: reasons.length > 0, reasons };
    })(),
  };
  const pmiNote =
    pmiOutcomes.length === 0
      ? ''
      : ` PMI: ${pmiTotals.items} semantic item(s) attached (review required), ${pmiTotals.unresolved} unresolved, ${pmiTotals.unmapped} unmapped.`;
  const warned = report.warnings.map((warning) => ` ${warning.code}: ${warning.message}.`).join('');
  const structured =
    tree !== null && structure !== null
      ? ` Product tree: ${tree.products.length} product${tree.products.length === 1 ? '' : 's'}, ${Object.keys(structure.components).length} component${Object.keys(structure.components).length === 1 ? '' : 's'}, ${tree.occurrences.length} occurrence${tree.occurrences.length === 1 ? '' : 's'}; GVP check ${exchangeReport?.report.gvpCheck.verified === true ? exchangeReport.report.gvpCheck.band : 'skipped'}.`
      : '';
  return {
    ...changed(
      document,
      `import_step_exact: ${bodies.length} exact solid${bodies.length === 1 ? '' : 's'} (${ids.join(', ')}); ${report.census.faces} faces in the file, ` +
        `${report.solids.filter((solid) => solid.validAfterHeal).length}/${bodies.length} valid after BRepCheck, max tolerance ${report.maxToleranceMm} mm; ` +
        `${imported.skipped.length} item${imported.skipped.length === 1 ? '' : 's'} skipped.${structured}${pmiNote}${warned}${report.reviewRequired.value ? ` Needs a qualified engineer: ${report.reviewRequired.reasons.join(', ')}.` : ''}`,
      ids,
    ),
    data: { report },
  };
}

/**
 * @affects adds document blobs (healed BRepTools text per solid, optionally the STEP), creates one `mesh` entity per solid whose `brep` is a
 *   `brep` blob leaf (wrapped in a `scale` node when the document unit is not mm); with a product tree also one component per product, one
 *   instance per occurrence and `exchange.provenance`; affected = the top-level ids (solids of a plain part, the root instance of an assembly)
 * @invariant every created solid passed BRepCheck after healing, or nothing is imported; replay re-mints the same ids and the same blobs; a
 *   yellow / red / not-checkable validation-property band never blocks the import
 * @failure no exact kernel / unreadable STEP / tessellated-only / no solid / heal failure -> no-op, affected:[], error.code KRN_*
 */
export const importStepExact = defineCommand({
  name: 'import_step_exact',
  annotations: { requiresKernel: true },
  description:
    'Import a STEP file as exact B-rep solids (not triangles): the file is read, every solid is checked and healed (BRepCheck, ShapeFix, sewing of loose shells), ' +
    'stored as a content-addressed document blob and shown as one mesh entity per solid that keeps its exact shape (volumes, fillets, booleans and STEP export stay exact). ' +
    'Names and colours of the file are kept. An assembly keeps its structure: one component per product, one instance per placed occurrence (assembly: false flattens it). ' +
    'The geometric validation properties the sender embedded (volume, surface area, centroid) are compared with the recomputed ones per product (verify): ' +
    'data.report.exchange lists product, band green / yellow / red / not-checkable, both values and the exact file-unit factor (25.4 for inch); a red or ' +
    'not-checkable body is flagged unverified and the report asks for review, but the import still completes. ' +
    'Needs the exact OCC kernel (kernel_info); otherwise use the CLI tool import_step for a mesh. Give the file as stepBase64 or text. Lengths are converted from millimetres into the ' +
    'document unit. data.report lists per solid validAsRead / validAfterHeal / actions / maxToleranceMm / freeEdges / faces / faceted, the root census, skipped items and ' +
    'warnings (KRN_IMPORT_TOLERANCE_HIGH above kernelSettings maxImportTolerance; XCH_GVP_YELLOW / XCH_GVP_RED / XCH_GVP_NOT_CHECKABLE). Refusals carry error.code: ' +
    'KRN_NO_EXACT_KERNEL, KRN_STEP_UNREADABLE, KRN_STEP_TESSELLATED_ONLY, KRN_STEP_NO_SOLID, KRN_HEAL_FAILED. format: "iges" reads an IGES file the same way (import_iges adds the IGES census, sewing report and unit handling).',
  params: importStepExactParams,
  run,
});
