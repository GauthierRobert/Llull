/** Browser stub for `node:module` (manifold-3d's Node-only branch never runs in the browser). */
export const createRequire = (): never => {
  throw new Error('node:module is unavailable in the browser.');
};
