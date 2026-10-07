import { BookOpenText, Download, Search, Undo2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { MAX_REFLECTION_CHARS, type BookDetail, type Note, type ReflectionNote } from "../../shared/types.ts";
import { exportNotebookMarkdown } from "./notebookExport.ts";
import { entryKind, entryNoun, entryPreview, entryText, groupByChapter, keptEntries, type EntryKind } from "./notebookEntries.ts";
import { EntryTag, NotebookNote } from "./NotebookNote.tsx";
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

const KINDS: { value: EntryKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "highlight", label: "Highlights" },
  { value: "answer", label: "Answers" },
  { value: "reflection", label: "Reflections" },
];

/** Wide enough for the list and the open note side by side (the same width as in styles.css). */
const SIDE_BY_SIDE = "(min-width: 52rem)";

/** A new reflection, once saved, is opened when it shows up in the list: saving does not say which id it got. */
type JustSaved = NotebookDraft & { text: string };

/** The reader's private, per-book collection of passages and words: a list by chapter, and one entry open in full. */
export function Notebook({ book, entries, initialDraft, removed, syncState, actions, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const listPane = useRef<HTMLElement>(null);
  const notePane = useRef<HTMLElement>(null);
  const groupId = useId();
  const [chapterId, setChapterId] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<EntryKind | "all">("all");
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // Checkboxes only while choosing what to export: the rest of the time the list is for reading.
  const [choosing, setChoosing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusNote, setFocusNote] = useState(false);
  const [draft, setDraft] = useState<NotebookDraft | null>(initialDraft);
  const [editId, setEditId] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [justSaved, setJustSaved] = useState<JustSaved | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const kept = useMemo(() => keptEntries(entries, book.chapters), [entries, book.chapters]);
  const selectedIds = useMemo(() => {
    const valid = new Set(kept.map((note) => note.id));
    return selected === null ? valid : new Set([...selected].filter((id) => valid.has(id)));
  }, [kept, selected]);
  // The chapter and the search narrow the list first, so each kind's count says how many it would show.
  const matching = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return kept.filter((note) => (!chapterId || note.chapterId === chapterId) && (!term || `${note.quote} ${entryText(note)}`.toLocaleLowerCase().includes(term)));
  }, [kept, chapterId, query]);
  const counts = useMemo(() => {
    const byKind: Record<EntryKind | "all", number> = { all: matching.length, highlight: 0, answer: 0, reflection: 0 };
    for (const note of matching) byKind[entryKind(note)] += 1;
    return byKind;
  }, [matching]);
  const visible = useMemo(() => (kind === "all" ? matching : matching.filter((note) => entryKind(note) === kind)), [matching, kind]);
  const groups = useMemo(() => groupByChapter(visible, book.chapters), [visible, book.chapters]);
  const allVisibleSelected = visible.every((note) => selectedIds.has(note.id));
  const chapters = useMemo(() => new Map(book.chapters.map((chapter) => [chapter.id, chapter.title])), [book.chapters]);
  const open = kept.find((note) => note.id === openId) ?? null;

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

  useEffect(() => {
    if (!justSaved) return;
    const saved = kept.findLast((note) => note.mode === "reflection" && note.blockId === justSaved.blockId && note.offset === justSaved.offset
      && note.quote === justSaved.quote && note.text === justSaved.text);
    if (saved) {
      setOpenId(saved.id);
      setJustSaved(null);
    }
  }, [kept, justSaved]);

  useEffect(() => {
    if (focusNote && open) notePane.current?.focus();
    setFocusNote(false);
  }, [focusNote, open]);

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

  function openEntry(id: string) {
    setOpenId(id);
    setSourceError(null);
    // Side by side the list keeps focus, to go on choosing; one at a time, the note takes the list's place and focus.
    setFocusNote(!window.matchMedia(SIDE_BY_SIDE).matches);
  }

  function backToList() {
    const id = openId;
    setOpenId(null);
    setSourceError(null);
    requestAnimationFrame(() => listPane.current?.querySelector<HTMLButtonElement>(`[data-entry="${CSS.escape(id ?? "")}"] .notebook__row`)?.focus());
  }

  function remove(note: Note) {
    actions.remove(note.id);
    setOpenId(null);
    setSourceError(null);
    listPane.current?.focus();
  }

  function startEdit(note: ReflectionNote) {
    setDraft({ chapterId: note.chapterId, blockId: note.blockId, quote: note.quote, offset: note.offset });
    setEditId(note.id);
    setText(note.text);
    requestAnimationFrame(() => editor.current?.focus());
  }

  function cancelDraft() {
    setDraft(null);
    setEditId(undefined);
    setText("");
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !text.trim()) return;
    actions.saveReflection(draft, text.trim(), editId);
    if (editId) setOpenId(editId);
    else setJustSaved({ ...draft, text: text.trim() });
    cancelDraft();
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
    <dialog ref={dialog} className="notebook" data-view={open ? "note" : "list"} aria-labelledby="notebook-title" onClose={onClose} onClick={closeOnBackdrop}>
      <header className="notebook__head">
        <div><h2 id="notebook-title">Notebook</h2><p>{book.title}</p></div>
        <button type="button" className="icon-button" aria-label="Close notebook" onClick={() => dialog.current?.close()}><X size={20} aria-hidden /></button>
      </header>
      <div className="notebook__tools">
        <label className="notebook__search"><Search size={18} aria-hidden /><span className="visually-hidden">Search notebook</span><input ref={search} type="search" placeholder="Search your notebook" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="notebook__chapter"><span className="visually-hidden">Filter by chapter</span><select value={chapterId} onChange={(event) => setChapterId(event.target.value)}><option value="">All chapters</option>{book.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>
        <button type="button" className="quiet-button notebook__export" disabled={selectedIds.size === 0} onClick={exportSelected}><Download size={18} aria-hidden /> {selectedIds.size === kept.length ? "Export all" : `Export ${selectedIds.size} selected`}</button>
      </div>
      <div className="notebook__sync"><NoteSyncStatus state={syncState} onRetry={actions.retry} onDiscard={actions.discard} /></div>
      {removed && <div className="notebook__undo" role="status">Entry removed. <button type="button" className="link-button" onClick={actions.restore}><Undo2 size={16} aria-hidden /> Undo</button></div>}
      {draft && <form className="notebook__editor" onSubmit={save}>
        <div className="notebook__editor-head"><h3>{editId ? "Edit reflection" : "New reflection"}</h3><button type="button" className="icon-button" aria-label="Cancel reflection" onClick={cancelDraft}><X size={18} aria-hidden /></button></div>
        <blockquote>{draft.quote}</blockquote>
        <label htmlFor="notebook-reflection">Your reflection</label>
        <textarea ref={editor} id="notebook-reflection" value={text} maxLength={MAX_REFLECTION_CHARS} rows={4} required onChange={(event) => setText(event.target.value)} />
        <div className="notebook__editor-actions"><span>{text.length} / {MAX_REFLECTION_CHARS}</span><button type="submit" className="button" disabled={!text.trim()}>{editId ? "Save changes" : "Save reflection"}</button></div>
      </form>}
      {kept.length > 0 && <div className="notebook__filters">
        <div className="notebook__kinds" role="group" aria-label="Show">
          {KINDS.map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label} <span>{counts[value]}</span></button>
          ))}
        </div>
        <div className="notebook__list-head">
          <span role="status">{visible.length} {visible.length === 1 ? "entry" : "entries"}</span>
          {visible.length > 0 && (choosing ? (
            <>
              <button type="button" className="link-button" onClick={toggleVisible}>{allVisibleSelected ? "Clear shown" : "Select shown"}</button>
              <button type="button" className="link-button" onClick={() => setChoosing(false)}>Done</button>
            </>
          ) : <button type="button" className="link-button" onClick={() => setChoosing(true)}>Select</button>)}
        </div>
      </div>}
      <div className="notebook__panes">
        <section ref={listPane} className="notebook__list" aria-label="Notebook entries" tabIndex={-1}>
          {kept.length === 0 ? <p className="notebook__empty">No notebook entries yet. Select a passage in the book to highlight it, save an explanation, or add a reflection.</p>
            : visible.length === 0 ? <p className="notebook__empty">No entries match these filters.</p>
            : groups.map((group, index) => (
              <section key={group.chapterId} className="notebook__group" aria-labelledby={`${groupId}-${index}`}>
                <h3 id={`${groupId}-${index}`} className="notebook__group-title"><span>{group.title}</span><span>{group.entries.length}</span></h3>
                <ol className="notebook__entries">
                  {group.entries.map((note) => {
                    const preview = entryPreview(note);
                    return (
                      <li key={note.id} className="notebook__entry" data-entry={note.id}>
                        {choosing && <label className="notebook__select"><input type="checkbox" checked={selectedIds.has(note.id)} onChange={() => toggle(note.id)} aria-label={`Select ${entryNoun(note)} from ${group.title}`} /></label>}
                        <button type="button" className="notebook__row" aria-current={note.id === openId ? "true" : undefined} onClick={() => openEntry(note.id)}>
                          <EntryTag note={note} />
                          <span className="notebook__quote">{note.quote}</span>
                          {preview && <span className="notebook__preview">{preview}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
        </section>
        <section ref={notePane} className="notebook__note" aria-label="Selected note" tabIndex={-1}>
          {open ? (
            <NotebookNote
              note={open}
              chapterTitle={chapters.get(open.chapterId) ?? open.chapterId}
              onBack={backToList}
              onOpenSource={() => void openSource(open)}
              onEdit={startEdit}
              onRemove={() => remove(open)}
              error={sourceError && <p className="inline-error notebook__error" role="alert">{sourceError}</p>}
            />
          ) : (
            <div className="notebook__placeholder">
              <BookOpenText size={28} aria-hidden />
              <p>{kept.length === 0 ? "Your highlights, saved answers and reflections will be kept here." : "Choose a note to read it here."}</p>
            </div>
          )}
        </section>
      </div>
    </dialog>
  );
}
