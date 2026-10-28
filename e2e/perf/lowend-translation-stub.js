// Answers chapter translation requests inside the page, so a measurement never calls a translation service and never
// writes a translation: the reply has one Bangla line per block, built from the chapter's own JSON, after `delayMs`.
// Inject after lowend-probe.js; records every answered request in window.__lowend.translationRequests.
(() => {
  const L = (window.__lowend = window.__lowend || {});
  if (L.translationStubbed) return;
  L.translationStubbed = true;
  L.translationRequests = [];
  const delayMs = Number(L.translationDelayMs ?? 600);
  const previous = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input.url;
    const match = url.match(/\/api\/books\/([^/]+)\/chapters\/([^/?]+)\/translation\?lang=([a-z]+)/);
    if (!match) return previous.call(this, input, init);
    const [, bookId, chapterId, lang] = match;
    const started = performance.now();
    const chapter = await (await previous.call(this, `/api/books/${bookId}/chapters/${chapterId}`)).json();
    const blocks = {};
    for (const block of chapter.blocks) {
      if (block.type === "image" || !block.text.trim()) continue;
      // About as long as the source, in a script that needs its own font: what a real translation costs to lay out.
      const words = Math.max(3, Math.round(block.text.split(/\s+/).length * 0.9));
      blocks[block.id] = Array.from({ length: words }, (_, at) => ["অনুবাদ", "পড়ার", "সময়", "মূল", "লেখা", "এবং", "অবস্থান", "ঠিক", "থাকবে", "বইয়ের"][(at + block.id.length) % 10]).join(" ") + "।";
    }
    const body = JSON.stringify({ lang, engine: "microsoft", blocks });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    L.translationRequests.push({ chapterId, blocks: Object.keys(blocks).length, bytes: new TextEncoder().encode(body).length, ms: Math.round(performance.now() - started) });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
})();
