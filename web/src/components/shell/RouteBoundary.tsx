import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/primitives'

// A failure inside one workspace stays inside that workspace.
//
// React unmounts the entire tree when a render throws, which is why an
// unhandled error used to leave nothing but the page background. The shell is
// mounted outside this boundary, so the navigation survives and the viewer can
// move to another engine instead of reloading a blank window.
//
// The error is stated as it was thrown. A workspace that broke is a defect to
// report, not a condition to paraphrase into reassurance.

interface Props {
  /** Remounts the subtree when it changes, so navigating away clears the error. */
  resetKey: string
  what: string
  children: ReactNode
}

export class RouteBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console so the component stack is available while debugging.
    console.error('[workspace] render failed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="state state--error" role="alert">
        <div className="state__head">
          <p className="state__title">{this.props.what} could not be displayed</p>
        </div>
        <p className="state__detail">{error.message}</p>
        <p className="state__meta">
          <span className="eyebrow">What this means</span> The data loaded, but this workspace could not render it. It
          is a defect in the interface, not a problem with your account or the record.
        </p>
        <p className="state__meta">
          <span className="eyebrow">To resolve</span> Other engines are unaffected — use the navigation to continue.
          Report the message above, with the full stack in the browser console, to engineering.
        </p>
        <div className="state__action">
          <Button icon={RefreshCw} onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
}
