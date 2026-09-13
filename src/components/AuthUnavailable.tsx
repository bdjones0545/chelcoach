import { Link } from "react-router-dom";
import Button from "./Button";

type Props = {
  title: string;
  /** Local development runs on automatic sessions; offer a way through. Never shown in production. */
  onDevContinue?: () => void;
};

/**
 * Visible "sign-in unavailable" state for builds without browser auth configuration.
 * Production copy is generic (no variable names); development explains the dev-session path.
 */
export default function AuthUnavailable({ title, onDevContinue }: Props) {
  const isProd = Boolean(import.meta.env.PROD);
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="max-w-md w-full glass-panel p-8 space-y-4" data-testid="auth-unavailable">
        <p className="font-label-md text-primary uppercase tracking-wider">ChelCoach</p>
        <h1 className="font-headline text-2xl uppercase text-on-surface">{title}</h1>
        <p className="text-on-surface-variant text-sm" role="alert" aria-live="polite">
          {isProd
            ? "Sign-in is temporarily unavailable because authentication is not configured for this deployment."
            : "Browser sign-in is not configured in this build. Local development uses automatic sessions."}
        </p>
        <div className="flex flex-col gap-3 pt-2">
          <Button type="button" disabled className="w-full" aria-disabled="true">
            Sign in unavailable
          </Button>
          {!isProd && onDevContinue ? (
            <Button type="button" variant="ghost" className="w-full" onClick={onDevContinue}>
              Continue without browser sign-in
            </Button>
          ) : null}
          <Link to="/" className="text-sm text-primary hover:underline text-center">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
