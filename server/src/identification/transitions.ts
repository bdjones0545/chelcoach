import type { PlayerIdentificationStatus } from "../scottyContract";

const ALLOWED: Record<PlayerIdentificationStatus, readonly PlayerIdentificationStatus[]> = {
  not_started: ["checking"],
  checking: ["identified", "confirmation_required", "failed", "expired"],
  identified: ["confirmation_required"],
  confirmation_required: ["confirmed", "expired", "unresolved", "confirmation_required"],
  confirmed: [],
  failed: ["checking"], // authorized retry only
  expired: [],
  unresolved: ["checking"], // authorized retry only
};

export function canTransitionIdentification(
  from: PlayerIdentificationStatus,
  to: PlayerIdentificationStatus,
): boolean {
  if (from === to) return true;
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertIdentificationTransition(
  from: PlayerIdentificationStatus,
  to: PlayerIdentificationStatus,
): void {
  if (!canTransitionIdentification(from, to)) {
    throw Object.assign(new Error(`Invalid identification transition ${from} → ${to}`), {
      code: "INVALID_REQUEST",
    });
  }
}
