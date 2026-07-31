import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../state/AuthContext";

/**
 * Protects routes when Supabase Auth is configured.
 * Development-session mode allows through (opaque mint handles API auth).
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { mode, authenticated, loading } = useAuth();
  const location = useLocation();

  if (mode !== "supabase") {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="font-label-md text-on-surface-variant uppercase tracking-wider">
          Checking session…
        </p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <>{children}</>;
}
