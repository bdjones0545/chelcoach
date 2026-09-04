import { Link } from "react-router-dom";
import Button from "./Button";
import {
  AUTH_UNAVAILABLE_USER_MESSAGE,
  authUnavailableUserMessage,
  getSupabaseBrowserConfigStatus,
} from "../lib/supabaseBrowserConfig";

type Props = {
  title: string;
  /** When true (local/dev), offer a continue path without browser Auth. */
  allowDevContinue?: boolean;
  onDevContinue?: () => void;
};

/**
 * Visible Auth-unavailable state — never an inert Sign In control.
 * Production message is generic; development may include safe diagnostics.
 */
export default function AuthUnavailable({ title, allowDevContinue, onDevContinue }: Props) {
  const status = getSupabaseBrowserConfigStatus();
  const isProd = Boolean(import.meta.env.PROD);
  const message = status.configured
    ? AUTH_UNAVAILABLE_USER_MESSAGE
    : authUnavailableUserMessage(status, isProd);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="max-w-md w-full glass-panel p-8 space-y-4" data-testid="auth-unavailable">
        <p className="font-label-md text-primary uppercase tracking-wider">ChelCoach</p>
        <h1 className="font-headline text-2xl uppercase text-on-surface">{title}</h1>
        <p className="text-on-surface-variant text-sm" role="alert" aria-live="polite">
          {message}
        </p>
        {!isProd ? (
          <p className="text-on-surface-variant text-xs font-label-sm">
            After setting browser Auth variables, rebuild and redeploy (Vite embeds them at build
            time).
          </p>
        ) : null}
        <div className="flex flex-col gap-3 pt-2">
          <Button type="button" disabled className="w-full" aria-disabled="true">
            Sign in unavailable
          </Button>
          {allowDevContinue && !isProd && onDevContinue ? (
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
