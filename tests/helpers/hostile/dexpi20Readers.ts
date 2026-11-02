/** Hostile-input table: DEXPI 2.0 XML (plant 04 PID M6): the 2.0 translation, the diagram reader and the schema check, through `readDexpi` and `import_dexpi`. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { readDexpi } from '@aec/plant/pid/dexpi/proteusRead';
import { asText, repeated, type HostileReader } from './types';

const HEAD =
  '<?xml version="1.0"?><Model name="m" uri="urn:m"><Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>' +
  '<Import prefix="Plant" source="https://data.dexpi.org/models/2.0.1/Plant.xml"/><Object type="Core/EngineeringModel"><Components property="ConceptualModel"><Object id="P" type="Plant/PlantModel">';
const TAIL = '</Object></Components></Object></Model>';
const wrap = (property: string, body: string): string => `<Components property="${property}">${body}</Components>`;

const equipment = (k: number): string =>
  `<Object id="E${k}" type="Plant/ProcessEquipment.Tank"><Data property="TagName"><String>T-${k}</String></Data>` +
  `${wrap('Nozzles', `<Object id="N${k}" type="Plant/ProcessEquipment.ProcessNozzle">${wrap('Nodes', `<Object id="NN${k}" type="Plant/Piping.PipingNode"/>`)}</Object>`)}</Object>`;
const system = (k: number): string =>
  `<Object id="L${k}" type="Plant/Piping.PipingNetworkSystem">${wrap(
    'Segments',
    `<Object id="S${k}" type="Plant/Piping.PipingNetworkSegment">${wrap(
      'Connections',
      `<Object id="Q${k}" type="Plant/Piping.Pipe"><References objects="#N${k}" property="SourceItem"/><References objects="#V${k}" property="TargetItem"/></Object>`,
    )}${wrap('Items', `<Object id="V${k}" type="Plant/Piping.BallValve">${wrap('Nodes', `<Object id="VN${k}" type="Plant/Piping.PipingNode"/>`)}</Object>`)}` +
      `<References objects="#N${k}" property="SourceItem"/><References objects="#V${k}" property="TargetItem"/></Object>`,
  )}</Object>`;

/** `records` equipment and `records` systems, each kind in its own `Components`. */
const buildGrouped = (records: number): string =>
  HEAD +
  wrap('TaggedPlantItems', repeated('', equipment, '', Math.max(records, 1))) +
  wrap('PipingNetworkSystems', repeated('', system, '', Math.max(records, 1))) +
  TAIL;

const nest = (depth: number): string =>
  HEAD +
  wrap(
    'TaggedPlantItems',
    '<Object type="Plant/ProcessEquipment.Tank">' +
      '<Components property="Chambers"><Object type="Plant/ProcessEquipment.Chamber">'.repeat(depth) +
      '</Object></Components>'.repeat(depth) +
      '</Object>',
  ) +
  TAIL;

export const DEXPI20_READERS: readonly HostileReader[] = [
  {
    name: 'plant: readDexpi (DEXPI 2.0 XML)',
    covers: ['domain-aec/src/plant/pid/dexpi20/from20.ts:proteusFrom20', 'domain-aec/src/plant/pid/dexpi20/schemaCheck.ts:checkDexpi20'],
    input: 'text',
    build: buildGrouped,
    nest,
    budgetMs: 10_000,
    extra: [
      {
        name: 'prototype-key ids, property names and references',
        input: () =>
          HEAD +
          wrap(
            'TaggedPlantItems',
            ['constructor', '__proto__', 'toString', 'hasOwnProperty']
              .map(
                (id) =>
                  `<Object id="${id}" type="Plant/ProcessEquipment.Tank"><Data property="__proto__"><String>x</String></Data><References objects="#${id} #constructor" property="constructor"/></Object>`,
              )
              .join(''),
          ) +
          wrap(
            'PipingNetworkSystems',
            '<Object id="valueOf" type="Plant/Piping.PipingNetworkSystem">' +
              wrap(
                'Segments',
                '<Object id="__defineGetter__" type="Plant/Piping.PipingNetworkSegment"><References objects="#constructor" property="SourceItem"/></Object>',
              ) +
              '</Object>',
          ) +
          TAIL,
      },
      {
        name: 'many references to unknown ids',
        input: () =>
          HEAD +
          repeated(
            '<Object type="Plant/Piping.PipingNetworkSystem"><References objects="',
            (k) => `#x${k} `,
            '" property="p"/></Object>',
            100_000,
          ) +
          TAIL,
      },
      {
        name: 'one 2 MB string value',
        input: () =>
          HEAD +
          wrap(
            'MetaData',
            `<Object type="Plant/Diagram.PlantMetaData"><Data property="D"><String>${'x'.repeat(2_000_000)}</String></Data></Object>`,
          ) +
          TAIL,
      },
      {
        name: 'many unknown component properties',
        input: () => HEAD + repeated('', (k) => wrap(`P${k}`, '<Object type="Plant/X.Y"/>'), '', 50_000) + TAIL,
      },
      {
        name: '200 000 ids in one reference',
        input: () =>
          HEAD +
          `<Object type="Plant/Piping.PipingNetworkSystem"><References objects="${repeated('', (k) => `#n${k} `, '', 200_000)}" property="SourceItem"/></Object>` +
          TAIL,
      },
    ],
    read: (input) => readDexpi(asText(input), 'pid-1.1', 'auto'),
    accepts: (result) => (result as { ok: boolean }).ok && (result as { version: string }).version === '2.0',
  },
  {
    name: 'plant: import_dexpi (execute, DEXPI 2.0)',
    covers: ['import_dexpi'],
    input: 'text',
    build: buildGrouped,
    nest,
    budgetMs: 10_000,
    read: (input) => execute(createEmptyDocument(), 'import_dexpi', { text: asText(input), version: '2.0' }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('import_dexpi: DEXPI 2.0'),
  },
];
