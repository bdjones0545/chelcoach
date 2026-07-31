import { Link, useNavigate } from "react-router-dom";
import { useAuthOptional } from "../state/AuthContext";

/** Compact sign-in / sign-out controls for the top bar. */
export function AuthActions() {
  const auth = useAuthOptional();
  const navigate = useNavigate();
  if (!auth || auth.mode !== "supabase") {
    return null;
  }
  const { authenticated, loading, signOut, user } = auth;

  if (loading) {
    return <span className="font-label-sm text-on-surface-variant">…</span>;
  }

  if (!authenticated) {
    return (
      <Link
        to="/login"
        className="font-label-md uppercase tracking-wider text-primary hover:underline"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="hidden max-w-[10rem] truncate font-label-sm text-on-surface-variant md:inline">
        {user?.email ?? "Signed in"}
      </span>
      <button
        type="button"
        className="font-label-md uppercase tracking-wider text-on-surface hover:text-primary"
        onClick={() => {
          void signOut().then(() => navigate("/login"));
        }}
      >
        Sign out
      </button>
    </div>
  );
}
