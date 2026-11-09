/** set_mission_environment (PHY-14 FR-ENV-09): the explicit outgassing profile, humidity exposure and atomic-oxygen fluence of the mission. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { refuseEnv } from './codes';
import { quantitySchema } from './units';
import { MAX_LIMITS, PROFILE_ID_PATTERN, spaceEnvironmentOf } from './model';
import { shippedProfile, SHIPPED_PROFILE_IDS } from './profiles';
import { OUTGASSING_QUANTITIES, type AoFluence, type HumidityExposure, type OutgassingProfile, type SpaceEnvironment } from './types';

const COMMAND = 'set_mission_environment';
const blank = (text: string | undefined): boolean => text === undefined || text.trim() === '';

const customProfile = z.object({
  id: z.string().describe('Id of the custom profile (letter first; letters, digits, _ . -; not a shipped id).'),
  label: z.string().describe('Human label, e.g. "Program X contamination plan rev B".'),
  limits: z
    .array(
      z.object({
        quantity: z.enum(OUTGASSING_QUANTITIES).describe('TML, CVCM, RML (recovered mass loss, TML - WVR) or WVR.'),
        op: z.enum(['<', '<=']).describe('"<" strict, "<=" inclusive.'),
        value: z.number().describe('Limit in percent of specimen mass (0 to 100).'),
        unit: z.literal('%').describe('Always "%".'),
      }),
    )
    .describe('At least one limit; a material is judged against every limit.'),
  testMethod: z.enum(['ASTM_E595', 'ECSS_Q_ST_70_02']).describe('Test method the limits assume.'),
  source: z.string().describe('REQUIRED: the program document or standard the limits come from.'),
});

/**
 * @affects doc.spaceEnvironment (replaces only the keys given); affected: ['spaceEnvironment']
 * @invariant a custom profile is stored whole with status 'company'; every fluence, exposure and custom limit carries its source; nothing is defaulted
 * @failure nothing given, unknown profile id, bad unit / range, duplicate limit, shipped id reused -> ENV_PROFILE_UNKNOWN / ENV_PARAM_INVALID; blank source -> ENV_SOURCE_MISSING (document unchanged)
 */
export const setMissionEnvironment = defineCommand({
  name: COMMAND,
  description:
    'Record the mission environment the space-environment checks use: the outgassing profile, a humidity exposure and the atomic-oxygen fluence. Only the keys given are replaced. ' +
    'outgassingProfile: a shipped id ("nasa_gsfc_screening" = TML <= 1.0 %, CVCM <= 0.10 % per ASTM E595; "ecss_q_st_70_02" = RML < 1.00 %, CVCM < 0.10 %, secondary source) or a custom profile ' +
    '{id, label, limits[{quantity TML|CVCM|RML|WVR, op "<"|"<=", value %, unit "%"}], testMethod, source}; limits and fluence are never defaulted, every custom limit needs its `source`. ' +
    'humidityExposure {relativeHumidity %, temperature {value, unit}, duration {value, unit}, faces both|one, source} feeds moisture_uptake (useMissionExposure). ' +
    'aoFluence {value, unit "atoms/cm^2" | "atoms/m^2", source} is a mission-analysis input (llull never computes it) used by ao_erosion and check_space_environment. ' +
    'Next: check_space_environment, moisture_uptake, ao_erosion. Returns affected ["spaceEnvironment"].',
  params: z.object({
    outgassingProfile: z
      .union([z.string(), customProfile])
      .optional()
      .describe('A shipped profile id (nasa_gsfc_screening, ecss_q_st_70_02) or a custom profile object with its source.'),
    humidityExposure: z
      .object({
        relativeHumidity: z.number().describe('Relative humidity, % (0 to 100).'),
        temperature: quantitySchema.describe('Exposure temperature {value, unit K | degC | degF}.'),
        duration: quantitySchema.describe('Exposure duration {value, unit s | h | d}, >= 0.'),
        faces: z.enum(['both', 'one']).describe('Exposed faces of the plate: both, or one (other sealed).'),
        source: z.string().describe('REQUIRED: where the exposure comes from (test plan, storage spec).'),
      })
      .optional()
      .describe('Ground humidity exposure for moisture_uptake.'),
    aoFluence: z
      .object({
        value: z.number().describe('Fluence, >= 0.'),
        unit: z.enum(['atoms/cm^2', 'atoms/m^2']).describe('atoms/cm^2 or atoms/m^2.'),
        source: z.string().describe('REQUIRED: the mission analysis revision it comes from.'),
      })
      .optional()
      .describe('Atomic-oxygen fluence of the mission.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult => refuseEnv(doc, COMMAND, code, message, [], [path]);
    const { outgassingProfile, humidityExposure, aoFluence } = params;
    if (outgassingProfile === undefined && humidityExposure === undefined && aoFluence === undefined)
      return fail('ENV_PARAM_INVALID', 'give at least one of outgassingProfile, humidityExposure, aoFluence', 'outgassingProfile');
    const next: { -readonly [K in keyof SpaceEnvironment]: SpaceEnvironment[K] } = { ...spaceEnvironmentOf(doc) };
    const parts: string[] = [];

    if (typeof outgassingProfile === 'string') {
      if (shippedProfile(outgassingProfile) === undefined)
        return fail(
          'ENV_PROFILE_UNKNOWN',
          `no shipped profile '${outgassingProfile}' (shipped: ${SHIPPED_PROFILE_IDS.join(', ')})`,
          'outgassingProfile',
        );
      next.outgassingProfile = outgassingProfile;
      parts.push(`outgassing profile ${outgassingProfile}`);
    } else if (outgassingProfile !== undefined) {
      const path = 'outgassingProfile';
      if (!PROFILE_ID_PATTERN.test(outgassingProfile.id))
        return fail('ENV_PARAM_INVALID', `profile id '${outgassingProfile.id}' is not a valid id`, `${path}.id`);
      if (shippedProfile(outgassingProfile.id) !== undefined)
        return fail(
          'ENV_PARAM_INVALID',
          `'${outgassingProfile.id}' is a shipped profile id: choose another id for a custom profile`,
          `${path}.id`,
        );
      if (blank(outgassingProfile.source))
        return fail('ENV_SOURCE_MISSING', 'a custom profile needs the source of its limits', `${path}.source`);
      if (blank(outgassingProfile.label)) return fail('ENV_PARAM_INVALID', 'a custom profile needs a label', `${path}.label`);
      const { limits } = outgassingProfile;
      if (limits.length === 0 || limits.length > MAX_LIMITS)
        return fail('ENV_PARAM_INVALID', `a profile has 1 to ${MAX_LIMITS} limits (got ${limits.length})`, `${path}.limits`);
      const seen = new Set<string>();
      for (const [index, limit] of limits.entries()) {
        if (!(Number.isFinite(limit.value) && limit.value >= 0 && limit.value <= 100))
          return fail(
            'ENV_PARAM_INVALID',
            `limit ${limit.quantity} must be between 0 and 100 % (got ${limit.value})`,
            `${path}.limits.${index}.value`,
          );
        if (seen.has(limit.quantity))
          return fail('ENV_PARAM_INVALID', `limit ${limit.quantity} appears twice`, `${path}.limits.${index}.quantity`);
        seen.add(limit.quantity);
      }
      const stored: OutgassingProfile = { ...outgassingProfile, status: 'company' };
      next.outgassingProfile = stored;
      parts.push(`custom outgassing profile ${stored.id} (${limits.length} limit(s))`);
    }

    if (humidityExposure !== undefined) {
      const path = 'humidityExposure';
      if (blank(humidityExposure.source)) return fail('ENV_SOURCE_MISSING', 'the humidity exposure needs its source', `${path}.source`);
      if (
        !(
          Number.isFinite(humidityExposure.relativeHumidity) &&
          humidityExposure.relativeHumidity >= 0 &&
          humidityExposure.relativeHumidity <= 100
        )
      )
        return fail('ENV_PARAM_INVALID', 'relativeHumidity must be between 0 and 100 %', `${path}.relativeHumidity`);
      const kelvin = convertValue(humidityExposure.temperature.value, humidityExposure.temperature.unit, 'K');
      if (isUnitFailure(kelvin) || !(kelvin.value > 0))
        return fail('ENV_PARAM_INVALID', 'temperature must be an absolute temperature above 0 K (K, degC, degF)', `${path}.temperature`);
      const seconds = convertValue(humidityExposure.duration.value, humidityExposure.duration.unit, 's');
      if (isUnitFailure(seconds) || !Number.isFinite(seconds.value) || seconds.value < 0)
        return fail('ENV_PARAM_INVALID', 'duration must be a finite time >= 0 (s, h, d)', `${path}.duration`);
      const stored: HumidityExposure = humidityExposure;
      next.humidityExposure = stored;
      parts.push(`humidity exposure ${stored.relativeHumidity} % RH`);
    }

    if (aoFluence !== undefined) {
      if (blank(aoFluence.source))
        return fail('ENV_SOURCE_MISSING', 'the atomic-oxygen fluence needs its source (mission analysis)', 'aoFluence.source');
      if (!(Number.isFinite(aoFluence.value) && aoFluence.value >= 0))
        return fail('ENV_PARAM_INVALID', 'fluence must be finite and >= 0', 'aoFluence.value');
      const stored: AoFluence = aoFluence;
      next.aoFluence = stored;
      parts.push(`AO fluence ${stored.value} ${stored.unit}`);
    }

    return changed({ ...doc, spaceEnvironment: next }, `${COMMAND}: set ${parts.join('; ')}.`, ['spaceEnvironment']);
  },
});
