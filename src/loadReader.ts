import type { ReaderPage } from "./reader/ReaderPage.tsx";

type Page = typeof ReaderPage;

let loaded: Page | null = null;
let loading: Promise<Page> | null = null;

/**
 * The reader page's code, in a file of its own: the library's first paint does not wait for most of the app. Asked for
 * once the shelf is up, as a book is opened, or at once when the app starts on a book. A failed load is asked again.
 */
export function loadReader(): Promise<Page> {
  loading ??= import("./reader/ReaderPage.tsx").then(
    (module) => (loaded = module.ReaderPage),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The reader page, once its code is in; null before. */
export function loadedReader(): Page | null {
  return loaded;
}
