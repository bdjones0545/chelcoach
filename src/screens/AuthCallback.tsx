import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { takeOAuthReturnTo } from "../lib/oauthReturn";
import { useAuth } from "../state/AuthContext";

/**
 * Fixed landing route for OAuth (Google) round trips.
 * The Supabase client exchanges `?code=` on this origin while AuthContext is `loading`;
 * once a session exists we forward (replace) to the remembered destination, so the player
 * never sees a sign-in form again and the one-time code never lingers in history.
 */
export default function AuthCallback() {
  const { mode, loading, authenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "supabase") {
      navigate("/upload", { replace: true });
      return;
    }
    if (loading) return;
    if (authenticated) {
      navigate(takeOAuthReturnTo(), { replace: true });
      return;
    }
    const params = new URLSearchParams(location.search);
    setFailed(
      params.get("error_description") ??
        params.get("error") ??
        "Google sign-in did not complete. Try again from the same browser tab.",
    );
  }, [mode, loading, authenticated, navigate, location.search]);

  if (failed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="max-w-md w-full glass-panel p-8 space-y-4">
          <h1 className="font-headline text-2xl uppercase text-on-surface">Sign-in didn’t finish</h1>
          <p className="text-error text-sm" role="alert">
            {failed}
          </p>
          <Link to="/login" className="text-sm text-primary hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <p className="font-label-md text-on-surface-variant uppercase tracking-wider">Finishing sign-in…</p>
    </div>
  );
}
