import { Route, Switch } from "wouter";
import { LibraryPage } from "./LibraryPage.tsx";
import { ReaderPage } from "./reader/ReaderPage.tsx";

export function App() {
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
