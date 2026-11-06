/**
 * Restitution of a one-sided linear spring-damper end stop (PHY-23 TR-DRV-17, DRV-M0 13.2.3). A stop pushes but never pulls: the force
 * k·x + c·ẋ is clipped at zero, the stop lets go when it reaches zero and the body leaves at the velocity it has then. The bilateral
 * formula exp(-ζπ/√(1-ζ²)) lets the damper pull the body back and is NOT the restitution of a stop (0.5266 against 0.5717 at ζ = 0.2).
 */

/** Largest damping ratio the closed form covers (the underdamped stop). */
const MAX_ZETA = 0.999;

/** Restitution coefficient e of a one-sided stop of damping ratio ζ in [0, 0.999]: e = e^(-ζ θ/√(1-ζ²)) · |cos θ - ζ/√(1-ζ²) · sin θ|, θ = atan2(2ζ√(1-ζ²), 2ζ²-1). */
export function restitutionOfDamping(zeta: number): number {
  const z = Math.min(Math.max(zeta, 0), MAX_ZETA);
  const root = Math.sqrt(1 - z * z);
  const theta = Math.atan2(2 * z * root, 2 * z * z - 1);
  return Math.exp((-z * theta) / root) * Math.abs(Math.cos(theta) - (z / root) * Math.sin(theta));
}

/** Damping ratio whose one-sided stop has restitution `e` (numeric inverse of the monotone curve), or null when `e` is not in (e(0.999), 1]. */
export function dampingRatioForRestitution(e: number): number | null {
  if (!(e <= 1) || e < restitutionOfDamping(MAX_ZETA)) return null;
  let [low, high] = [0, MAX_ZETA];
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (restitutionOfDamping(mid) > e) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
