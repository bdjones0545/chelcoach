/**
 * Frontend auth context (Step 10.1B).
 * Small surface: session, user, signIn/signUp/signOut, loading.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  AUTH_UNAVAILABLE_USER_MESSAGE,
  getSupabaseBrowserClient,
  getSupabaseBrowserConfigStatus,
  type SupabaseClientStatus,
} from "../lib/supabaseClient";
import { clearDevOwnerToken } from "../lib/authToken";

export type AuthMode = "supabase" | "development_session" | "disabled";

export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "EMAIL_CONFIRMATION_REQUIRED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "WEAK_PASSWORD"
  | "USER_EXISTS"
  | "UNKNOWN";

export class AuthActionError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthActionError";
    this.code = code;
  }
}

type AuthContextValue = {
  mode: AuthMode;
  /** Frontend-safe browser Supabase config status (no secrets). */
  supabaseStatus: SupabaseClientStatus;
  user: User | null;
  session: Session | null;
  loading: boolean;
  authenticated: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function mapSignInError(message: string): AuthActionError {
  const lower = message.toLowerCase();
  if (lower.includes("email not confirmed")) {
    return new AuthActionError(
      "EMAIL_CONFIRMATION_REQUIRED",
      "Confirm your email before signing in.",
    );
  }
  if (lower.includes("invalid login") || lower.includes("invalid credentials")) {
    return new AuthActionError("INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("timeout")
  ) {
    return new AuthActionError(
      "AUTH_PROVIDER_UNAVAILABLE",
      "Sign-in is temporarily unavailable. Try again in a moment.",
    );
  }
  return new AuthActionError("UNKNOWN", "Unable to sign in. Try again.");
}

function mapSignUpError(message: string): AuthActionError {
  const lower = message.toLowerCase();
  if (lower.includes("already registered") || lower.includes("already been registered")) {
    return new AuthActionError("USER_EXISTS", "An account with this email already exists.");
  }
  if (lower.includes("password")) {
    return new AuthActionError("WEAK_PASSWORD", "Choose a stronger password (at least 6 characters).");
  }
  return new AuthActionError("UNKNOWN", "Unable to create account. Try again.");
}

function safeRedirectTo(path: string): string {
  // Only same-origin relative paths — prevent open redirects.
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (path.includes("://")) return "/";
  return path;
}

function providerUnavailableError(): AuthActionError {
  return new AuthActionError("AUTH_PROVIDER_UNAVAILABLE", AUTH_UNAVAILABLE_USER_MESSAGE);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabaseStatus = getSupabaseBrowserConfigStatus();
  const supabaseConfigured = supabaseStatus.configured;
  const mode: AuthMode = supabaseConfigured ? "supabase" : "development_session";

  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setLoading(false);
      return;
    }

    let active = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session);
        setUser(data.session?.user ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setUser(next?.user ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [supabaseConfigured]);

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      throw providerUnavailableError();
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw mapSignInError(error.message);
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      throw providerUnavailableError();
    }
    const emailRedirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}${safeRedirectTo("/login")}`
        : undefined;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    if (error) throw mapSignUpError(error.message);
    const needsEmailConfirmation = !data.session;
    return { needsEmailConfirmation };
  }, []);

  const signOut = useCallback(async () => {
    clearDevOwnerToken();
    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setSession(null);
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      throw providerUnavailableError();
    }
    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}${safeRedirectTo("/reset-password")}`
        : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      throw new AuthActionError("UNKNOWN", "Unable to send reset email. Try again.");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode,
      supabaseStatus,
      user,
      session,
      loading,
      authenticated: mode === "supabase" ? Boolean(session?.access_token) : true,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
    }),
    [
      mode,
      supabaseStatus,
      user,
      session,
      loading,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** Safe for chrome components rendered outside AuthProvider in unit tests. */
export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext);
}
