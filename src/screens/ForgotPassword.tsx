import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import AuthUnavailable from "../components/AuthUnavailable";
import Button from "../components/Button";
import { AuthActionError, useAuth } from "../state/AuthContext";

export default function ForgotPassword() {
  const { mode, requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (mode !== "supabase") {
    return <AuthUnavailable title="Reset password" />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      setInfo("If an account exists for that email, a reset link has been sent.");
    } catch (err) {
      if (err instanceof AuthActionError) setError(err.message);
      else setError("Unable to send reset email.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="max-w-md w-full glass-panel p-8 space-y-6">
        <h1 className="font-headline text-3xl uppercase">Reset password</h1>
        <p className="text-on-surface-variant text-sm">
          Enter your email and we will send a reset link when the account exists.
        </p>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-1">
            <span className="font-label-md text-on-surface-variant uppercase">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg bg-surface-container border border-white/10 px-3 py-2 text-on-surface"
            />
          </label>
          {error ? <p className="text-error text-sm">{error}</p> : null}
          {info ? <p className="text-tertiary text-sm">{info}</p> : null}
          <Button type="submit" disabled={submitting} className="w-full">
            Send reset link
          </Button>
        </form>
        <Link to="/login" className="text-sm text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
