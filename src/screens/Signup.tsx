import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import { AuthActionError, useAuth } from "../state/AuthContext";

export default function Signup() {
  const { mode, signUp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (mode !== "supabase") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="max-w-md w-full glass-panel p-8 space-y-4">
          <h1 className="font-headline text-2xl uppercase">Sign up</h1>
          <p className="text-on-surface-variant text-sm">
            Supabase Auth is not configured in this build.
          </p>
          <Button onClick={() => navigate("/upload")}>Continue</Button>
        </div>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const result = await signUp(email.trim(), password);
      if (result.needsEmailConfirmation) {
        setInfo("Check your email to confirm your account, then sign in.");
      } else {
        navigate("/upload", { replace: true });
      }
    } catch (err) {
      if (err instanceof AuthActionError) setError(err.message);
      else setError("Unable to create account. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="max-w-md w-full glass-panel p-8 space-y-6">
        <div>
          <p className="font-label-md text-primary uppercase tracking-wider mb-2">ChelCoach</p>
          <h1 className="font-headline text-3xl uppercase text-on-surface">Create account</h1>
          <p className="text-on-surface-variant text-sm mt-2">
            Email and password — no OAuth in this phase.
          </p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-1">
            <span className="font-label-md text-on-surface-variant uppercase">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg bg-surface-container border border-white/10 px-3 py-2 text-on-surface"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-label-md text-on-surface-variant uppercase">Password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg bg-surface-container border border-white/10 px-3 py-2 text-on-surface"
            />
          </label>
          {error ? <p className="text-error text-sm">{error}</p> : null}
          {info ? <p className="text-tertiary text-sm">{info}</p> : null}
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Creating…" : "Sign up"}
          </Button>
        </form>
        <Link to="/login" className="text-sm text-primary hover:underline">
          Already have an account? Sign in
        </Link>
      </div>
    </div>
  );
}
