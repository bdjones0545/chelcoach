import { Component, type ErrorInfo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { stateCopy } from "../data/mockData";
import { reportClientError } from "../lib/errorReporting";
import StatePanel from "./StatePanel";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/**
 * Global render-error boundary. Catches unexpected exceptions in the React
 * tree below it and shows a recovery UI instead of a white screen.
 *
 * Placed around `<App />` (inside the context providers) so Premium / Analysis /
 * Report state survives a screen-level crash. One boundary is enough for the
 * flat conversion-loop app — do not wrap every screen.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, {
      source: "ErrorBoundary",
      componentStack: info.componentStack,
    });
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private reset = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          componentStack={this.state.componentStack}
          onReset={this.reset}
        />
      );
    }
    return this.props.children;
  }
}

interface ErrorFallbackProps {
  error: Error | null;
  componentStack: string | null;
  onReset: () => void;
}

/** Recovery UI — reuses StatePanel; tech details only in development. */
function ErrorFallback({ error, componentStack, onReset }: ErrorFallbackProps) {
  const navigate = useNavigate();
  const copy = stateCopy.appCrash;

  const reload = () => {
    window.location.reload();
  };

  // Reset the boundary first so App remounts, then land on the conversion start.
  // Context providers sit above the boundary, so session flags/report survive.
  const returnHome = () => {
    onReset();
    navigate("/");
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-container-lowest px-4 py-16">
      <StatePanel
        icon={copy.icon}
        tone={copy.tone}
        title={copy.title}
        message={copy.message}
        primary={{ label: copy.primaryLabel, onClick: reload }}
        secondary={{ label: copy.secondaryLabel, onClick: returnHome }}
      />

      {import.meta.env.DEV && error && (
        <details className="glass-panel mt-6 w-full max-w-lg rounded-xl p-4 text-left">
          <summary className="cursor-pointer font-label-md text-label-md uppercase tracking-widest text-on-surface-variant">
            Technical details (dev only)
          </summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words font-label-sm text-label-sm text-error">
            {error.name}: {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
            {componentStack ? `\n\nComponent stack:${componentStack}` : ""}
          </pre>
        </details>
      )}
    </div>
  );
}
