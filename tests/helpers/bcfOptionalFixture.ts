/**
 * Hand-written BCF archives that are valid against the buildingSMART schemas (docs/plant/09-.../validation/data/bcf_*) and use optional elements export_bcf
 * never writes: another tool's file. Shared by tests/unit/review/bcfImportIgnored.test.ts (import reports what it drops) and server/tests/bcfSchema.test.ts
 * (xmllint proves the fixtures are schema-valid, so the test is not fed a file the schema would refuse).
 */
import { zipStore } from '@lib/zip';

const TOPIC = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const VIEW = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const COMMENT = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const RELATED = '3f2504e0-4f89-41d3-9a0c-0305e82c3304';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

export interface OptionalFixture {
  readonly files: Readonly<Record<string, string>>;
  readonly archive: Uint8Array;
  /** The ignored names the import must report (all of them foreign: export_bcf writes none). */
  readonly expectedIgnored: readonly string[];
}

const COMPONENT =
  '<Component IfcGuid="0$WU4A9Qn7s8VmWqE3Sk1Q"><OriginatingSystem>Other</OriginatingSystem><AuthoringToolId>x</AuthoringToolId></Component>';
const CAMERA =
  '<CameraViewPoint><X>1</X><Y>2</Y><Z>3</Z></CameraViewPoint><CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>' +
  '<CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>';

function build(files: Record<string, string>, expectedIgnored: readonly string[]): OptionalFixture {
  return { files, archive: zipStore(Object.entries(files).map(([name, text]) => ({ name, data: encode(text) }))), expectedIgnored };
}

export function optionalFixture30(): OptionalFixture {
  const markup =
    `${HEADER}<Markup><Header><Files><File IfcProject="0$WU4A9Qn7s8VmWqE3Sk1Q" IsExternal="false"><Filename>model.ifc</Filename></File></Files></Header>` +
    `<Topic Guid="${TOPIC}" ServerAssignedId="BIM-7" TopicType="Issue" TopicStatus="Open">` +
    '<ReferenceLinks><ReferenceLink>https://example.com/issue/7</ReferenceLink></ReferenceLinks><Title>Beam clash</Title><Priority>High</Priority><Index>3</Index>' +
    '<Labels><Label>structure</Label></Labels><CreationDate>2026-01-01T10:00:00Z</CreationDate><CreationAuthor>a@example.com</CreationAuthor>' +
    '<ModifiedDate>2026-01-02T10:00:00Z</ModifiedDate><ModifiedAuthor>b@example.com</ModifiedAuthor><DueDate>2026-03-01T00:00:00Z</DueDate>' +
    '<AssignedTo>c@example.com</AssignedTo><Stage>Design</Stage><Description>Beam hits duct</Description>' +
    '<BimSnippet SnippetType="clash"><Reference>snippet.json</Reference><ReferenceSchema>https://example.com/s</ReferenceSchema></BimSnippet>' +
    '<DocumentReferences><DocumentReference Guid="3f2504e0-4f89-41d3-9a0c-0305e82c3309"><Url>https://example.com/spec.pdf</Url></DocumentReference></DocumentReferences>' +
    `<RelatedTopics><RelatedTopic Guid="${RELATED}"/></RelatedTopics>` +
    `<Comments><Comment Guid="${COMMENT}"><Date>2026-01-01T11:00:00Z</Date><Author>a@example.com</Author><Comment>Please check</Comment>` +
    `<Viewpoint Guid="${VIEW}"/><ModifiedDate>2026-01-01T12:00:00Z</ModifiedDate><ModifiedAuthor>a@example.com</ModifiedAuthor></Comment></Comments>` +
    `<Viewpoints><ViewPoint Guid="${VIEW}"><Viewpoint>vp.bcfv</Viewpoint><Snapshot>vp.png</Snapshot><Index>0</Index></ViewPoint></Viewpoints>` +
    '</Topic></Markup>\n';
  const visinfo =
    `${HEADER}<VisualizationInfo Guid="${VIEW}"><Components><Selection>${COMPONENT}</Selection>` +
    `<Visibility DefaultVisibility="true"><ViewSetupHints SpacesVisible="true"/><Exceptions>${COMPONENT}</Exceptions></Visibility>` +
    `<Coloring><Color Color="FF0000"><Components>${COMPONENT}</Components></Color></Coloring></Components>` +
    `<PerspectiveCamera>${CAMERA}<FieldOfView>60</FieldOfView><AspectRatio>1.5</AspectRatio></PerspectiveCamera>` +
    '<Lines><Line><StartPoint><X>0</X><Y>0</Y><Z>0</Z></StartPoint><EndPoint><X>1</X><Y>1</Y><Z>1</Z></EndPoint></Line></Lines>' +
    '<ClippingPlanes><ClippingPlane><Location><X>0</X><Y>0</Y><Z>1</Z></Location><Direction><X>0</X><Y>0</Y><Z>1</Z></Direction></ClippingPlane></ClippingPlanes>' +
    '<Bitmaps><Bitmap><Format>png</Format><Reference>b.png</Reference><Location><X>0</X><Y>0</Y><Z>0</Z></Location><Normal><X>0</X><Y>0</Y><Z>1</Z></Normal>' +
    '<Up><X>0</X><Y>1</Y><Z>0</Z></Up><Height>2</Height></Bitmap></Bitmaps></VisualizationInfo>\n';
  return build({ 'bcf.version': `${HEADER}<Version VersionId="3.0"/>\n`, [`${TOPIC}/markup.bcf`]: markup, [`${TOPIC}/vp.bcfv`]: visinfo }, [
    'Markup/Header',
    'Topic/@ServerAssignedId',
    'Topic/ReferenceLinks',
    'Topic/Index',
    'Topic/ModifiedDate',
    'Topic/ModifiedAuthor',
    'Topic/Stage',
    'Topic/BimSnippet',
    'Topic/DocumentReferences',
    'Topic/RelatedTopics',
    'Comment/ModifiedDate',
    'Comment/ModifiedAuthor',
    'ViewPoint/Index',
    'Visibility/ViewSetupHints',
    'VisualizationInfo/Lines',
    'VisualizationInfo/ClippingPlanes',
    'VisualizationInfo/Bitmaps',
  ]);
}

export function optionalFixture21(): OptionalFixture {
  const markup =
    `${HEADER}<Markup><Header><File IfcProject="0$WU4A9Qn7s8VmWqE3Sk1Q"><Filename>model.ifc</Filename></File></Header>` +
    `<Topic Guid="${TOPIC}" TopicType="Issue" TopicStatus="Open"><ReferenceLink>https://example.com/7</ReferenceLink><Title>Beam clash</Title>` +
    '<Priority>High</Priority><Index>1</Index><Labels>structure</Labels><CreationDate>2026-01-01T10:00:00Z</CreationDate><CreationAuthor>a@example.com</CreationAuthor>' +
    '<ModifiedDate>2026-01-02T10:00:00Z</ModifiedDate><Stage>Design</Stage><Description>Beam hits duct</Description>' +
    `<RelatedTopic Guid="${RELATED}"/></Topic>` +
    `<Comment Guid="${COMMENT}"><Date>2026-01-01T11:00:00Z</Date><Author>a@example.com</Author><Comment>Please check</Comment><ModifiedDate>2026-01-01T12:00:00Z</ModifiedDate></Comment>` +
    `<Viewpoints Guid="${VIEW}"><Viewpoint>vp.bcfv</Viewpoint><Snapshot>vp.png</Snapshot><Index>0</Index></Viewpoints></Markup>\n`;
  const visinfo =
    `${HEADER}<VisualizationInfo Guid="${VIEW}"><Components><Selection>${COMPONENT}</Selection><Visibility DefaultVisibility="true"/></Components>` +
    `<PerspectiveCamera>${CAMERA}<FieldOfView>60</FieldOfView></PerspectiveCamera>` +
    '<ClippingPlanes><ClippingPlane><Location><X>0</X><Y>0</Y><Z>1</Z></Location><Direction><X>0</X><Y>0</Y><Z>1</Z></Direction></ClippingPlane></ClippingPlanes>' +
    '</VisualizationInfo>\n';
  return build(
    {
      'bcf.version': `${HEADER}<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>\n`,
      [`${TOPIC}/markup.bcf`]: markup,
      [`${TOPIC}/vp.bcfv`]: visinfo,
    },
    [
      'Markup/Header',
      'Topic/ReferenceLink',
      'Topic/Index',
      'Topic/ModifiedDate',
      'Topic/Stage',
      'Topic/RelatedTopic',
      'Comment/ModifiedDate',
      'ViewPoint/Index',
      'VisualizationInfo/ClippingPlanes',
    ],
  );
}
