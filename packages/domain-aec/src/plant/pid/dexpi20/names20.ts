/**
 * Names of the DEXPI 2.0 encoding (plant 04 PID §6.2) shared by the reader and the writer: object ids, property names of attributes, enumeration and
 * unit references. Every function pair is a bijection on the values llull produces, so a model written as 2.0 and read back keeps its names.
 */

/** `[A-Za-z_][A-Za-z_0-9]*`, the XSD `name` pattern. */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z_0-9]*$/;

const ESCAPE = /_x([0-9A-F]{4,6})_/g;
/** Any text as a 2.0 name: every character outside [A-Za-z0-9] (the underscore included) and a leading digit becomes _xHHHH_, so the output has no bare underscore and decoding is a plain left-to-right replace (a bijection). */
export function encodeName(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    index += char.length;
    const plain = /[A-Za-z]/.test(char) || (out !== '' && /[0-9]/.test(char));
    out += plain ? char : `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
  }
  return out === '' ? '_x0020_' : out;
}

export const decodeName = (name: string): string =>
  name.replace(ESCAPE, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });

/** Property name prefix for attributes llull keeps under their own name (no DEXPI 2.0 name known): `Llull_<encoded name>`. */
const OWN_PREFIX = 'Llull_';

/** The property that marks an information flow the Proteus file ends by associations only (no `Connection` element): `Llull_` + `dexpi:association`. */
export const ASSOCIATION_PROPERTY = `${OWN_PREFIX}dexpi_x003A_association`;

export type ValueKind = 'text' | 'quantity' | 'enum';

/** DEXPI 1.3 attribute names whose 2.0 name is not "1.3 name without the AssignmentClass / Specialization suffix". */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  ['AreaIsa95NameAssignmentClass', 'PlantAreaName'],
  ['UnitIsa95NameAssignmentClass', 'UnitName'],
  ['NominalCapacity(Volume)', 'NominalCapacityVolume'],
];
const TO_20 = new Map(RENAMED);
const TO_13 = new Map(RENAMED.map(([a, b]) => [b, a]));

const SUFFIX: Readonly<Record<ValueKind, string>> = { text: 'AssignmentClass', quantity: '', enum: 'Specialization' };

/** The 1.3 name an attribute of `kind` has for the 2.0 `property` (the suffix DEXPI 1.3 appends to strings and enumerations). */
export function attributeName(property: string, kind: ValueKind): string {
  if (property.startsWith(OWN_PREFIX)) return decodeName(property.slice(OWN_PREFIX.length));
  return TO_13.get(property) ?? `${property}${SUFFIX[kind]}`;
}

/** The 2.0 property of a 1.3 attribute `name`; a name the reverse rule would not give back is kept under `Llull_`. */
export function attributeProperty(name: string, kind: ValueKind): string {
  const renamed = TO_20.get(name);
  if (renamed !== undefined) return renamed;
  const suffix = SUFFIX[kind];
  const stripped = suffix !== '' && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  return NAME_PATTERN.test(stripped) && !stripped.startsWith(OWN_PREFIX) && attributeName(stripped, kind) === name
    ? stripped
    : `${OWN_PREFIX}${encodeName(name)}`;
}

/** Unit name -> `Core/PhysicalQuantities` unit class (the classes of the DEXPI 2.0 reference file where it has one). */
const UNIT_CLASSES: Readonly<Record<string, string>> = {
  Millimetre: 'LengthUnit',
  Centimetre: 'LengthUnit',
  Metre: 'LengthUnit',
  Bar: 'PressureGaugeUnit',
  Pascal: 'PressureUnit',
  KiloPascal: 'PressureUnit',
  MegaPascal: 'PressureUnit',
  DegreeCelsius: 'TemperatureUnit',
  Kelvin: 'TemperatureUnit',
  Percent: 'PercentUnit',
  Watt: 'PowerUnit',
  Kilowatt: 'PowerUnit',
  Kilogram: 'MassUnit',
  SquareMetre: 'AreaUnit',
  MetreSquared: 'AreaUnit',
  CubicMetre: 'VolumeUnit',
  MetreCubed: 'VolumeUnit',
  Litre: 'VolumeUnit',
  CubicMetrePerHour: 'VolumeFlowRateUnit',
  MetreCubedPerHour: 'VolumeFlowRateUnit',
  KilowattPerSquareMetreKelvin: 'HeatTransferCoefficientUnit',
  ReciprocalMinute: 'RotationalFrequencyUnit',
  MetrePerSecond: 'VelocityUnit',
  Hertz: 'FrequencyUnit',
  Joule: 'EnergyUnit',
  Kilojoule: 'EnergyUnit',
  Newton: 'ForceUnit',
  Second: 'TimeUnit',
  Minute: 'TimeUnit',
  Hour: 'TimeUnit',
};

export const unitReference = (unit: string): string =>
  `Core/PhysicalQuantities.${Object.hasOwn(UNIT_CLASSES, unit) ? UNIT_CLASSES[unit] : 'Unit'}.${encodeName(unit)}`;

/** The unit name at the end of a unit reference (`Core/PhysicalQuantities.PressureGaugeUnit.Bar` -> `Bar`). */
export const unitOfReference = (reference: string): string => decodeName(reference.slice(reference.lastIndexOf('.') + 1));

/** `Plant/Enumerations.<Property>Classification.<Value>`; a reference kept from a 2.0 file is written as it was read. */
export function enumReference(property: string, value: string, kept: string | undefined): string {
  if (kept !== undefined && /^(Core|Plant)\//.test(kept) && kept.endsWith(`.${encodeName(value)}`)) return kept;
  return `Plant/Enumerations.${NAME_PATTERN.test(property) ? property : encodeName(property)}Classification.${encodeName(value)}`;
}

/** The value at the end of an enumeration reference. */
export const valueOfReference = (reference: string): string => decodeName(reference.slice(reference.lastIndexOf('.') + 1));
