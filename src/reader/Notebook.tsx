import { Download, MapPin, Pencil, Search, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { MAX_REFLECTION_CHARS, type BookDetail, type Note, type ReflectionNote } from "../../shared/types.ts";
import { exportNotebookMarkdown } from "./notebookExport.ts";
import { NoteSyncStatus } from "./NoteSyncStatus.tsx";
import type { NoteSyncState } from "./noteSync.ts";

export type NotebookDraft = { chapterId: string; blockId: string; quote: string; offset: number };

type Props = {
  book: BookDetail;
  entries: Note[];
  initialDraft: NotebookDraft | null;
  removed: Note | null;
  syncState: NoteSyncState;
  actions: {
    saveReflection: (draft: NotebookDraft, text: string, id?: string) => void;
    remove: (id: string) => void;
    restore: () => void;
    openSource: (note: Note) => Promise<boolean>;
    retry: () => void;
    discard: () => void;
  };
  onClose: () => void;
};

function keptEntry(note: Note): boolean {
  return note.mode === "highlight" || note.mode === "reflection" || Boolean(note.savedAnswer?.trim());
}

function entryText(note: Note): string {
  return note.mode === "reflection" ? note.text : note.mode === "highlight" ? "" : note.savedAnswer ?? "";
}

/** The reader's private, per-book collection of passages and words. */
export function Notebook({ book, entries, initialDraft, removed, syncState, actions, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [chapterId, setChapterId] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [draft, setDraft] = useState<NotebookDraft | null>(initialDraft);
  const [editId, setEditId] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);

  const kept = useMemo(() => entries.filter(keptEntry), [entries]);
  const selectedIds = useMemo(() => {
    const valid = new Set(kept.map((note) => note.id));
    return selected === null ? valid : new Set([...selected].filter((id) => valid.has(id)));
  }, [kept, selected]);
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return kept.filter((note) => (!chapterId || note.chapterId === chapterId) && (!term || `${note.quote} ${entryText(note)}`.toLocaleLowerCase().includes(term)));
  }, [kept, chapterId, query]);
  const allVisibleSelected = visible.every((note) => selectedIds.has(note.id));
  const chapters = useMemo(() => new Map(book.chapters.map((chapter) => [chapter.id, chapter.title])), [book.chapters]);

  useEffect(() => {
    const box = dialog.current;
    box?.showModal();
    if (initialDraft) editor.current?.focus();
    else search.current?.focus();
    return () => { if (box?.open) box.close(); };
  }, [initialDraft]);

  useEffect(() => {
    if (initialDraft) {
      setDraft(initialDraft);
      setEditId(undefined);
      setText("");
      editor.current?.focus();
    }
  }, [initialDraft]);

  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === event.currentTarget && outside) dialog.current?.close();
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = current === null ? new Set(kept.map((note) => note.id)) : new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((current) => {
      const next = new Set(current ?? kept.map((note) => note.id));
      for (const note of visible) {
        if (allVisibleSelected) next.delete(note.id);
        else next.add(note.id);
      }
      return next;
    });
  }

  function exportSelected() {
    const markdown = exportNotebookMarkdown({ book, entries: kept, selectedIds });
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${book.title.replace(/[^a-z0-9 -]/gi, "").trim() || "book"}-notebook.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function startEdit(note: ReflectionNote) {
    setDraft({ chapterId: note.chapterId, blockId: note.blockId, quote: note.quote, offset: note.offset });
    setEditId(note.id);
    setText(note.text);
    editor.current?.focus();
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !text.trim()) return;
    actions.saveReflection(draft, text.trim(), editId);
    setDraft(null);
    setEditId(undefined);
    setText("");
  }

  async function openSource(note: Note) {
    setSourceError(null);
    try {
      if (await actions.openSource(note)) dialog.current?.close();
      else setSourceError("This passage is no longer available in the book.");
    } catch {
      setSourceError("Could not open this passage. Try again.");
    }
  }

  return (
    <dialog ref={dialog} className="notebook" aria-labelledby="notebook-title" onClose={onClose} onClick={closeOnBackdrop}>
      <header className="notebook__head">
        <div><h2 id="notebook-title">Notebook</h2><p>{book.title}</p></div>
        <button type="button" className="icon-button" aria-label="Close notebook" onClick={() => dialog.current?.close()}><X size={20} aria-hidden /></button>
      </header>
      <div className="notebook__tools">
        <label className="notebook__search"><Search size={18} aria-hidden /><span className="visually-hidden">Search notebook</span><input ref={search} type="search" placeholder="Search your notebook" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="notebook__chapter"><span className="visually-hidden">Filter by chapter</span><select value={chapterId} onChange={(event) => setChapterId(event.target.value)}><option value="">All chapters</option>{book.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>
        <button type="button" className="quiet-button notebook__export" disabled={selectedIds.size === 0} onClick={exportSelected}><Download size={18} aria-hidden /> Export selected</button>
      </div>
      <div className="notebook__sync"><NoteSyncStatus state={syncState} onRetry={actions.retry} onDiscard={actions.discard} /></div>
      {removed && <div className="notebook__undo" role="status">Entry removed. <button type="button" className="link-button" onClick={actions.restore}><Undo2 size={16} aria-hidden /> Undo</button></div>}
      {sourceError && <p className="inline-error notebook__error" role="alert">{sourceError}</p>}
      {draft && <form className="notebook__editor" onSubmit={save}>
        <div className="notebook__editor-head"><h3>{editId ? "Edit reflection" : "New reflection"}</h3><button type="button" className="icon-button" aria-label="Cancel reflection" onClick={() => { setDraft(null); setEditId(undefined); setText(""); }}><X size={18} aria-hidden /></button></div>
        <blockquote>{draft.quote}</blockquote>
        <label htmlFor="notebook-reflection">Your reflection</label>
        <textarea ref={editor} id="notebook-reflection" value={text} maxLength={MAX_REFLECTION_CHARS} rows={4} required onChange={(event) => setText(event.target.value)} />
        <div className="notebook__editor-actions"><span>{text.length} / {MAX_REFLECTION_CHARS}</span><button type="submit" className="button" disabled={!text.trim()}>{editId ? "Save changes" : "Save reflection"}</button></div>
      </form>}
      <div className="notebook__body">
        <div className="notebook__list-head"><span role="status">{visible.length} {visible.length === 1 ? "entry" : "entries"}</span>{visible.length > 0 && <button type="button" className="link-button" onClick={toggleVisible}>{allVisibleSelected ? "Clear shown" : "Select shown"}</button>}</div>
        {kept.length === 0 ? <p className="notebook__empty">No notebook entries yet. Select a passage in the book to highlight it or add a reflection.</p> : visible.length === 0 ? <p className="notebook__empty">No entries match these filters.</p> : <ol className="notebook__entries">{visible.map((note) => <li key={note.id} className="notebook__entry">
          <label className="notebook__select"><input type="checkbox" checked={selectedIds.has(note.id)} onChange={() => toggle(note.id)} aria-label={`Select ${note.mode === "highlight" ? "highlight" : note.mode === "reflection" ? "reflection" : "saved answer"} from ${chapters.get(note.chapterId) ?? note.chapterId}`} /></label>
          <div className="notebook__content"><div className="notebook__meta"><span>{chapters.get(note.chapterId) ?? note.chapterId}</span><span>{note.mode === "highlight" ? "Highlight" : note.mode === "reflection" ? "Reflection" : "Saved answer"}</span></div><blockquote>{note.quote}</blockquote>{entryText(note) && <p className="notebook__words">{entryText(note)}</p>}
            <div className="notebook__actions"><button type="button" className="quiet-button" onClick={() => void openSource(note)}><MapPin size={17} aria-hidden /> Open passage</button>{note.mode === "reflection" && <button type="button" className="quiet-button" onClick={() => startEdit(note)}><Pencil size={17} aria-hidden /> Edit</button>}<button type="button" className="icon-button" aria-label={`Remove ${note.mode === "highlight" ? "highlight" : note.mode === "reflection" ? "reflection" : "saved answer"}`} onClick={() => actions.remove(note.id)}><Trash2 size={18} aria-hidden /></button></div>
          </div>
        </li>)}</ol>}
      </div>
    </dialog>
  );
}
