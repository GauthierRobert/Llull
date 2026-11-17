/** The data payload and summary of a committed emboss_on_face chain (03 WRP M5). */

import type { CadDocument } from '../../model/types';
import type { EmbossParams } from '../../model/wrap';
import { embossClosedForm } from '../../geometry/embossVolume';
import type { Chain, ChainFace } from './chainCharts';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, namedDefault, wrapData } from './conventions';
import type { MitreBuild } from './embossMitre';
import type { FaceRefInput, FaceSession } from './faceSession';
import type { ChartRegion } from './sketchProfiles';

export interface ChainStep {
  readonly face: ChainFace;
  readonly recipeParams: Omit<EmbossParams, 'face'>;
  readonly area: number;
  readonly probes: number;
}

export interface ChainOutcome {
  readonly doc: CadDocument;
  readonly command: string;
  readonly params: {
    readonly id: string;
    readonly profileIds: readonly string[];
    readonly mode: 'emboss' | 'deboss' | 'scribe' | 'engrave';
    readonly fitTolerance?: number | undefined;
    readonly maxLengthStrain?: number | undefined;
    readonly chain?: readonly FaceRefInput[] | undefined;
  };
  readonly session: FaceSession;
  readonly chain: Chain;
  readonly steps: readonly ChainStep[];
  readonly mitre: MitreBuild | null;
  readonly regions: readonly ChartRegion[];
  readonly depth: number;
  readonly tolerance: number;
  readonly unverified: boolean;
  readonly sketchArea: number;
  readonly clippedArea: number;
  readonly strain: number;
  readonly joinStrain: number;
  readonly limit: number;
  readonly volumeDelta: number | null;
  readonly expected: number;
}

export function chainData(o: ChainOutcome): ReturnType<typeof wrapData> {
  const { doc, params, session, chain, steps, mitre, regions, depth, tolerance, sketchArea, clippedArea, strain, joinStrain, limit } = o;
  const faces = steps.map((step) => ({
    face: step.face.session.face,
    ...(step.face.session.faceName !== undefined ? { faceName: step.face.session.faceName } : {}),
    faceKind: step.face.session.surface.type,
    regions: step.recipeParams.regions.length,
    area: step.area,
    expectedVolumeDelta: embossClosedForm(step.recipeParams)?.delta ?? null,
  }));
  return wrapData(
    doc,
    {
      volumeDelta: o.volumeDelta,
      expectedVolumeDelta: mitre !== null && !mitre.exact ? null : o.expected,
      regionArea: sketchArea,
      chainArea: clippedArea,
      regions: regions.length,
      mode: params.mode,
      depth,
      method: chain.method,
      exact: chain.developable,
      faces,
      ...(mitre === null
        ? {}
        : {
            mitre: {
              fillerVolume: mitre.fillerVolume,
              overlapVolume: mitre.overlapVolume,
              exact: mitre.exact,
              reasons: mitre.reasons,
              edges: mitre.edges,
            },
          }),
      chain: chain.faces.map((face) => face.session.face),
      edges: chain.edges.map((edge) => ({
        edge: edge.edge,
        faces: edge.faces,
        length: edge.length,
        convexity: edge.convexity,
        mismatch: edge.mismatch,
        windowLength: edge.windowLength,
        cutGap: edge.cutGap,
      })),
      distortion: {
        maxLengthStrain: Math.max(strain, joinStrain),
        curveStrain: strain,
        joinMismatch: joinStrain,
        meanLengthStrain: 0,
        areaRatio: 1,
        method: chain.method,
        limit,
        limitDefaulted: params.maxLengthStrain === undefined,
      },
    },
    {
      unverified: o.unverified,
      provenance: {
        method: `${params.mode} across ${steps.length} faces of a chain ${chain.developable ? 'unfolded by develop (isometry, strain 0)' : 'charted by geodesic charts anchored on the shared edges (stretch measured)'}: the sketch is cut at the chain edges and each part is embossed on its face as one exact kernel step`,
        inputs: { id: params.id, face: session.face, chain: params.chain, profileIds: params.profileIds, mode: params.mode, depth },
      },
      defaults: [
        ...(params.fitTolerance === undefined
          ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
          : []),
        ...(params.maxLengthStrain === undefined && !chain.developable
          ? [namedDefault('maxLengthStrain', DEFAULT_MAX_LENGTH_STRAIN, '1', MAX_LENGTH_STRAIN_SOURCE)]
          : []),
      ],
    },
  );
}

export function chainSummary(o: ChainOutcome, newId: string, triangles: number): string {
  const { doc, command, params, chain, steps, mitre, depth, sketchArea, strain, joinStrain, volumeDelta, expected } = o;
  const change =
    volumeDelta === null
      ? 'volume change not measured'
      : `volume ${volumeDelta >= 0 ? '+' : ''}${volumeDelta.toPrecision(9)} ${doc.units}^3 (closed form ${mitre !== null && !mitre.exact ? 'not exact' : expected.toPrecision(9)})`;
  const mitred =
    mitre === null
      ? ''
      : ` ${mitre.edges.map((e) => (e.kind === 'filler' ? `edge ${e.edge} mitred (filler ${(e.area * e.length).toPrecision(5)} ${doc.units}^3)` : `edge ${e.edge} slabs overlap (${(e.area * e.length).toPrecision(5)} ${doc.units}^3)`)).join(', ')}${mitre.exact ? '' : `; overlap not in the closed form (${mitre.reasons.join('; ')})`}.`;
  return `${command}: ${params.mode} of ${params.profileIds.length} profile(s) across ${steps.length} faces${chain.developable ? '' : ` (${chain.method}, max stretch ${(100 * Math.max(strain, joinStrain)).toPrecision(4)} %)`} (${steps.map((s) => `${s.face.session.surface.type} ${s.face.session.face}`).join(', ')}), sketch area ${sketchArea.toPrecision(8)} ${doc.units}^2, depth ${depth} of '${params.id}' → mesh '${newId}' (${triangles} triangles), ${change}.${mitred} Source solid consumed, profiles kept.`;
}
