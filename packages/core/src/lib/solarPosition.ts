/**
 * Solar position from the NOAA Global Monitoring Laboratory "General Solar Position Calculations" equations
 * (a truncated form of Meeus, Astronomical Algorithms 2nd ed., ch. 7, 22, 25, 28; azimuth from Meeus ch. 13).
 * Accuracy: a few hundredths of a degree for years 1900-2100 against the full NREL SPA (see tests); no parallax,
 * refraction (NOAA piecewise formula) reported separately. No host clock, no Date: a pure function of its arguments.
 * @pure
 */

export interface CivilDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Minutes east of UTC (the offset of the local time written in the other fields). */
  readonly offsetMinutes: number;
}

export interface SolarPosition {
  /** Degrees clockwise from true north, [0, 360). */
  readonly azimuthDeg: number;
  /** Geometric elevation above the horizon, degrees (no refraction). */
  readonly geometricElevationDeg: number;
  /** Elevation with atmospheric refraction (NOAA piecewise formula, standard atmosphere), degrees. */
  readonly elevationDeg: number;
  /** Solar declination, degrees. */
  readonly declinationDeg: number;
  /** Equation of time, minutes. */
  readonly equationOfTimeMinutes: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number): number => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
const mod = (x: number, m: number): number => ((x % m) + m) % m;

/** Days from 1970-01-01 to a proleptic Gregorian date (Hinnant's civil-days algorithm; integer arithmetic only). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Parses an ISO-8601 date-time that carries an explicit UTC offset (`Z` or `+hh:mm`); null when malformed, out of range or offset-less. */
export function parseIsoWithOffset(text: string): CivilDateTime | null {
  const m = ISO_PATTERN.exec(text);
  if (m === null) return null;
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const zone = m[7] ?? 'Z';
  const zoneMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  const offsetMinutes = zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + zoneMinutes);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) return null;
  if (year < 1800 || year > 2200 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (Math.abs(offsetMinutes) > 14 * 60 || zoneMinutes > 59) return null;
  return { year, month, day, hour, minute, second, offsetMinutes };
}

/** NOAA piecewise atmospheric refraction (degrees) for a geometric elevation in degrees. */
function refractionDeg(e: number): number {
  if (e > 85) return 0;
  const tan = Math.tan(e * RAD);
  if (e > 5) return (58.1 / tan - 0.07 / (tan * tan * tan) + 0.000086 / (tan * tan * tan * tan * tan)) / 3600;
  if (e > -0.575) return (1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)))) / 3600;
  return -20.774 / tan / 3600;
}

/** Solar position at `latitudeDeg` (north +) / `longitudeDeg` (east +) for a civil date-time. */
export function solarPosition(latitudeDeg: number, longitudeDeg: number, when: CivilDateTime): SolarPosition {
  const utcSeconds = when.hour * 3600 + when.minute * 60 + when.second - when.offsetMinutes * 60;
  const julianDay = 2440587.5 + daysFromCivil(when.year, when.month, when.day) + utcSeconds / 86400;
  const t = (julianDay - 2451545) / 36525;
  const meanLongitude = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = meanAnomaly * RAD;
  const centre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparentLongitude = (meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLongitude * RAD;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));
  const trueSolarMinutes = mod(utcSeconds / 60 + equationOfTime + 4 * longitudeDeg, 1440);
  const hourAngle = (trueSolarMinutes / 4 - 180) * RAD;
  const phi = latitudeDeg * RAD;
  const sinElevation = Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
  const geometricElevationDeg = Math.asin(Math.max(-1, Math.min(1, sinElevation))) * DEG;
  const azimuthDeg = mod(
    Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)) * DEG + 180,
    360,
  );
  return {
    azimuthDeg,
    geometricElevationDeg,
    elevationDeg: geometricElevationDeg + refractionDeg(geometricElevationDeg),
    declinationDeg: declination * DEG,
    equationOfTimeMinutes: equationOfTime,
  };
}

/** Unit vector toward the sun in plan axes (+X, +Y, +Z up) for a compass azimuth and elevation, with true north rotated `northAngleDeg` counter-clockwise from +Y. */
export function sunDirection(azimuthDeg: number, elevationDeg: number, northAngleDeg: number): [number, number, number] {
  const plan = (azimuthDeg - northAngleDeg) * RAD;
  const e = elevationDeg * RAD;
  return [Math.cos(e) * Math.sin(plan), Math.cos(e) * Math.cos(plan), Math.sin(e)];
}
