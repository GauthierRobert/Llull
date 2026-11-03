/** Hostile-input table: BCF 2.1 / 3.0 archives and viewpoint XML (plant 09 VIS-M5), through `import_bcf` and `import_bcf_viewpoint`. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { zipStore } from '@lib/zip';
import { asBytes, asText, repeated, type HostileReader } from './types';

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const guid = (k: number): string => `${(k + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;

const CAMERA =
  '<PerspectiveCamera><CameraViewPoint><X>1</X><Y>-2</Y><Z>3</Z></CameraViewPoint><CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>' +
  '<CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>60</FieldOfView></PerspectiveCamera>';

const topic = (k: number): { name: string; data: Uint8Array }[] => [
  {
    name: `${guid(k)}/markup.bcf`,
    data: enc(
      `${HEAD}<Markup><Topic Guid="${guid(k)}" TopicType="Issue" TopicStatus="Open"><Title>t${k}</Title><Priority>high</Priority>` +
        `<Comments><Comment Guid="${guid(k + 100000)}"><Date>2026-01-01T00:00:00Z</Date><Author>a</Author><Comment>c${k}</Comment></Comment></Comments>` +
        `<Viewpoints><ViewPoint Guid="${guid(k + 200000)}"><Viewpoint>v.bcfv</Viewpoint></ViewPoint></Viewpoints></Topic></Markup>`,
    ),
  },
  { name: `${guid(k)}/v.bcfv`, data: enc(`${HEAD}<VisualizationInfo Guid="${guid(k + 200000)}">${CAMERA}</VisualizationInfo>`) },
];

const archive = (records: number): Uint8Array =>
  zipStore([
    { name: 'bcf.version', data: enc(`${HEAD}<Version VersionId="3.0" />`) },
    ...Array.from({ length: records }, (_, k) => topic(k)).flat(),
  ]);

const bytesOf = (text: string): Uint8Array => enc(text);

export const BCF_READERS: readonly HostileReader[] = [
  {
    name: 'bcf: import_bcf (execute, zip of topics)',
    covers: ['import_bcf', 'core/src/commands/exchange/bcf/bcfRead.ts:readBcfArchive'],
    input: 'bytes',
    build: archive,
    read: (input) => execute(createEmptyDocument(), 'import_bcf', { bcf: Buffer.from(asBytes(input)).toString('base64') }),
    accepts: (result) => (result as { affected: string[] }).affected.length === 3,
    maxRecords: 1 << 12,
    extra: [
      {
        name: 'markup with a DOCTYPE entity bomb',
        input: () =>
          zipStore([
            { name: 'bcf.version', data: bytesOf(`${HEAD}<Version VersionId="3.0" />`) },
            {
              name: `${guid(1)}/markup.bcf`,
              data: bytesOf(
                `${HEAD}<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><Markup>&b;</Markup>`,
              ),
            },
          ]),
      },
      {
        name: 'thousands of comments and viewpoints in one topic',
        input: () =>
          zipStore([
            { name: 'bcf.version', data: bytesOf(`${HEAD}<Version VersionId="2.1" />`) },
            {
              name: `${guid(1)}/markup.bcf`,
              data: bytesOf(
                repeated(
                  `${HEAD}<Markup><Topic Guid="${guid(1)}"><Title>t</Title></Topic>`,
                  (k) =>
                    `<Comment Guid="${guid(k)}"><Comment>x${k}</Comment></Comment><Viewpoints Guid="${guid(k)}"><Viewpoint>v.bcfv</Viewpoint></Viewpoints>`,
                  '</Markup>',
                  20_000,
                ),
              ),
            },
          ]),
      },
      {
        name: 'names climbing out of the archive',
        input: () =>
          zipStore([
            { name: 'bcf.version', data: bytesOf('x') },
            { name: `../../${guid(1)}/markup.bcf`, data: bytesOf('x') },
          ]),
      },
    ],
  },
  {
    name: 'bcf: import_bcf_viewpoint (execute, VisualizationInfo XML)',
    covers: ['import_bcf_viewpoint', 'core/src/commands/exchange/bcf/bcfVisualizationRead.ts:parseVisualizationInfo'],
    input: 'text',
    build: (records) =>
      repeated(
        `${HEAD}<VisualizationInfo Guid="${guid(1)}"><Components><Selection>`,
        (k) => `<Component><OriginatingSystem>llull</OriginatingSystem><AuthoringToolId>box-${k}</AuthoringToolId></Component>`,
        `</Selection></Components>${CAMERA}</VisualizationInfo>`,
        records,
      ),
    nest: (depth) =>
      `${HEAD}<VisualizationInfo>${'<Components>'.repeat(depth)}${'</Components>'.repeat(depth)}${CAMERA}</VisualizationInfo>`,
    read: (input) => execute(createEmptyDocument(), 'import_bcf_viewpoint', { visualizationInfo: asText(input), name: 'v' }),
    accepts: (result) => (result as { affected: string[] }).affected.length === 1,
    maxRecords: 1 << 14,
  },
];
