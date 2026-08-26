"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./ErrorState";

// Keeps one failure inside the thing that failed.
//
// The route boundaries below app/ catch anything that escapes a page, but by
// then the whole page is gone, including the navigation that would let somebody
// leave. This wraps a sub-tree so a visual that cannot draw, or an admin pane
// whose endpoint answered with an error object, takes its own space and no
// more.
//
// A class because there is still no hook equivalent: componentDidCatch is the
// only way to stop an exception propagating through a React tree.

interface Props {
	children: ReactNode;
	// Names what failed, so the message says which part of the screen is
	// missing rather than that something is.
	label?: string;
	// Changing this clears the caught error. Pass the identity of whatever the
	// sub-tree is showing, so moving to a different visual or a different pane
	// retries on its own instead of staying broken until a reload.
	resetKey?: unknown;
	// Set where this fills a visual or a pane rather than a page.
	inline?: boolean;
	fallback?: (reset: () => void) => ReactNode;
}

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidUpdate(previous: Props) {
		if (this.state.error && previous.resetKey !== this.props.resetKey) {
			this.setState({ error: null });
		}
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// Logged rather than sent anywhere: the component stack is the part
		// that says where this happened, and it is dropped by the time an
		// error reaches a route boundary.
		console.error(
			`Render failed${this.props.label ? ` in ${this.props.label}` : ""}:`,
			error,
			info.componentStack,
		);
	}

	reset = () => this.setState({ error: null });

	render() {
		if (!this.state.error) return this.props.children;
		if (this.props.fallback) return this.props.fallback(this.reset);

		return (
			<ErrorState
				title={
					this.props.label
						? `${this.props.label} could not be shown`
						: "This could not be shown"
				}
				body="The rest of the page is unaffected."
				inline={this.props.inline}
				onRetry={this.reset}
				homeHref={null}
			/>
		);
	}
}
