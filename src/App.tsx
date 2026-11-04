import { lazy, Suspense, useState } from "react";
import { Route, Switch } from "wouter";
import { api, NOT_REACHABLE } from "./api.ts";
import { useFavicon } from "./favicon.ts";
import { loadedReader, loadReader } from "./loadReader.ts";
import { usePrefs } from "./prefs.ts";
import { SharingPage } from "./library/SharingPage.tsx";
import { LibraryPage } from "./LibraryPage.tsx";
import { ProfilesPage } from "./profiles/ProfilesPage.tsx";
import { useSession } from "./profiles/session.tsx";
import { Startup } from "./profiles/Startup.tsx";

// The library is the page most visits start on: its list is asked for now, beside the session question, not after it.
// A visit that starts on a book asks for the reader's code instead, beside the same question.
if (typeof location !== "undefined") {
  if (location.pathname === "/") api.prefetchBooks();
  else if (location.pathname.startsWith("/book/")) loadReader().catch(() => {});
}

// Only the admin opens it, so readers never download it: it is fetched the first time /admin is opened.
const AdminPage = lazy(() => import("./admin/AdminPage.tsx").then((module) => ({ default: module.AdminPage })));

export function App() {
  const { info, error, retry, choosing } = useSession();
  useFavicon(usePrefs().theme);
  return (
    <Switch>
      {/* Always the admin page, signed in or not: it asks for the passkey itself. */}
      <Route path="/admin">
        <Suspense fallback={null}>
          <AdminPage />
        </Suspense>
      </Route>
      <Route>
        {info === null ? (
          <Startup error={error} onRetry={retry} />
        ) : info.mode === "profiles" && (info.session === null || choosing) ? (
          <ProfilesPage />
        ) : (
          // A different reader (signing in, or the admin reading as someone) starts the shelf over, so none of the last reader's books stay on screen.
          <Shelf key={info.mode === "profiles" && info.session ? info.session.profile.id : "single"} />
        )}
      </Route>
    </Switch>
  );
}

function Shelf() {
  return (
    <Switch>
      <Route path="/" component={LibraryPage} />
      <Route path="/sharing" component={SharingPage} />
      {/* One reader per book: its notes, chapters and position all belong to that book. */}
      <Route path="/book/:bookId/:chapterId?">
        {(params) => <Reader key={params.bookId} bookId={params.bookId} chapterId={params.chapterId ?? null} />}
      </Route>
      <Route>
        <LibraryPage />
      </Route>
    </Switch>
  );
}

/** Its code could not be fetched (DeepRead stopped, or was updated since this page loaded): loading the page again fixes both. */
function ReaderUnreachable() {
  return <Startup error={NOT_REACHABLE} onRetry={() => location.reload()} />;
}

/**
 * The reader page, drawn at once when its code is already in, as it nearly always is (the library asks for it once the
 * shelf is up). Otherwise it waits for the code, kept as it began for this book, so the page is never swapped under the
 * reader once it has drawn.
 */
function Reader({ bookId, chapterId }: { bookId: string; chapterId: string | null }) {
  const [Page] = useState(
    () => loadedReader() ?? lazy(() => loadReader().then((page) => ({ default: page }), () => ({ default: ReaderUnreachable }))),
  );
  return (
    <Suspense fallback={<Startup error={null} onRetry={() => {}} />}>
      <Page bookId={bookId} chapterId={chapterId} />
    </Suspense>
  );
}
