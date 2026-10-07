import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Disclosure } from "@/kit/Disclosure";

interface Props {
  children: ReactNode;
  /** The current route: changing it clears a caught error, so moving on recovers. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

/**
 * The render-error safety net, ported from the classic app. One bad value in
 * a screen would otherwise tear down the whole tree and leave a blank page.
 * This keeps the shell (masthead, dock) alive, says what happened, and offers
 * a retry or a reload. Keyed by location in App.tsx.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[PageErrorBoundary] render crash:", error, info.componentStack);
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
      <div className="flex flex-col gap-4" data-testid="page-error-boundary">
        <h1 className="type-headline text-ink">This screen could not be drawn.</h1>
        <Note kind="error">The rest of H2 is fine. Try again, or reload.</Note>
        <div className="flex gap-3">
          <Button variant="primary" size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
        <Disclosure summary="Technical detail">
          <pre className="type-caption whitespace-pre-wrap text-ink-2">{error.message}</pre>
        </Disclosure>
      </div>
    );
  }
}
