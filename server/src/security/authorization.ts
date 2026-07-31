/**
 * Centralized object-level authorization helpers (Step 10).
 * Ownership always comes from server persistence — never from request body owner IDs.
 */
import { assertOwner } from "../auth/session";

export type OwnedResource =
  | "gameplay_profile"
  | "media_upload"
  | "source_media"
  | "player_identification"
  | "confirmation_frame"
  | "player_confirmation"
  | "analysis_job"
  | "provider_confirmation"
  | "analysis_report"
  | "cancellation_request";

export type AuthzAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "submit"
  | "confirm"
  | "cancel"
  | "stream";

/** Generic unauthorized/not-found response — do not leak existence across users. */
export function genericNotFoundBody(): {
  error: "NOT_FOUND";
  message: string;
  retryable: false;
} {
  return {
    error: "NOT_FOUND",
    message: "Resource not found.",
    retryable: false,
  };
}

export function unauthorizedBody(): {
  error: "UNAUTHORIZED";
  message: string;
  retryable: false;
} {
  return {
    error: "UNAUTHORIZED",
    message: "Sign in required.",
    retryable: false,
  };
}

/**
 * Returns true when the authenticated owner may act on the resource.
 * Missing resource → treat as not found (caller returns 404 generic).
 */
export function authorizeOwned(input: {
  ownerId: string;
  resourceOwnerId: string | undefined | null;
  resource: OwnedResource;
  action: AuthzAction;
}): { ok: true } | { ok: false; reason: "missing" | "forbidden" } {
  void input.resource;
  void input.action;
  if (!input.resourceOwnerId) return { ok: false, reason: "missing" };
  if (!assertOwner(input.ownerId, input.resourceOwnerId)) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true };
}

/** Strip any client-supplied owner fields from payloads. */
export function stripClientOwnerFields<T extends Record<string, unknown>>(body: T): Omit<T, "ownerId" | "userId" | "owner_id"> {
  const { ownerId: _o, userId: _u, owner_id: _oid, ...rest } = body as T & {
    ownerId?: unknown;
    userId?: unknown;
    owner_id?: unknown;
  };
  return rest;
}
