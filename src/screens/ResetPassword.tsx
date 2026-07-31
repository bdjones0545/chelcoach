import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { useAuth } from "../state/AuthContext";

/**
 * Completes the Supabase recovery flow after the email redirect.
 * Relies on detectSessionInUrl + PKCE in the browser client.
 */
export default function ResetPassword() {
  const { mode } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (mode !== "supabase") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <p className="text-on-surface-variant text-sm">Password reset requires Supabase Auth.</p>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error("unavailable");
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError("Unable to update password. Request a new reset link.");
        return;
      }
      navigate("/login", { replace: true });
    } catch {
      setError("Unable to update password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="max-w-md w-full glass-panel p-8 space-y-6">
        <h1 className="font-headline text-3xl uppercase">Choose a new password</h1>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-1">
            <span className="font-label-md text-on-surface-variant uppercase">New password</span>
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
          <Button type="submit" disabled={submitting} className="w-full">
            Update password
          </Button>
        </form>
        <Link to="/login" className="text-sm text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
