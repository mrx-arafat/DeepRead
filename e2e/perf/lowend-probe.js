// Page-side probe for low-end reader measurements. Inject into the reader (or library) page before the app runs
// (playwright: page.addInitScript({ path }); chrome-devtools MCP: navigate_page initScript), then call window.__lowend.*.
// It only reads the page: no storage writes and no requests of its own. L.stub() answers chosen API calls locally, so a
// measurement never asks the AI or a translation service.
(() => {
  const L = (window.__lowend = window.__lowend || {});
  L.longTasks = L.longTasks || [];
  if (!L.observer && "PerformanceObserver" in window) {
    try {
      L.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) L.longTasks.push({ t: entry.startTime, d: entry.duration });
      });
      L.observer.observe({ type: "longtask", buffered: true });
    } catch {}
  }
  const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const heapMB = () => (performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10 : null);
  const nodes = () => document.getElementsByTagName("*").length;
  const since = (t) => L.longTasks.filter((entry) => entry.t >= t);
  const summarize = (tasks) => ({ count: tasks.length, totalMs: Math.round(tasks.reduce((sum, entry) => sum + entry.d, 0)), maxMs: Math.round(tasks.reduce((max, entry) => Math.max(max, entry.d), 0)) });
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
  };
  const firstParagraph = () => [...document.querySelectorAll(".chapter-text [data-block]")].find(visible);
  // One hit test, not a rect per chapter: the probe must not add layout work of its own to every frame.
  const chapterAtTop = () => document.elementFromPoint(Math.round(innerWidth / 2), 120)?.closest("[data-chapter]") ?? null;
  L.reset = () => { L.longTasks.length = 0; };
  L.snapshot = (label) => ({
    label, nodes: nodes(), heapMB: heapMB(),
    chaptersMounted: document.querySelectorAll("[data-chapter]").length,
    blocks: document.querySelectorAll("[data-block]").length,
    chunks: document.querySelectorAll(".text-chunk").length,
    contained: document.querySelectorAll("[data-mobile-rendering]").length,
    figures: document.querySelectorAll(".book-figure img").length,
    scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, layout: document.documentElement.dataset.layout ?? null,
  });
  /** Never let a measurement ask the AI or save anything: answer matching requests locally. */
  L.stub = (patterns) => {
    if (L.realFetch) return;
    L.realFetch = window.fetch;
    L.stubbed = [];
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      if (patterns.some((re) => re.test(url))) {
        L.stubbed.push(url);
        return Promise.resolve(new Response(JSON.stringify({ stubbed: true }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return L.realFetch.call(this, input, init);
    };
  };
  /** Click `el` (a shelf link) and wait until the first paragraph is on screen: the open time. */
  L.open = async (el, timeoutMs = 90000) => {
    const t0 = performance.now();
    el.click();
    while (performance.now() - t0 < timeoutMs) { await raf(); if (firstParagraph()) break; }
    const shownMs = performance.now() - t0;
    await raf(); await raf();
    const paintedMs = performance.now() - t0;
    await sleep(1500);
    return { openMs: Math.round(shownMs), paintedMs: Math.round(paintedMs), longTasks: summarize(since(t0)), tail1500: summarize(since(t0 + paintedMs)), url: location.pathname, ...L.snapshot("opened") };
  };
  /** Scroll steadily by `step` px per frame until `chapters` chapter sections were passed, or `screens` screens. */
  L.scroll = async ({ chapters = 10, screens = 0, step = 240, sampleAt = [1, 5, 10, 20], maxMs = 900000, waitMs = 60000 } = {}) => {
    const t0 = performance.now();
    const intervals = []; const samples = []; const seen = new Set();
    let stalls = 0; let stallMs = 0; let frames = 0; let screensDone = 0; let prev = performance.now();
    const sample = (section, n, tag) => samples.push({ chapter: n, id: section?.dataset.chapter ?? null, title: section?.querySelector("h2")?.textContent ?? null, tMs: Math.round(performance.now() - t0), ...L.snapshot(tag), longTasks: summarize(since(t0)) });
    const start = chapterAtTop();
    if (start) { seen.add(start.dataset.chapter); if (sampleAt.includes(1)) sample(start, 1, "ch1"); }
    // A giant chapter has no chapter boundaries to sample at: sample every 50 screens instead.
    const screenSamples = new Set([50, 100, 150, 200, 250, 300]);
    while (performance.now() - t0 < maxMs) {
      await raf();
      const now = performance.now(); intervals.push(now - prev); prev = now; frames++;
      const height = document.documentElement.scrollHeight;
      if (scrollY + innerHeight >= height - 2) {
        if (document.querySelector(".book-end")) break;
        const w0 = performance.now(); stalls++;
        while (document.documentElement.scrollHeight === height && performance.now() - w0 < waitMs) await sleep(50);
        stallMs += performance.now() - w0; prev = performance.now();
        if (document.documentElement.scrollHeight === height) break;
        continue;
      }
      scrollBy({ top: step, behavior: "instant" }); screensDone += step / innerHeight;
      if (screens) {
        const done = Math.floor(screensDone);
        if (screenSamples.has(done)) { screenSamples.delete(done); sample(chapterAtTop(), seen.size, "screens" + done); }
        if (screensDone >= screens) break;
      }
      if (frames % 5 !== 0) continue;
      const current = chapterAtTop(); const id = current?.dataset.chapter;
      if (id && !seen.has(id)) {
        seen.add(id); const n = seen.size;
        if (sampleAt.includes(n)) sample(current, n, "ch" + n);
        if (chapters && n > chapters) break;
      }
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
    return { frames, durationMs: Math.round(performance.now() - t0), stalls, stallMs: Math.round(stallMs), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(sorted.at(-1) ?? 0), over50ms: intervals.filter((i) => i > 50).length, over100ms: intervals.filter((i) => i > 100).length, longTasks: summarize(since(t0)), chaptersPassed: seen.size, screens: Math.round(screensDone), samples, end: L.snapshot("end") };
  };
  /** Pages mode: press Next until `chapters` chapters were passed or `maxTurns`, timing each turn until the page moved and painted. */
  L.turnPages = async ({ chapters = 10, maxTurns = 2000, sampleAt = [1, 5, 10, 20], waitMs = 60000 } = {}) => {
    const t0 = performance.now(); const turns = []; const samples = []; const seen = new Set();
    const sample = (section, n, tag) => samples.push({ chapter: n, id: section?.dataset.chapter ?? null, tMs: Math.round(performance.now() - t0), ...L.snapshot(tag), longTasks: summarize(since(t0)) });
    const start = chapterAtTop(); if (start) { seen.add(start.dataset.chapter); if (sampleAt.includes(1)) sample(start, 1, "ch1"); }
    let stalls = 0; let stallMs = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      const button = document.querySelector('button[aria-label="Next page"]');
      if (!button) return { error: "no Next page button", turns };
      if (button.disabled) {
        if (document.querySelector(".book-end")) break;
        const w0 = performance.now(); stalls++;
        while (button.disabled && performance.now() - w0 < waitMs) await sleep(50);
        stallMs += performance.now() - w0;
        if (button.disabled) break;
      }
      const before = scrollY; const t1 = performance.now();
      button.click();
      while (scrollY === before && performance.now() - t1 < 10000) await raf();
      await raf(); await raf();
      turns.push(Math.round(performance.now() - t1));
      if ([100, 200, 300].includes(turn + 1)) sample(chapterAtTop(), seen.size, "turns" + (turn + 1));
      const current = chapterAtTop(); const id = current?.dataset.chapter;
      if (id && !seen.has(id)) { seen.add(id); const n = seen.size; if (sampleAt.includes(n)) sample(current, n, "ch" + n); if (chapters && n > chapters) break; }
    }
    const sorted = [...turns].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return { turns: turns.length, durationMs: Math.round(performance.now() - t0), stalls, stallMs: Math.round(stallMs), p50: q(0.5), p95: q(0.95), max: sorted.at(-1) ?? 0, longTasks: summarize(since(t0)), chaptersPassed: seen.size, samples, end: L.snapshot("end") };
  };
  /** From the next pointerdown, time the first appearance of each kind of UI; read with L.latency(). */
  L.arm = () => {
    L.marks = { down: null, seen: {} };
    const onDown = () => { if (L.marks.down === null) L.marks.down = performance.now(); };
    document.addEventListener("pointerdown", onDown, true);
    const watch = new MutationObserver(() => {
      for (const [name, selector] of [["popover", ".word-popover"], ["selectionBar", ".selection-bar"], ["toc", "dialog.toc"]]) {
        if (!(name in L.marks.seen) && document.querySelector(selector)) L.marks.seen[name] = performance.now();
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    L.disarm = () => { document.removeEventListener("pointerdown", onDown, true); watch.disconnect(); };
  };
  L.latency = async () => {
    await sleep(1500); L.disarm?.();
    const down = L.marks?.down ?? null;
    const out = { fromPointerDown: {}, longTasks: down === null ? null : summarize(since(down)), stubbed: L.stubbed?.length ?? 0 };
    for (const [name, at] of Object.entries(L.marks?.seen ?? {})) out.fromPointerDown[name] = down === null ? null : Math.round(at - down);
    return out;
  };
  /** Put a real paragraph in the middle of the screen, as a reader would before tapping or selecting. */
  L.centreParagraph = async () => {
    const inBand = (el) => { const r = el.getBoundingClientRect(); return r.top > 130 && r.bottom < innerHeight - 160 && r.height > 0 && el.textContent.length > 60; };
    const all = [...document.querySelectorAll(".chapter-text p[data-block]")];
    if (all.some(inBand)) return true;
    const near = all.find((el) => { const r = el.getBoundingClientRect(); return r.top > -innerHeight && r.height > 0 && el.textContent.length > 60; }) ?? all[Math.floor(all.length / 2)];
    if (!near) return false;
    scrollBy({ top: near.getBoundingClientRect().top - 300, behavior: "instant" });
    await sleep(700);
    return all.some(inBand);
  };
  /** A point to tap inside a readable paragraph on screen, in CSS px. */
  L.wordTarget = () => {
    const p = [...document.querySelectorAll(".chapter-text p[data-block]")].find((el) => { const r = el.getBoundingClientRect(); return r.top > 130 && r.bottom < innerHeight - 120 && r.height > 0 && el.textContent.length > 40; });
    if (!p) return null;
    const range = document.createRange(); range.setStart(p.firstChild, 2); range.setEnd(p.firstChild, 3);
    const r = range.getBoundingClientRect();
    return { block: p.dataset.block, x: Math.round(r.left + 1), y: Math.round(r.top + r.height / 2) };
  };
  /** A touch tap on a word in a visible paragraph: time until the word card appears. */
  L.tapWord = async () => {
    await L.centreParagraph();
    L.arm();
    const target = L.wordTarget();
    if (!target) return { error: "no target" };
    const el = document.elementFromPoint(target.x, target.y);
    const opts = { bubbles: true, cancelable: true, clientX: target.x, clientY: target.y, button: 0, pointerType: "touch", isPrimary: true };
    for (const [type, Event] of [["pointerdown", PointerEvent], ["mousedown", MouseEvent], ["pointerup", PointerEvent], ["mouseup", MouseEvent], ["click", MouseEvent]]) el.dispatchEvent(new Event(type, opts));
    const result = await L.latency();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(600);
    return { target, ...result, dismissed: !document.querySelector(".word-popover") };
  };
  /** Touch-style selection of the first 40 characters of a visible paragraph: time until the Explain bar appears (includes the 400 ms settle). */
  L.selectText = async () => {
    await L.centreParagraph();
    const p = [...document.querySelectorAll(".chapter-text p[data-block]")].find((el) => { const r = el.getBoundingClientRect(); return r.top > 130 && r.bottom < innerHeight - 160 && r.height > 0 && el.textContent.length > 60; });
    if (!p) return { error: "no visible paragraph" };
    const text = p.firstChild; const end = Math.min(text.length, 40);
    p.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 100, clientY: 300 }));
    const t0 = performance.now();
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, end);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    while (!document.querySelector(".selection-bar") && performance.now() - t0 < 15000) await raf();
    const shown = performance.now() - t0; await raf();
    const found = Boolean(document.querySelector(".selection-bar"));
    await sleep(500);
    selection.removeAllRanges();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { ms: Math.round(shown), msAfterSettle: Math.round(shown - 400), found, longTasks: summarize(since(t0)) };
  };
  /** Open the chapter list and go to one chapter by id. */
  L.goTo = async (chapterId) => {
    const t0 = performance.now();
    document.querySelector('button[aria-label="Chapters"]').click();
    while (!document.querySelector("dialog.toc .toc-link") && performance.now() - t0 < 30000) await raf();
    const link = [...document.querySelectorAll("dialog.toc .toc-link")].find((a) => a.getAttribute("href").endsWith("/" + chapterId));
    if (!link) return { error: "no link for " + chapterId };
    link.click();
    while (!document.querySelector(`[data-chapter="${CSS.escape(chapterId)}"] [data-block]`) && performance.now() - t0 < 90000) await raf();
    await sleep(2000);
    return { chapterId, ms: Math.round(performance.now() - t0), ...L.snapshot("goto") };
  };
  /** The translation switch in the Aa menu. */
  L.setTranslation = async (on) => {
    const t0 = performance.now();
    document.querySelector('button[popovertarget="reading-settings"], .settings-button')?.click();
    while (!document.getElementById("reading-settings-translation") && performance.now() - t0 < 10000) await raf();
    const button = document.getElementById("reading-settings-translation");
    const pressed = () => button.getAttribute("aria-pressed") === "true" || button.getAttribute("aria-checked") === "true";
    if (pressed() !== on) button.click();
    await raf();
    document.getElementById("reading-settings")?.hidePopover?.();
    return { on, pressed: pressed(), prefs: localStorage.getItem("deepread.prefs") };
  };
  /** Open the chapter list, then jump to the chapter `fromEnd` entries before the last one. */
  L.jump = async (fromEnd = 2) => {
    const t0 = performance.now();
    document.querySelector('button[aria-label="Chapters"]').click();
    while (!document.querySelector("dialog.toc .toc-link") && performance.now() - t0 < 30000) await raf();
    await raf();
    const tocMs = performance.now() - t0;
    const links = [...document.querySelectorAll("dialog.toc .toc-link")];
    const link = links[Math.max(0, links.length - 1 - fromEnd)];
    const target = link.getAttribute("href").split("/").pop();
    const t1 = performance.now();
    link.click();
    const arrived = () => { const section = document.querySelector(`[data-chapter="${CSS.escape(target)}"]`); return section && [...section.querySelectorAll("[data-block]")].some(visible); };
    while (!arrived() && performance.now() - t1 < 90000) await raf();
    const jumpMs = performance.now() - t1; await raf(); await raf();
    await sleep(1500);
    return { tocOpenMs: Math.round(tocMs), tocEntries: links.length, target, jumpMs: Math.round(jumpMs), longTasks: summarize(since(t0)), ...L.snapshot("jumped") };
  };
  /** Switch Scroll/Pages through the Aa menu: time until the layout attribute changes and the page settles. */
  L.switchLayout = async (layout) => {
    const t0 = performance.now();
    document.querySelector('button[popovertarget="reading-settings"], .settings-button')?.click();
    while (!document.querySelector(`#reading-settings input[value="${layout}"]`) && performance.now() - t0 < 10000) await raf();
    const input = document.querySelector(`#reading-settings input[value="${layout}"]`);
    const t1 = performance.now();
    input.click();
    while (document.documentElement.dataset.layout !== layout && performance.now() - t1 < 30000) await raf();
    const switchedMs = performance.now() - t1; await raf(); await raf();
    const paintedMs = performance.now() - t1;
    document.getElementById("reading-settings")?.hidePopover?.();
    await sleep(2000);
    return { layout, switchedMs: Math.round(switchedMs), paintedMs: Math.round(paintedMs), longTasks: summarize(since(t1)), ...L.snapshot("switched") };
  };
  L.resources = () => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/")).map((entry) => ({ url: entry.name.replace(location.origin, ""), ms: Math.round(entry.duration), kb: Math.round(entry.transferSize / 1024) }));
  /** Count DOM churn and layout shifts from now until L.churn() is read: a proxy for re-renders as translations arrive. */
  L.watch = () => {
    L.churnCounts = { added: 0, removed: 0, attributes: 0, characterData: 0, records: 0, translationNodes: 0, containmentResets: 0 };
    L.churnObserver?.disconnect();
    L.churnObserver = new MutationObserver((records) => {
      const c = L.churnCounts;
      for (const record of records) {
        c.records++;
        if (record.type === "childList") {
          c.added += record.addedNodes.length; c.removed += record.removedNodes.length;
          for (const node of record.addedNodes) if (node.nodeType === 1 && (node.matches?.("[data-translation-of]") || node.querySelector?.("[data-translation-of]"))) c.translationNodes++;
        } else if (record.type === "attributes") { c.attributes++; if (record.attributeName === "data-mobile-rendering") c.containmentResets++; }
        else c.characterData++;
      }
    });
    L.churnObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    L.shifts = { count: 0, total: 0, max: 0 };
    L.shiftObserver?.disconnect();
    try {
      L.shiftObserver = new PerformanceObserver((list) => { for (const entry of list.getEntries()) { if (entry.hadRecentInput) continue; L.shifts.count++; L.shifts.total += entry.value; L.shifts.max = Math.max(L.shifts.max, entry.value); } });
      L.shiftObserver.observe({ type: "layout-shift", buffered: false });
    } catch {}
    L.watchedAt = performance.now();
  };
  L.churn = () => ({ sinceMs: Math.round(performance.now() - (L.watchedAt ?? 0)), ...L.churnCounts, layoutShifts: { ...L.shifts, total: Math.round(L.shifts.total * 1000) / 1000 }, translated: document.querySelectorAll("[data-translation-of]").length, longTasks: summarize(since(L.watchedAt ?? 0)) });
  /** Wait with no input: what the page does by itself. */
  L.idle = async (ms = 30000) => { const t0 = performance.now(); L.watch(); await sleep(ms); return { idleMs: ms, ...L.churn(), ...L.snapshot("idle") }; };
})();
