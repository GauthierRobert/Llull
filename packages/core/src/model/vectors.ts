/** Coordinate value types: the leaf of the model (building and civil models use them too). */

export type Vec3 = readonly [number, number, number];

/** 2D coordinate in a local work plane. */
export type Vec2 = readonly [number, number];

/** Unit quaternion [w, x, y, z]. */
export type Quaternion = readonly [number, number, number, number];
