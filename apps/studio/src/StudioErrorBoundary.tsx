import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  readonly onReturn?: () => void;
  readonly onDownload?: () => Promise<void>;
}

interface State {
  readonly error: Error | undefined;
  readonly downloadError: string | undefined;
}

/** Keep the authoring shell and its project snapshot available after a render failure. */
export class StudioErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined, downloadError: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Studio view failed:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <section className="studio-crash" role="alert" aria-label="Studio recovery">
      <h1>This view could not continue</h1>
      <p>Your editable project is still available. Download a project ZIP before reloading if you have recent changes.</p>
      <p className="studio-crash__detail">{this.state.error.message}</p>
      <div className="studio-crash__actions">
        {this.props.onReturn && <button type="button" onClick={() => { this.setState({ error: undefined, downloadError: undefined }); this.props.onReturn?.(); }}>Return to editor</button>}
        {this.props.onDownload && <button type="button" onClick={() => { void this.props.onDownload!().catch(error => this.setState({ downloadError: error instanceof Error ? error.message : 'The project ZIP could not be downloaded.' })); }}>Download project ZIP</button>}
        <button type="button" onClick={() => window.location.reload()}>Reload Studio</button>
      </div>
      {this.state.downloadError && <p role="alert">{this.state.downloadError}</p>}
    </section>;
  }
}
