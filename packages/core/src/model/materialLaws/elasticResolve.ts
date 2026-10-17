/** Resolution of the orthotropic / transversely isotropic elastic laws to the nine engineering constants (shared by drivers and cards). */

import type { LawOf } from '../materialModel';
import { expandTransverselyIsotropic, type OrthotropicConstants } from './elastic';
import { isLawFailure, resolveAll, type LawFailure, type ResolveEnv } from './resolve';

/** Engineering constants of `law` at `env`; a transversely isotropic law is expanded about its isotropy plane. */
export function resolveOrthotropicConstants(
  law: LawOf<'elastic_orthotropic' | 'elastic_transversely_isotropic'>,
  env: ResolveEnv,
  path: string,
): OrthotropicConstants | LawFailure {
  if (law.kind === 'elastic_orthotropic')
    return resolveAll(
      {
        E1: { parameter: law.E1, dimension: 'stress' },
        E2: { parameter: law.E2, dimension: 'stress' },
        E3: { parameter: law.E3, dimension: 'stress' },
        nu12: { parameter: law.nu12, dimension: 'dimensionless' },
        nu13: { parameter: law.nu13, dimension: 'dimensionless' },
        nu23: { parameter: law.nu23, dimension: 'dimensionless' },
        G12: { parameter: law.G12, dimension: 'stress' },
        G13: { parameter: law.G13, dimension: 'stress' },
        G23: { parameter: law.G23, dimension: 'stress' },
      },
      env,
      path,
    );
  const values = resolveAll(
    {
      Ep: { parameter: law.Ep, dimension: 'stress' },
      Et: { parameter: law.Et, dimension: 'stress' },
      Gt: { parameter: law.Gt, dimension: 'stress' },
      nuP: { parameter: law.nuP, dimension: 'dimensionless' },
      nuPT: { parameter: law.nuPT, dimension: 'dimensionless' },
    },
    env,
    path,
  );
  return isLawFailure(values)
    ? values
    : expandTransverselyIsotropic(law.isotropyPlane, values.Ep, values.Et, values.nuP, values.nuPT, values.Gt);
}
