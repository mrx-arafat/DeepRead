import { ArrowLeft, BookMinus, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { SharingOverview } from "../../shared/types.ts";
import { api } from "../api.ts";
import { APP_NAME, useDocumentTitle } from "../pageTitle.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { useSession } from "../profiles/session.tsx";
import { Cover } from "./Cover.tsx";
import { ShareDialog } from "./ShareDialog.tsx";

type Given = SharingOverview["given"][number];

const sinceText = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * /sharing: the books the reader shares and with whom, with a way to stop each, and the books others share with them,
 * with a way to take each off their shelf. Sharing itself starts from a book's menu on the shelf, or "Share with more" here.
 */
export function SharingPage() {
  useDocumentTitle(`Sharing - ${APP_NAME}`);
  const { info } = useSession();
  const readerId = info?.mode === "profiles" ? (info.session?.profile.id ?? null) : null;
  const [overview, setOverview] = useState<SharingOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Given | null>(null);

  useEffect(() => {
    let current = true;
    setLoadError(null);
    api
      .sharing()
      .then((found) => current && setOverview(found))
      .catch((err: Error) => current && setLoadError(err.message));
    return () => {
      current = false;
    };
  }, [attempt]);

  async function act(key: string, work: () => Promise<void>, failure: string) {
    setPending(key);
    setError(null);
    try {
      await work();
      setOverview(await api.sharing());
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setPending(null);
    }
  }

  if (readerId === null) {
    return (
      <main className="admin admin-narrow">
        <h1>Sharing</h1>
        <p className="admin-note">Sharing books needs profiles. The admin turns them on by setting ADMIN_PASSKEY in the .env file.</p>
        <Link href="/" className="admin-back">
          Back to the library
        </Link>
      </main>
    );
  }

  return (
    <main className="admin sharing">
      <header className="admin-head">
        <div className="admin-title">
          <Link href="/" className="admin-home" aria-label="Back to the library" title="Back to the library">
            <ArrowLeft size={20} aria-hidden />
          </Link>
          <h1>Sharing</h1>
        </div>
      </header>
      <p className="sharing-intro">Sharing is caring. Whoever you share a book with reads it with their own notes and place, and you can stop at any time.</p>

      {loadError && (
        <div className="library-retry">
          <p className="inline-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {error && (
        <p className="inline-error admin-error" role="alert">
          {error}
        </p>
      )}
      {overview === null && !loadError && <p className="admin-quiet">Loading...</p>}

      {overview && (
        <>
          <section className="sharing-section" aria-labelledby="sharing-given">
            <h2 id="sharing-given" className="sharing-heading">
              Books you share
            </h2>
            {overview.given.length === 0 ? (
              <p className="admin-quiet">You are not sharing any books. Share one from the ... menu under its cover on your shelf.</p>
            ) : (
              <ul className="sharing-list">
                {overview.given.map((book) => (
                  <li key={book.bookId} className="sharing-row">
                    <span className="sharing-cover">
                      <Cover book={{ id: book.bookId, title: book.title, author: book.author, hasCover: book.hasCover }} />
                    </span>
                    <div className="sharing-body">
                      <h3 className="sharing-title">{book.title}</h3>
                      <ul className="sharing-people" aria-label="Shared with">
                        {book.with.map(({ profile }) => {
                          const key = `${book.bookId}/${profile.id}`;
                          return (
                            <li key={profile.id} className="sharing-chip">
                              <Avatar profile={profile} size={24} />
                              <span>{profile.name}</span>
                              <button
                                type="button"
                                className="sharing-stop"
                                aria-label={`Stop sharing ${book.title} with ${profile.name}`}
                                title={`Stop sharing with ${profile.name}`}
                                disabled={pending !== null}
                                onClick={() =>
                                  void act(key, () => api.unshareBook(book.bookId, profile.id), `Could not stop sharing it with ${profile.name}. Please try again.`)
                                }
                              >
                                <X size={16} aria-hidden />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      <button type="button" className="quiet-button" disabled={pending !== null} onClick={() => setSharing(book)}>
                        <UserPlus size={16} aria-hidden /> Share with more
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sharing-section" aria-labelledby="sharing-received">
            <h2 id="sharing-received" className="sharing-heading">
              Shared with you
            </h2>
            {overview.received.length === 0 ? (
              <p className="admin-quiet">Nobody has shared a book with you yet.</p>
            ) : (
              <ul className="sharing-list">
                {overview.received.map((book) => (
                  <li key={book.bookId} className="sharing-row">
                    <Link href={`/book/${book.bookId}`} className="sharing-cover" aria-label={`Read ${book.title}`}>
                      <Cover book={{ id: book.bookId, title: book.title, author: book.author, hasCover: book.hasCover }} />
                    </Link>
                    <div className="sharing-body">
                      <h3 className="sharing-title">{book.title}</h3>
                      <p className="sharing-from">
                        <Avatar profile={book.from} size={24} />
                        <span>
                          {book.from.name} shared it on {sinceText(book.sharedAt)}
                        </span>
                      </p>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={pending !== null}
                        onClick={() =>
                          void act(book.bookId, () => api.deleteBook(book.bookId), "Could not take it off your shelf. Please try again.")
                        }
                      >
                        <BookMinus size={16} aria-hidden /> {pending === book.bookId ? "Removing..." : "Remove from my shelf"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {sharing && (
        <ShareDialog
          book={{ id: sharing.bookId, title: sharing.title }}
          readerId={readerId}
          onClose={() => {
            setSharing(null);
            setAttempt((n) => n + 1);
          }}
        />
      )}
    </main>
  );
}
