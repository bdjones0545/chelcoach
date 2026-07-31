/**
 * Scotty contract version — shared by ChelCoach FE/BE, local simulator, and gateway.
 */
import { z } from "zod";

export const SCOTTY_CONTRACT_VERSION = "1.0.0" as const;

export const scottyContractVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Contract version must be semver MAJOR.MINOR.PATCH");

export type ScottyContractVersion = z.infer<typeof scottyContractVersionSchema>;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): ParsedSemver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Compatible when major matches the supported contract major.
 * Rejects unsupported majors; does not silently reinterpret.
 */
export function isCompatibleContractVersion(
  version: string,
  supported: string = SCOTTY_CONTRACT_VERSION,
): boolean {
  const want = parseSemver(supported);
  const got = parseSemver(version);
  if (!want || !got) return false;
  return got.major === want.major;
}
