/**
 * Production authentication types (Step 10.1B).
 */

export type AuthProviderName = "supabase" | "development_session";

export type AuthenticatedUser = {
  userId: string;
  email?: string | null;
  authProvider: AuthProviderName;
  issuedAt?: Date;
  expiresAt?: Date;
};

export type AuthFailureCode =
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "EMAIL_CONFIRMATION_REQUIRED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_DISABLED";

export class AuthFailure extends Error {
  constructor(
    public code: AuthFailureCode,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

export interface ProductionAuthProvider {
  readonly name: AuthProviderName;
  authenticate(input: {
    authorizationHeader?: string;
    cookies?: Record<string, string>;
  }): Promise<AuthenticatedUser>;
}
