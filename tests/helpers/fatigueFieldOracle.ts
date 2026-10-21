/** Test oracle of `llull-compute post fatigue`: the all-node field in TypeScript, `[D, cycles, maxEquivalentAmplitude, flags]` per node. */

import { damageOf } from '@cae/fatigue/evaluate';
import { cyclesOfNode, FIELD_COMPONENTS, FLAG_BITS, type FatigueFieldInput } from '@cae/fatigue/feField';

export function fatigueFieldReference(input: FatigueFieldInput): Float64Array {
  const out = new Float64Array(input.nodeIds.length * FIELD_COMPONENTS.length);
  for (let index = 0; index < input.nodeIds.length; index += 1) {
    const sum = damageOf(cyclesOfNode(input, index), input.damage);
    let flags = sum.extrapolated ? FLAG_BITS.extrapolated : 0;
    for (const flag of sum.flags) flags |= FLAG_BITS[flag];
    out.set([sum.damage, sum.cyclesCounted, sum.maxEquivalentAmplitude, flags], index * FIELD_COMPONENTS.length);
  }
  return out;
}
