import { z } from "zod";
import { leaseStatusSchema } from "./enums";

export const processingLeaseSchema = z.object({
  leaseId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  analysisJobId: z.string().trim().min(1).max(128),
  acquiredAt: z.string().datetime({ offset: true }),
  heartbeatAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  releasedAt: z.string().datetime({ offset: true }).optional(),
  status: leaseStatusSchema,
});
export type ProcessingLease = z.infer<typeof processingLeaseSchema>;

export function isLeaseActive(lease: ProcessingLease, now: Date): boolean {
  if (lease.status !== "active") return false;
  if (lease.releasedAt) return false;
  return now.getTime() < new Date(lease.expiresAt).getTime();
}
