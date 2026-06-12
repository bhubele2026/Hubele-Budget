import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /**
   * Changing this (the current route) clears a caught error, so navigating
   * away from a broken page recovers without a full reload.
   */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

/**
 * App-wide render-error safety net. Without this, a single bad value in any
 * page component tears down the whole React tree → blank screen → the user
 * has to hard-refresh. This catches the error, keeps the nav shell alive,
 * shows the message (so we can find the culprit), and lets the user retry or
 * just switch pages.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the crashing component stack to the console for diagnosis.
    console.error(
      "[PageErrorBoundary] render crash:",
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="max-w-xl mx-auto mt-8"
        role="alert"
        data-testid="page-error-boundary"
      >
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 space-y-3">
          <div className="flex items-center gap-2 text-destructive font-semibold">
            <AlertTriangle className="h-5 w-5" />
            This page hit a snag
          </div>
          <p className="text-sm text-muted-foreground">
            Something on this page errored out — the rest of the app is fine.
            Try again, or switch to another page using the nav.
          </p>
          <pre className="text-[11px] bg-muted/50 rounded p-2 overflow-auto max-h-40 text-muted-foreground whitespace-pre-wrap">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload app
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
