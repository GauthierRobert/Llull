/** Without a bright, wide environment a near-1 metalness renders almost black; cap what the viewport displays. */
const MAX_DISPLAY_METALNESS = 0.55;

export function displayMetalness(metalness: number): number {
  return Math.min(Math.max(metalness, 0), MAX_DISPLAY_METALNESS);
}
