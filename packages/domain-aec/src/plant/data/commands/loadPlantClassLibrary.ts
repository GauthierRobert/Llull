import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, report } from '@core/commands/noop';
import { getPlantData, withPlantData, type PlantClass } from '../model';
import { DEFAULT_PROCESS_CLASSES, DEFAULT_PROCESS_LIBRARY } from '../library/process';
import { refuse } from './params';

/**
 * @affects adds the library classes (and their ancestors) that are not yet defined to plant.data.classes, source library
 * @invariant a class already defined (library or project) is never overwritten; library classes are read-only
 * @failure unknown library -> DAT_LIBRARY_UNKNOWN; a requested class not in the library -> DAT_CLASS_UNKNOWN
 */
export const loadPlantClassLibrary = defineCommand({
  name: 'load_plant_class_library',
  description:
    `Load the default process class library "${DEFAULT_PROCESS_LIBRARY}" into the document: abstract Equipment (tag format {classCode}-{area}{seq:2}; ` +
    'properties Description, DesignPressure (barg, required), DesignTemperature (degC), OperatingWeight (kg), Service, Manufacturer, Model) with the classes ' +
    'Tank (T), PressureVessel (V), Column (C), CentrifugalPump (P), Compressor (K), HeatExchanger (E); ProcessLine (tag {nominalSize}-{fluidCode}-{seq:4}-{spec}; ' +
    'nominalSize, fluidCode, spec required; from / to); the abstract Valve (tag {valveCode}-{seq:4}) with IsolationValve, CheckValve, ControlValve, ReliefValve. ' +
    'Each class carries its IFC4X3_ADD2 mapping. Library classes are read-only: extend one by define_plant_class with parent = the library class. classes: ' +
    'load only these classes (and the ancestors they need). Existing classes are skipped, never overwritten. Returns data = { added [names], skipped [{ name, reason }] }. ' +
    'Refusals: DAT_LIBRARY_UNKNOWN, DAT_CLASS_UNKNOWN. Next: define_plant_hierarchy, assign_plant_object.',
  params: z.object({
    library: z.string().describe(`Library name: "${DEFAULT_PROCESS_LIBRARY}".`),
    classes: z
      .array(z.string())
      .optional()
      .describe('Class names to load (ancestors are added automatically); omit for the whole library.'),
  }),
  run: (doc, params): CommandResult => {
    if (params.library !== DEFAULT_PROCESS_LIBRARY)
      return refuse(doc, 'load_plant_class_library', {
        code: 'DAT_LIBRARY_UNKNOWN',
        message: `no library "${params.library}" (available: ${DEFAULT_PROCESS_LIBRARY})`,
        paths: ['library'],
      });
    const known = new Map(DEFAULT_PROCESS_CLASSES.map((cls) => [cls.name, cls]));
    const wanted = new Set<string>();
    for (const name of params.classes ?? DEFAULT_PROCESS_CLASSES.map((cls) => cls.name)) {
      let current: PlantClass | undefined = known.get(name);
      if (current === undefined)
        return refuse(doc, 'load_plant_class_library', {
          code: 'DAT_CLASS_UNKNOWN',
          message: `the library has no class "${name}" (${[...known.keys()].join(', ')})`,
          paths: ['classes'],
        });
      while (current !== undefined) {
        wanted.add(current.name);
        current = current.parent === null ? undefined : known.get(current.parent);
      }
    }
    const data = getPlantData(doc);
    const added: PlantClass[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const cls of DEFAULT_PROCESS_CLASSES) {
      if (!wanted.has(cls.name)) continue;
      const existing = data.classes[cls.name];
      if (existing === undefined) added.push(cls);
      else skipped.push({ name: cls.name, reason: `already defined (${existing.source})` });
    }
    if (added.length === 0)
      return report(doc, `load_plant_class_library: nothing to add, ${skipped.length} class(es) already defined.`, { added: [], skipped });
    const next = withPlantData(doc, {
      ...data,
      classes: { ...data.classes, ...Object.fromEntries(added.map((cls) => [cls.name, cls])) },
      classOrder: [...data.classOrder, ...added.map((cls) => cls.name)],
    });
    return {
      ...changed(
        next,
        `load_plant_class_library: ${added.length} class(es) added (${added.map((cls) => cls.name).join(', ')})${skipped.length === 0 ? '' : `; ${skipped.length} skipped`}.`,
        added.map((cls) => cls.name),
      ),
      data: { added: added.map((cls) => cls.name), skipped },
    };
  },
});
