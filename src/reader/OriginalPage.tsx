import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import "./original-page.css";
import type { SourcePageText } from "../../shared/source-page.ts";
import { readSourcePageText, SourcePageTextLayer } from "./SourcePageText.tsx";

/** The actual printed page is a fidelity reference, without leaving the reader or sharing its PDF. */
export function OriginalPage({ bookId, startPage, pageCount }: { bookId: string; startPage: number; pageCount: number }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(startPage);
  const [zoom, setZoom] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [text, setText] = useState<{ key: string; data: SourcePageText | null; unavailable: boolean } | null>(null);
  const textKey = `${bookId}/${page}/${retry}`;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const key = textKey;
    let active = true;
    fetch(`/api/books/${encodeURIComponent(bookId)}/pages/${page}/text?retry=${retry}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("page text unavailable");
        const data = readSourcePageText(await response.json());
        if (!data) throw new Error("invalid page text");
        if (active) setText({ key, data, unavailable: data.runs.length === 0 });
      })
      .catch(() => { if (active && !controller.signal.aborted) setText({ key, data: null, unavailable: true }); });
    return () => { active = false; controller.abort(); };
  }, [open, bookId, page, retry, textKey]);
  const pageText = text?.key === textKey ? text : null;
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const visit = (next: number) => {
    if (!Number.isInteger(next) || next < 1 || next > pageCount || next === page) return;
    setStatus("loading");
    setPage(next);
  };
  return <>
    <button ref={trigger} type="button" className="link-button original-page-trigger" onClick={() => {
      setPage(startPage); setZoom(false); setStatus("loading"); setOpen(true);
    }}>Original pages</button>
    {open && createPortal(
      <dialog ref={dialog} className="original-page-dialog" aria-labelledby="original-page-title" onClose={close}>
        <header className="original-page-controls">
          <h2 id="original-page-title">Original page {page} of {pageCount}</h2>
          <button className="icon-button" type="button" aria-label="Close original pages" onClick={() => dialog.current?.close()}><X size={20} aria-hidden /></button>
        </header>
        <div className="original-page-navigation">
          <button type="button" className="icon-button" aria-label="Previous original page" disabled={page <= 1} onClick={() => visit(page - 1)}><ChevronLeft size={20} aria-hidden /></button>
          <label>Page <input type="number" min={1} max={pageCount} value={page} onChange={(event) => visit(Number(event.target.value))} /></label>
          <button type="button" className="icon-button" aria-label="Next original page" disabled={page >= pageCount} onClick={() => visit(page + 1)}><ChevronRight size={20} aria-hidden /></button>
          <button type="button" className="icon-button" aria-label={zoom ? "Fit original page" : "Zoom original page"} onClick={() => setZoom(!zoom)}>{zoom ? <ZoomOut size={20} aria-hidden /> : <ZoomIn size={20} aria-hidden />}</button>
        </div>
        <div className="original-page-image" data-zoom={zoom || undefined}>
          {status === "loading" && <p role="status">Loading original page…</p>}
          {status === "error" && <p role="alert">This page could not be displayed. <button type="button" className="link-button" onClick={() => { setStatus("loading"); setRetry(retry + 1); }}>Try again</button></p>}
          <div className="original-page-frame" hidden={status !== "ready"}>
            <img key={`${page}-${retry}`} src={`/api/books/${encodeURIComponent(bookId)}/pages/${page}?retry=${retry}`} alt={`Original printed page ${page}`} onLoad={() => setStatus("ready")} onError={() => setStatus("error")} draggable={false} />
            {status === "ready" && pageText?.data?.runs.length ? <SourcePageTextLayer page={pageText.data} /> : null}
          </div>
        </div>
        {status === "ready" && pageText?.unavailable && <p className="original-page-text-status">This page is displayed as an image. Selectable text is unavailable.</p>}
        {status === "ready" && pageText?.data?.warning && <p className="original-page-text-status">{pageText.data.warning}</p>}
      </dialog>, document.body,
    )}
  </>;
}
