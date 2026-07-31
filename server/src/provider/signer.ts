/**
 * Scotty request signing boundary — production HMAC not implemented in Step 4.
 * Never place signing logic in frontend code.
 */
export interface ScottyRequestSigner {
  sign(input: {
    method: string;
    path: string;
    timestamp: string;
    body: string;
    requestId: string;
  }): Promise<Record<string, string>>;
}

/** Test / fake path — returns empty headers (no secrets). */
export class NoopScottyRequestSigner implements ScottyRequestSigner {
  async sign(): Promise<Record<string, string>> {
    return {};
  }
}

/**
 * Skeleton for future HMAC signing.
 * Throws if used without a configured secret — never fabricates signatures.
 */
export class UnconfiguredHmacScottyRequestSigner implements ScottyRequestSigner {
  constructor(private secretConfigured: boolean) {}

  async sign(input: {
    method: string;
    path: string;
    timestamp: string;
    body: string;
    requestId: string;
  }): Promise<Record<string, string>> {
    void input;
    if (!this.secretConfigured) {
      throw new Error("SCOTTY_SIGNING_SECRET is not configured.");
    }
    // Step 4: intentionally unimplemented — Step 5+/Cloudflare will fill this in.
    throw new Error("HMAC Scotty signing is not implemented in Step 4.");
  }
}

/** Future header names (documentation + skeleton use). */
export const SCOTTY_SIGNED_HEADER_NAMES = [
  "X-Scotty-Timestamp",
  "X-Scotty-Signature",
  "X-Scotty-Request-Id",
  "X-Scotty-Contract-Version",
  "Idempotency-Key",
] as const;
