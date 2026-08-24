import type { DeviceView } from './types';

/**
 * Why this destination cannot be routed from here, or null when it can.
 *
 * The button an operator presses is a **claim**: somebody has taken this
 * destination, and until they give it back the app will not route it — for
 * them either. That last part is the whole point. On the wire a claim is the
 * Videohub protocol's lock, owned per address because an address is the only
 * identity either protocol offers, and there an owner routes through its own
 * lock. The browser is always that owner, so the per-address rule alone would
 * refuse everybody except the person who pressed the button.
 *
 * The server applies the same rule to its HTTP API; this is what stops a
 * claimed crosspoint being clickable in the first place.
 */
export function claimedReason(
  device: DeviceView | null,
  destinationId: string,
  self: string | null = null,
): string | null {
  const owner = device?.locks[destinationId] ?? null;
  if (!owner) return null;
  const label = device?.matrix?.destinations.find((d) => d.id === destinationId)?.label ?? destinationId;
  return `${label} is claimed by ${ownerName(owner, self)} — release it to route.`;
}

/**
 * Who to say holds a claim.
 *
 * An address is what the server knows, and "claimed by 127.0.0.1" is read by
 * the person at 127.0.0.1 more often than by anyone else. Naming them as
 * themselves is the difference between the row looking broken and looking
 * held. Everyone else stays an address, because that is all either protocol
 * offers and inventing a friendlier name would be inventing.
 */
export function ownerName(owner: string, self: string | null): string {
  return self !== null && owner === self ? 'you' : owner;
}
