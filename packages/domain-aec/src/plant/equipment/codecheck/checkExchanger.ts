/**
 * Findings of `check_equipment` for one exchanger (plant 03 EQP §4, §7): the pressure parts are judged with the vessel formulas of `asmeThickness` on
 * equivalent cylinders - the shell (and the shell cover of a U / floating rear) against `design.shellSide`, each channel and bonnet against
 * `design.tubeSide`. Flat covers, tubesheets and tubes are outside the formulas (named in `notChecked`). Pure; the findings are data.
 */

import type { EquipmentElement } from '@aec/building/types';
import type { HeadSpec } from '../model';
import type { ExchangerEnd } from '../geometry/exchangerFrame';
import { resolveExchanger } from '../geometry/exchangerFrame';
import type { ExchangerSideDesign, ExchangerTemplate, PlantEquipmentData, VesselTemplate } from '../plantData';
import { PLANT_EQUIPMENT_SCHEMA } from '../plantData';
import { asmeThickness, type CodeFinding } from './asme';
import { COVERAGE_CODES, issuesOf, warning, type ElementCheck, type Found } from './findings';
import { nozzleFindings } from './nozzleFindings';
import { appendAll } from '@lib/appendAll';

const ELLIPSOIDAL: HeadSpec = { type: 'ellipsoidal', ratio: 2 };
const FLAT: HeadSpec = { type: 'flat' };

export const EXCHANGER_REVIEW_REASON =
  'exchanger pressure parts judged by llull with the ASME VIII-1 formulas where design data allow; tubesheets, tubes and covers are not judged; not a stamped design';

const NOT_CHECKED = [
  'tubesheet thickness (TEMA RCB) and tube-to-tubesheet joints',
  'tubes (external pressure, tube-side vs shell-side differential)',
  'flat covers (UG-34), including the thick cover of front head D',
  'kettle transition cone (UG-33 / Appendix 1-5) and kettle weir',
  'floating head, U-bends, expansion joints, differential thermal expansion',
  'nozzle reinforcement (UG-37) and nozzle loads',
  'saddle loads and nozzles over a saddle',
];

/** One pressure cylinder with a head at its outer end, judged as a small horizontal vessel under one side's design data. */
interface Piece {
  readonly name: string;
  /** Param path of its wall thickness. */
  readonly thicknessPath: string;
  readonly headName: string | null;
  readonly headPath: string;
  readonly plant: PlantEquipmentData;
}

function pieceOf(
  template: ExchangerTemplate,
  side: ExchangerSideDesign | undefined,
  insideDiameter: number,
  piece: { name: string; thicknessPath: string; headName: string | null; headPath: string },
  length: number,
  thickness: number,
  head: HeadSpec,
): Piece {
  const vessel: VesselTemplate = {
    kind: 'vessel',
    orientation: 'horizontal',
    insideDiameter,
    tangentLength: length,
    heads: { first: head, second: head },
    shellThickness: thickness,
    headThickness: thickness,
    corrosionAllowance: template.corrosionAllowance,
    support: { type: 'none', baseElevation: 0 },
  };
  const design = side === undefined ? undefined : (({ specificGravity: _gravity, ...rest }) => rest)(side);
  return {
    ...piece,
    plant: { schema: PLANT_EQUIPMENT_SCHEMA, template: vessel, nozzles: [], ...(design === undefined ? {} : { design }) },
  };
}

const channelPiece = (template: ExchangerTemplate, end: ExchangerEnd, name: 'front' | 'rear', channelName: string): Piece | null => {
  const channel = name === 'front' ? template.frontChannel : template.rearChannel;
  if (channel === undefined || end.channelLength <= 0) return null;
  const bonnet = end.closure === 'bonnet';
  return pieceOf(
    template,
    template.design?.tubeSide,
    template.shellInsideDiameter,
    {
      name: channelName,
      thicknessPath: `${channelName}.thickness`,
      headName: bonnet ? `${name}Bonnet` : `${name}Cover`,
      headPath: `${channelName}.thickness`,
    },
    channel.length,
    channel.thickness,
    bonnet ? ELLIPSOIDAL : FLAT,
  );
};

/** The path of a finding of the equivalent vessel, expressed in exchanger params. */
function exchangerPath(path: string, side: 'shellSide' | 'tubeSide', piece: Piece): string {
  if (path.startsWith('design.')) return `design.${side}.${path.slice('design.'.length)}`;
  if (path === 'shellThickness') return piece.thicknessPath;
  if (path === 'headThickness' || path.startsWith('heads.')) return piece.headPath;
  return path;
}

function judge(side: 'shellSide' | 'tubeSide', designPresent: boolean, pieces: readonly Piece[], mmPerUnit: number): Found[] {
  const found: Found[] = [];
  if (!designPresent) {
    found.push(
      warning(
        'EQP_DESIGN_DATA_MISSING',
        `no design.${side}: the ${side === 'shellSide' ? 'shell' : 'channels and bonnets'} cannot be judged`,
        `design.${side}`,
      ),
    );
    return found;
  }
  for (const piece of pieces) {
    const result = asmeThickness(piece.plant, { mmPerUnit, corroded: true });
    const move = (finding: CodeFinding, message?: string): CodeFinding => ({
      code: finding.code,
      message: message ?? finding.message,
      paths: finding.paths.map((path) => exchangerPath(path, side, piece)),
    });
    if ('refusal' in result) {
      const code = COVERAGE_CODES.includes(result.refusal.code) ? result.refusal.code : 'EQP_PARAM_INVALID';
      found.push({ severity: 'warning', finding: move({ ...result.refusal, code }, `${side}: ${result.refusal.message}`) });
      break;
    }
    for (const part of result.parts) {
      const label = part.key === 'shell' ? piece.name : part.key === 'headRight' ? piece.headName : null;
      if (label === null) continue;
      if ('refusal' in part) found.push({ severity: 'warning', finding: move(part.refusal, `${label}: ${part.refusal.message}`) });
      else {
        for (const code of part.result.failures) {
          const text =
            code === 'EQP_MAWP_BELOW_DESIGN'
              ? `${label} MAWP ${part.result.mawpMPa.toPrecision(6)} MPa is below the ${side} design pressure ${result.pressureMPa} MPa`
              : `${label} available thickness ${part.result.availableThicknessMm.toPrecision(6)} mm is below the required ${part.result.requiredCorrodedThicknessMm.toPrecision(6)} mm (corroded)`;
          found.push({
            severity: 'fail',
            finding: { code, message: text, paths: [part.key === 'shell' ? piece.thicknessPath : piece.headPath] },
          });
        }
      }
    }
    for (const note of result.warnings) found.push({ severity: 'warning', finding: move(note) });
  }
  return found;
}

/**
 * @param element an exchanger (`plant.template.kind === 'exchanger'`)
 * @invariant fails only on computed under-thickness / MAWP below the side's design pressure; a side or part the formulas cannot judge is a warning, never a pass;
 *   reviewRequired is always true (pressure equipment whose tubesheets and tubes are never judged here)
 */
export function checkExchanger(element: EquipmentElement, mmPerUnit: number): ElementCheck {
  const plant = element.plant;
  if (plant === undefined || plant.template.kind !== 'exchanger') return { issues: [], reviewRequired: false };
  const { template } = plant;
  const geometry = resolveExchanger(template);
  const { kettle } = template;
  const coverOnShell = geometry.rear.closure === 'shell_cover';
  const length = (name: string): number => {
    const segment = geometry.segments.find((candidate) => candidate.name === name);
    return segment === undefined ? 0 : segment.to - segment.from;
  };
  const shellPieces: Piece[] = [
    pieceOf(
      template,
      template.design?.shellSide,
      template.shellInsideDiameter,
      {
        name: 'shell',
        thicknessPath: 'shellThickness',
        headName: coverOnShell && kettle === undefined ? 'shellCover' : null,
        headPath: 'shellThickness',
      },
      kettle === undefined ? geometry.shellLength : length('shell'),
      template.shellThickness,
      ELLIPSOIDAL,
    ),
    ...(kettle === undefined
      ? []
      : [
          pieceOf(
            template,
            template.design?.shellSide,
            kettle.enlargedInsideDiameter,
            {
              name: 'kettleShell',
              thicknessPath: 'kettle.enlargedThickness',
              headName: coverOnShell ? 'shellCover' : null,
              headPath: 'kettle.enlargedThickness',
            },
            length('kettleShell'),
            kettle.enlargedThickness,
            ELLIPSOIDAL,
          ),
        ]),
  ];
  const tubePieces = [
    channelPiece(template, geometry.front, 'front', 'frontChannel'),
    channelPiece(template, geometry.rear, 'rear', 'rearChannel'),
  ].flatMap((piece) => piece ?? []);
  const shell = judge('shellSide', template.design?.shellSide !== undefined, shellPieces, mmPerUnit);
  const tube = judge('tubeSide', template.design?.tubeSide !== undefined, tubePieces, mmPerUnit);
  const found: Found[] = [...shell, ...tube];
  if (kettle !== undefined && template.defaulted.includes('kettle.enlargedThickness'))
    found.push(
      warning(
        'EQP_DESIGN_DATA_MISSING',
        `kettle.enlargedThickness was not given: the shell thickness ${template.shellThickness} was assumed`,
        'kettle.enlargedThickness',
      ),
    );
  for (const name of ['frontChannel', 'rearChannel'])
    if (template.defaulted.includes(`${name}.thickness`))
      found.push(
        warning(
          'EQP_DESIGN_DATA_MISSING',
          `${name}.thickness was not given: the shell thickness ${template.shellThickness} was assumed`,
          `${name}.thickness`,
        ),
      );
  if (template.tema.shell === 'X') {
    const angles = plant.nozzles.flatMap((nozzle) => (nozzle.location.on === 'shell' ? [nozzle.location.orientationDeg] : []));
    const opposite = angles.some((a, i) => angles.some((b, j) => i < j && Math.abs(((((a - b) % 360) + 360) % 360) - 180) < 1e-6));
    if (!opposite)
      found.push(
        warning(
          'EQP_X_SHELL_NOZZLES',
          'TEMA X (cross flow) takes the shell fluid across the bundle from one side to the opposite side: no pair of shell nozzles 180 deg apart (add_nozzle on the shell)',
          'nozzles',
        ),
      );
  }
  if (template.tubes.wallUnverified)
    found.push(warning('EQP_TABLE_UNVERIFIED', `tube wall from a grade B table row (${template.tubes.wallSource})`, 'tubes.wallThickness'));
  appendAll(found, nozzleFindings(template, plant.nozzles));
  return { issues: issuesOf(element, found), reviewRequired: true, reviewReason: EXCHANGER_REVIEW_REASON, notChecked: NOT_CHECKED };
}
