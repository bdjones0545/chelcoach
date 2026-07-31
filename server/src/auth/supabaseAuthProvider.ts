/**
 * Supabase Auth production provider (Step 10.1B).
 *
 * Transport: Authorization Bearer <access_token>
 * Verification: Supabase Auth getUser(jwt) — validates signature/expiry via Auth API.
 * Never decode JWTs without verification. Never trust browser-supplied ownerId.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuthenticatedUser, ProductionAuthProvider } from "./types";
import { AuthFailure } from "./types";

export type SupabaseAuthConfig = {
  url: string;
  anonKey: string;
};

let client: SupabaseClient | null = null;
let clientKey: string | null = null;

function getAnonClient(config: SupabaseAuthConfig): SupabaseClient {
  const key = `${config.url}::${config.anonKey.slice(0, 8)}`;
  if (!client || clientKey !== key) {
    client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    clientKey = key;
  }
  return client;
}

/** Test helper — drop cached client between suites. */
export function resetSupabaseAuthClientForTests(): void {
  client = null;
  clientKey = null;
}

function extractBearer(authorizationHeader?: string): string | undefined {
  if (!authorizationHeader) return undefined;
  if (!authorizationHeader.toLowerCase().startsWith("bearer ")) return undefined;
  const token = authorizationHeader.slice(7).trim();
  return token || undefined;
}

function mapSupabaseError(message: string): AuthFailure {
  const lower = message.toLowerCase();
  if (lower.includes("expired") || lower.includes("session from session_id claim")) {
    return new AuthFailure("SESSION_EXPIRED", "Sign in required.", false);
  }
  if (lower.includes("invalid") || lower.includes("jwt") || lower.includes("token")) {
    return new AuthFailure("INVALID_SESSION", "Sign in required.", false);
  }
  return new AuthFailure("INVALID_SESSION", "Sign in required.", false);
}

/**
 * Create a Supabase-backed production auth provider.
 * Uses the anon key client + getUser(accessToken) — not the service role.
 */
export function createSupabaseAuthProvider(
  config: SupabaseAuthConfig,
): ProductionAuthProvider {
  if (!config.url || !config.anonKey) {
    throw new AuthFailure(
      "AUTH_PROVIDER_UNAVAILABLE",
      "Supabase Auth is not configured.",
      true,
    );
  }

  return {
    name: "supabase",
    async authenticate(input): Promise<AuthenticatedUser> {
      const token = extractBearer(input.authorizationHeader);
      if (!token) {
        throw new AuthFailure("AUTHENTICATION_REQUIRED", "Sign in required.", false);
      }

      // Reject obviously malformed tokens without calling the network.
      if (token.length < 20 || token.includes(" ") || token.split(".").length < 2) {
        throw new AuthFailure("INVALID_SESSION", "Sign in required.", false);
      }

      try {
        const supabase = getAnonClient(config);
        const { data, error } = await supabase.auth.getUser(token);
        if (error) {
          throw mapSupabaseError(error.message || "invalid");
        }
        const user = data.user;
        if (!user?.id) {
          throw new AuthFailure("INVALID_SESSION", "Sign in required.", false);
        }
        // UUID-shaped Supabase user id becomes ChelCoach ownerId (text columns).
        return {
          userId: user.id,
          email: user.email ?? null,
          authProvider: "supabase",
          // Claims are not logged; only used for auth context lifetime hints when present.
        };
      } catch (err) {
        if (err instanceof AuthFailure) throw err;
        // Network / SDK failures — generic, no internals.
        throw new AuthFailure(
          "AUTH_PROVIDER_UNAVAILABLE",
          "Authentication temporarily unavailable.",
          true,
        );
      }
    },
  };
}

/** Injectable fixture provider for unit tests (no network). */
export function createFixtureAuthProvider(
  resolve: (token: string) => AuthenticatedUser | null | AuthFailure,
): ProductionAuthProvider {
  return {
    name: "supabase",
    async authenticate(input) {
      const token = extractBearer(input.authorizationHeader);
      if (!token) {
        throw new AuthFailure("AUTHENTICATION_REQUIRED", "Sign in required.", false);
      }
      const result = resolve(token);
      if (result instanceof AuthFailure) throw result;
      if (!result) throw new AuthFailure("INVALID_SESSION", "Sign in required.", false);
      return result;
    },
  };
}
