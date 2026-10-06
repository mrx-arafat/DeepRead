import { Route, Switch } from "wouter";
import { AdminPage } from "./admin/AdminPage.tsx";
import { LibraryPage } from "./LibraryPage.tsx";
import { ProfilesPage } from "./profiles/ProfilesPage.tsx";
import { useSession } from "./profiles/session.tsx";
import { Startup } from "./profiles/Startup.tsx";
import { ReaderPage } from "./reader/ReaderPage.tsx";

export function App() {
  const { info, error, retry, choosing } = useSession();
  return (
    <Switch>
      {/* Always the admin page, signed in or not: it asks for the passkey itself. */}
      <Route path="/admin" component={AdminPage} />
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
      {/* One reader per book: its notes, chapters and position all belong to that book. */}
      <Route path="/book/:bookId/:chapterId?">
        {(params) => <ReaderPage key={params.bookId} bookId={params.bookId} chapterId={params.chapterId ?? null} />}
      </Route>
      <Route>
        <LibraryPage />
      </Route>
    </Switch>
  );
}
