// Analytics facade — no-op for now.
//
// The v1 extension wired Segment, Sentry, Honeycomb, and DataDog.
// Calls preserved at the boundary so we can wire a real backend later
// without touching call sites.

export function trackEvent(name: string, props?: Record<string, unknown>): void {
  void name;
  void props;
}

export function trackError(err: unknown, context?: Record<string, unknown>): void {
  void err;
  void context;
}
