/**
 * Bounded storage reconciliation (Step 10.1C).
 * Database-driven candidates only — does not scan entire buckets.
 */
import { getUploadRepository, type MediaUploadRecord } from "../uploads/repository";
import { getMediaObjectStorage } from "../mediaStorage";

export type ReconciliationIssueKind =
  | "record_missing_object"
  | "deleted_record_object_present"
  | "expired_pending_object_present"
  | "object_size_mismatch";

export type ReconciliationIssue = {
  uploadId: string;
  ownerId: string;
  kind: ReconciliationIssueKind;
  storageProvider: string;
  keyHash: string;
};

export type ReconciliationResult = {
  examined: number;
  issues: ReconciliationIssue[];
  repaired: number;
};

function hashKey(objectKey: string): string {
  let h = 0;
  for (let i = 0; i < objectKey.length; i++) h = (h * 31 + objectKey.charCodeAt(i)) >>> 0;
  return `ok_${h.toString(16)}`;
}

/**
 * Examine a bounded set of upload records for storage mismatches.
 * Optional repair: delete orphaned objects for deleted/expired records;
 * mark ready/uploaded records missing objects as expired (does not delete reports).
 */
export async function reconcileStorageCandidates(input: {
  records: MediaUploadRecord[];
  repair?: boolean;
}): Promise<ReconciliationResult> {
  const media = getMediaObjectStorage();
  const repo = getUploadRepository();
  const issues: ReconciliationIssue[] = [];
  let repaired = 0;

  for (const rec of input.records) {
    if (!rec.storageObjectKey) continue;
    const meta = await media.statObject(rec.storageObjectKey);
    const base = {
      uploadId: rec.uploadId,
      ownerId: rec.ownerId,
      storageProvider: rec.storageProvider,
      keyHash: hashKey(rec.storageObjectKey),
    };

    if (
      (rec.uploadStatus === "ready" ||
        rec.uploadStatus === "uploaded" ||
        rec.uploadStatus === "processing") &&
      !meta.exists
    ) {
      issues.push({ ...base, kind: "record_missing_object" });
      if (input.repair) {
        await repo.update(rec.uploadId, {
          uploadStatus: "expired",
          errorCode: "STORAGE_OBJECT_NOT_FOUND",
          errorMessage: "Stored object missing during reconciliation.",
        });
        repaired += 1;
      }
      continue;
    }

    if (
      (rec.uploadStatus === "deleted" || rec.uploadStatus === "expired") &&
      meta.exists
    ) {
      issues.push({ ...base, kind: "deleted_record_object_present" });
      if (input.repair) {
        await media.deleteObject(rec.storageObjectKey).catch(() => undefined);
        repaired += 1;
      }
      continue;
    }

    if (
      (rec.uploadStatus === "pending" || rec.uploadStatus === "uploading") &&
      meta.exists &&
      new Date(rec.pendingExpiresAt).getTime() <= Date.now()
    ) {
      issues.push({ ...base, kind: "expired_pending_object_present" });
      if (input.repair) {
        await media.deleteObject(rec.storageObjectKey).catch(() => undefined);
        await repo.update(rec.uploadId, {
          uploadStatus: "expired",
          errorCode: "STORAGE_UPLOAD_EXPIRED",
          errorMessage: "Pending upload expired.",
          deletedAt: new Date().toISOString(),
        });
        repaired += 1;
      }
      continue;
    }

    if (
      meta.exists &&
      meta.byteSize > 0 &&
      rec.storedByteSize &&
      rec.storedByteSize > 0 &&
      meta.byteSize !== rec.storedByteSize &&
      (rec.uploadStatus === "ready" || rec.uploadStatus === "uploaded")
    ) {
      issues.push({ ...base, kind: "object_size_mismatch" });
    }
  }

  console.log(
    `[chelcoach-storage-reconcile] examined=${input.records.length} issues=${issues.length} repaired=${repaired}`,
  );

  return { examined: input.records.length, issues, repaired };
}

/** Convenience: reconcile expired pending uploads (bounded). */
export async function reconcileExpiredPending(limit = 50, repair = true): Promise<ReconciliationResult> {
  const repo = getUploadRepository();
  const expired = await repo.listExpiredPending(new Date(), limit);
  return reconcileStorageCandidates({ records: expired, repair });
}
