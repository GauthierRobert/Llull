/** A `build_project` plan adding `count` unit boxes in a row along +X (one per repeat index). */
export function boxRowPlan(count: number): { actions: unknown[] } {
  return {
    actions: [
      {
        repeat: { count, as: 'row' },
        step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=$i', 0, 0] } },
      },
    ],
  };
}
