/**
 * Supabase Storage configuration (Step 10.1C).
 * Never log keys or signed URLs.
 */
import { ChelCoachConfigError } from "../config/chelcoachConfig";

export type SupabaseStorageConfig = {
  enabled: boolean;
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  gameplayBucket: string;
  derivedBucket: string;
};

export function loadSupabaseStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseStorageConfig {
  const url = (env.SUPABASE_URL ?? "").trim();
  const anonKey = (env.SUPABASE_ANON_KEY ?? "").trim();
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const gameplayBucket = (env.SUPABASE_GAMEPLAY_BUCKET ?? "chelcoach-gameplay").trim();
  const derivedBucket = (env.SUPABASE_DERIVED_MEDIA_BUCKET ?? "chelcoach-derived-media").trim();

  const mode = (env.CHELCOACH_MEDIA_STORAGE_MODE ?? "").trim();
  const enabled = mode === "supabase_storage";

  if (enabled) {
    if (!url) {
      throw new ChelCoachConfigError("STORAGE_NOT_CONFIGURED", "SUPABASE_URL required for supabase_storage.");
    }
    if (!anonKey) {
      throw new ChelCoachConfigError(
        "STORAGE_NOT_CONFIGURED",
        "SUPABASE_ANON_KEY required for supabase_storage.",
      );
    }
    if (!serviceRoleKey) {
      throw new ChelCoachConfigError(
        "STORAGE_NOT_CONFIGURED",
        "SUPABASE_SERVICE_ROLE_KEY required for supabase_storage.",
      );
    }
    if (!gameplayBucket || !derivedBucket) {
      throw new ChelCoachConfigError("STORAGE_NOT_CONFIGURED", "Bucket names required.");
    }
  }

  return {
    enabled,
    url,
    anonKey,
    serviceRoleKey,
    gameplayBucket,
    derivedBucket,
  };
}

/** Gameplay object path: {userId}/{uploadId}/source */
export function gameplayObjectKey(ownerId: string, uploadId: string): string {
  return `${ownerId}/${uploadId}/source`;
}

/** Derived confirmation frame path */
export function derivedFrameObjectKey(
  ownerId: string,
  uploadId: string,
  frameId: string,
): string {
  return `${ownerId}/${uploadId}/confirmation/${frameId}.jpg`;
}

export function resumableUploadEndpoint(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/upload/resumable`;
}

/** Safe diagnostics — no secrets. */
export function supabaseStorageDiagnostics(config: SupabaseStorageConfig) {
  return {
    enabled: config.enabled,
    gameplayBucket: config.gameplayBucket,
    derivedBucket: config.derivedBucket,
    urlConfigured: Boolean(config.url),
    anonConfigured: Boolean(config.anonKey),
    serviceRoleConfigured: Boolean(config.serviceRoleKey),
  };
}
