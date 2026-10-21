import type { StairElement, StairShape } from '@aec/building/types';
import { type StairBlock, blockCorners, stairBlocks, stairFlights } from '../geometry/stairGeometry';
import { type Context, extrusion, ifcReal, ifcString, scaledPolygonProfile, shape } from './ifcStep';
import type { Exported } from './ifcElementExport';

const STAIR_TYPE: Readonly<Record<StairShape, string>> = {
  straight: '.STRAIGHT_RUN_STAIR.',
  quarter_turn: '.QUARTER_TURN_STAIR.',
  half_turn: '.HALF_TURN_STAIR.',
};

function blockSolid(context: Context, block: StairBlock): string {
  const profile = scaledPolygonProfile(context, blockCorners(block));
  return extrusion(context, profile, context.mm(block.zTop - block.zBottom), 0, 0, context.mm(block.zBottom));
}

/**
 * A stair as IFCSTAIR. Without a landing its steps are the stair's own body; with one, the stair aggregates one IFCSTAIRFLIGHT per
 * flight and an IFCSLAB (LANDING) so each part is addressable.
 */
export function exportStair(context: Context, stair: StairElement, local: string): Exported {
  const { writer } = context;
  const guid = context.guid(stair.id);
  const blocks = stairBlocks(stair);
  const flights = stairFlights(stair);
  if (flights.length === 1) {
    const body = shape(
      context,
      blocks.map((block) => blockSolid(context, block)),
    );
    const ref = writer.add(
      `IFCSTAIR('${guid}',$,${ifcString(stair.mark)},$,$,${local},${body},${ifcString(stair.id)},${STAIR_TYPE.straight})`,
    );
    return { ref, material: stair.material };
  }
  const parts = flights.map((flight, index) => {
    const steps = blocks.filter((block) => block.flight === index);
    const body = shape(
      context,
      steps.map((block) => blockSolid(context, block)),
    );
    return writer.add(
      `IFCSTAIRFLIGHT('${context.guid(`${stair.id}:flight-${index + 1}`)}',$,${ifcString(`${stair.mark} flight ${index + 1}`)},$,$,${local},${body},` +
        `${ifcString(`${stair.id}:flight-${index + 1}`)},${flight.risers},${Math.max(flight.risers - 1, 0)},${ifcReal(context.mm(stair.riserHeight))},` +
        `${ifcReal(context.mm(stair.treadDepth))},.STRAIGHT.)`,
    );
  });
  const landing = blocks.find((block) => block.flight === null);
  if (landing) {
    const body = shape(context, [blockSolid(context, landing)]);
    parts.push(
      writer.add(
        `IFCSLAB('${context.guid(`${stair.id}:landing`)}',$,${ifcString(`${stair.mark} landing`)},$,$,${local},${body},${ifcString(`${stair.id}:landing`)},.LANDING.)`,
      ),
    );
  }
  const ref = writer.add(
    `IFCSTAIR('${guid}',$,${ifcString(stair.mark)},$,$,${local},$,${ifcString(stair.id)},${STAIR_TYPE[stair.shape ?? 'straight']})`,
  );
  writer.add(`IFCRELAGGREGATES('${context.guid(`rel:stair-parts:${stair.id}`)}',$,$,$,${ref},(${parts.join(',')}))`);
  return { ref, material: stair.material, parts };
}
