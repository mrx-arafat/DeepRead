import { Route, Switch } from "wouter";
import { LibraryPage } from "./LibraryPage.tsx";
import { ReaderPage } from "./reader/ReaderPage.tsx";

export function App() {
  return (
    <Switch>
      <Route path="/" component={LibraryPage} />
      <Route path="/book/:bookId/:chapterId?">
        {(params) => <ReaderPage bookId={params.bookId} chapterId={params.chapterId ?? null} />}
      </Route>
      <Route>
        <LibraryPage />
      </Route>
    </Switch>
  );
}
