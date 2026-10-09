import { Search, X } from "lucide-react";
import { useEffect, useRef } from "react";

/** Search stays above changing results so typing never moves the field away. */
export function LibrarySearch({ query, onQuery, count }: { query: string; onQuery: (query: string) => void; count: number }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || document.querySelector("dialog[open], :popover-open")) return;
      const editing = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]");
      if ((event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !editing && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <section className="library-search" aria-label="Search your library">
      <label className="visually-hidden" htmlFor="library-search">Find a book</label>
      <div className="library-search-field">
        <Search size={22} strokeWidth={1.7} aria-hidden />
        <input ref={input} id="library-search" type="search" autoComplete="off" placeholder="Search books and authors" value={query}
          aria-describedby="library-search-help" aria-keyshortcuts="Control+k Meta+k /"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); onQuery(""); } }} />
        {query ? <button type="button" className="icon-button" aria-label="Clear book search" title="Clear book search" onClick={() => { onQuery(""); input.current?.focus(); }}><X size={18} aria-hidden /></button> : <kbd aria-hidden>/</kbd>}
      </div>
      <div className="library-search-meta">
        <p id="library-search-help">Search by title or author</p>
        <p className="library-search-count" role="status">{query.trim() ? `${count} ${count === 1 ? "book" : "books"} found` : `${count} ${count === 1 ? "book" : "books"}`}</p>
      </div>
    </section>
  );
}
