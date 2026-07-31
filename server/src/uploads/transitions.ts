import type { UploadStatus } from "../scottyContract";

const ALLOWED: Record<UploadStatus, ReadonlySet<UploadStatus>> = {
  pending: new Set(["uploading", "expired", "deleted", "delete_failed"]),
  uploading: new Set(["uploaded", "expired", "deleted", "delete_failed", "pending"]),
  uploaded: new Set(["processing", "expired", "deleted", "delete_failed"]),
  processing: new Set(["ready", "expired", "deleted", "delete_failed"]),
  ready: new Set(["deletion_pending", "deleted", "expired"]),
  deletion_pending: new Set(["deleted", "delete_failed"]),
  deleted: new Set([]),
  delete_failed: new Set(["deletion_pending", "deleted", "expired"]),
  expired: new Set(["deletion_pending", "deleted", "delete_failed"]),
};

export function canTransitionUpload(from: UploadStatus, to: UploadStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.has(to) ?? false;
}

export function assertUploadTransition(from: UploadStatus, to: UploadStatus): void {
  if (!canTransitionUpload(from, to)) {
    throw Object.assign(new Error(`Invalid upload transition ${from} → ${to}`), {
      code: "INVALID_REQUEST",
      httpStatus: 409,
    });
  }
}
