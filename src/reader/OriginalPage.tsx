import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import "./original-page.css";

/** The actual printed page is a fidelity reference, without leaving the reader or sharing its PDF. */
export function OriginalPage({ bookId, startPage, pageCount }: { bookId: string; startPage: number; pageCount: number }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(startPage);
  const [zoom, setZoom] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const visit = (next: number) => {
    if (next < 1 || next > pageCount) return;
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
          <img key={`${page}-${retry}`} src={`/api/books/${encodeURIComponent(bookId)}/pages/${page}?retry=${retry}`} alt={`Original printed page ${page}`} onLoad={() => setStatus("ready")} onError={() => setStatus("error")} hidden={status !== "ready"} />
        </div>
      </dialog>, document.body,
    )}
  </>;
}
