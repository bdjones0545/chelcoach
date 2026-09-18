import { useState } from "react";
import { AuthActionError, useAuth } from "../state/AuthContext";

/** "Continue with Google" — same button on Sign in and Create account. */
export default function GoogleSignInButton({
  returnTo,
  onError,
  label = "Continue with Google",
}: {
  returnTo: string;
  onError: (message: string) => void;
  label?: string;
}) {
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      await signInWithGoogle(returnTo);
      // On success the browser navigates to Google; we never get here.
    } catch (err) {
      setBusy(false);
      onError(err instanceof AuthActionError ? err.message : "Google sign-in is not available right now.");
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/15 bg-surface-container/60 px-4 py-3 font-label-md text-label-md text-on-surface transition-colors hover:border-primary disabled:opacity-60"
    >
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.1z" />
        <path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z" />
        <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.5-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
      </svg>
      {busy ? "Opening Google…" : label}
    </button>
  );
}
