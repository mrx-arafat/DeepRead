/** The sentence DeepRead could not be reached with, and the way to ask again. */
export function Unreachable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="library-retry">
      <p className="inline-error" role="alert">
        {message}
      </p>
      <button type="button" className="quiet-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** What the page shows before DeepRead has said whether there are profiles: nothing at first, and a quiet line if it is slow. */
export function Startup({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error === null) {
    // Held back by the stylesheet for a moment, so a quick answer never flashes it.
    return (
      <main className="profiles-page">
        <p className="startup-note" role="status">
          Opening DeepRead
        </p>
      </main>
    );
  }
  return (
    <main className="profiles-page">
      <h1 className="profiles-heading">DeepRead</h1>
      <Unreachable message={error} onRetry={onRetry} />
    </main>
  );
}
