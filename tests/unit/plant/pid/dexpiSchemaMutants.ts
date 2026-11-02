/** Instances that break exactly one rule of DEXPI_XML_Schema.xsd each; checked against a real XSD engine (JDK Xerces, xmllint) when the schema check was written. */

const IMPORT = '<Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>';
const model = (body: string, attributes = 'name="m" uri="urn:m"', head = IMPORT): string => `<Model ${attributes}>${head}${body}</Model>`;
const object = (inner: string, attributes = 'id="a" type="Plant/PlantModel"'): string => `<Object ${attributes}>${inner}</Object>`;

export const VALID_MINIMAL = model(
  object(
    '<Components property="Items"><Object id="b" type="Plant/Piping.Pipe"><Data property="Length"><AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">' +
      '<Data property="Unit"><DataReference data="Core/PhysicalQuantities.LengthUnit.Metre"/></Data><Data property="Value"><Double>1.5e3</Double></Data></AggregatedDataValue></Data>' +
      '<Data property="Flag"><Boolean>true</Boolean></Data><Data property="N"><Integer>-4</Integer></Data><Data property="T"><String> </String></Data><Data property="U"><Undefined/></Data>' +
      '<References objects="#a #b" property="Next"/></Object><ObjectReference object="#a"/></Components>',
  ),
);

/** name -> [instance, a fragment of the message the check gives]. */
export const SCHEMA_MUTANTS: ReadonlyArray<readonly [string, string, string]> = [
  ['an Object without type', model(object('', 'id="a"')), 'needs attribute "type"'],
  ['a type that is not a name reference', model(object('', 'id="a" type="Plant"')), 'does not match nameReference'],
  ['an id with a hyphen', model(object('', 'id="a-b" type="Plant/X"')), 'is not a valid name'],
  ['an id that starts with a digit', model(object('', 'id="1a" type="Plant/X"')), 'is not a valid name'],
  ['the same id twice', model(object('', 'id="a" type="Plant/X"') + object('', 'id="a" type="Plant/X"')), 'is used twice'],
  ['an Object with an unknown attribute', model(object('', 'id="a" type="Plant/X" colour="red"')), 'attribute "colour" is not allowed'],
  ['an Object with an unknown child', model(object('<Bogus/>')), '<Bogus> is not allowed in <Object>'],
  ['text in an Object', model(object('hello')), 'holds elements only'],
  ['an empty Components', model(object('<Components property="P"/>')), 'needs at least 1 child element'],
  ['a Components without property', model(object('<Components><Object type="Plant/X"/></Components>')), 'needs attribute "property"'],
  [
    'a Components with a Data child',
    model(object('<Components property="P"><Data property="Q"><String>x</String></Data></Components>')),
    '<Data> is not allowed in <Components>',
  ],
  ['a Data without value', model(object('<Data property="P"/>')), 'needs at least 1 child element'],
  ['a Data with a bad property', model(object('<Data property="a b"><String>x</String></Data>')), 'does not match nameOrNameReference'],
  ['a Double that is not a number', model(object('<Data property="P"><Double>abc</Double></Data>')), 'is not a valid Double'],
  ['an Integer with a fraction', model(object('<Data property="P"><Integer>1.5</Integer></Data>')), 'is not a valid Integer'],
  ['a Boolean that is not one', model(object('<Data property="P"><Boolean>yes</Boolean></Data>')), 'is not a valid Boolean'],
  ['a DateTime that is a date', model(object('<Data property="P"><DateTime>2026-01-01</DateTime></Data>')), 'is not a valid DateTime'],
  ['a DataReference without data', model(object('<Data property="P"><DataReference/></Data>')), 'needs attribute "data"'],
  ['an AggregatedDataValue without type', model(object('<Data property="P"><AggregatedDataValue/></Data>')), 'needs attribute "type"'],
  ['References with a plain name', model(object('<References objects="a" property="P"/>')), 'does not match nameOrIdReferences'],
  ['References with two spaces', model(object('<References objects="#a  #b" property="P"/>')), 'does not match nameOrIdReferences'],
  ['References without objects', model(object('<References property="P"/>')), 'needs attribute "objects"'],
  [
    'an ObjectReference without object',
    model(object('<Components property="P"><ObjectReference/></Components>')),
    'needs attribute "object"',
  ],
  ['a Model without uri', model('', 'name="m"'), 'needs attribute "uri"'],
  ['a Model whose name is not a name', model('', 'name="a b" uri="u"'), 'does not match name'],
  ['an Import without prefix', model('', 'name="m" uri="u"', '<Import source="x"/>'), 'needs attribute "prefix"'],
  [
    'an Import after an Object',
    `<Model name="m" uri="u">${object('', 'type="Plant/X"')}${IMPORT}</Model>`,
    'comes after a later kind of child',
  ],
  [
    'an Undefined with a child',
    model(object('<Data property="P"><Undefined><X/></Undefined></Data>')),
    '<X> is not allowed in <Undefined>',
  ],
];
