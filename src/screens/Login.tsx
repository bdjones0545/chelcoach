import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import AuthUnavailable from "../components/AuthUnavailable";
import Button from "../components/Button";
import { AuthActionError, useAuth } from "../state/AuthContext";

function safeReturnPath(raw: unknown): string {
  if (typeof raw !== "string") return "/upload";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) return "/upload";
  return raw;
}

export default function Login() {
  const { mode, signIn, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = safeReturnPath((location.state as { from?: string } | null)?.from);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (mode !== "supabase") {
    return (
      <AuthUnavailable
        title="Sign in"
        allowDevContinue
        onDevContinue={() => navigate("/upload")}
      />
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof AuthActionError) setError(err.message);
      else setError("Unable to sign in. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="max-w-md w-full glass-panel p-8 space-y-6">
        <div>
          <p className="font-label-md text-primary uppercase tracking-wider mb-2">ChelCoach</p>
          <h1 className="font-headline text-3xl uppercase text-on-surface">Sign in</h1>
          <p className="text-on-surface-variant text-sm mt-2">
            Use your ChelCoach account to continue.
          </p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-1" htmlFor="login-email">
            <span className="font-label-md text-on-surface-variant uppercase">Email</span>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg bg-surface-container border border-white/10 px-3 py-2 text-on-surface"
            />
          </label>
          <label className="block space-y-1" htmlFor="login-password">
            <span className="font-label-md text-on-surface-variant uppercase">Password</span>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg bg-surface-container border border-white/10 px-3 py-2 text-on-surface"
            />
          </label>
          {error ? (
            <p className="text-error text-sm" role="alert" aria-live="assertive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={submitting || authLoading} className="w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <div className="flex flex-col gap-2 text-sm text-on-surface-variant">
          <Link to="/signup" className="text-primary hover:underline">
            Create an account
          </Link>
          <Link to="/forgot-password" className="hover:underline">
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}
