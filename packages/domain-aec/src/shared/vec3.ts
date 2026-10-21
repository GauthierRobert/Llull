/** Domain-aec 3D vector helpers not in `@lib/vec3` (midpoint). */

import type { Vec3 } from '@core/model/types';

export const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
