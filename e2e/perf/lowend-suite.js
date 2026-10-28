// The whole low-end measurement for one book, run inside the page after lowend-probe.js (and the translation stub for
// the translation part). Call window.__lowendSuite(href, options) from the library page; it fills window.__lowend.suite
// as it goes, so a caller can poll partial results while it runs.
//   href: the book's shelf link, e.g. "/book/<id>"
//   options.chapters: chapters to read per mode (default 10); options.screens: screens instead, for giant chapters
//   options.translation: also measure with translation on (default true)
window.__lowendSuite = async (href, { chapters = 10, screens = 0, translation = true, pagesChapters = chapters, pagesTurns = 600 } = {}) => {
  const L = window.__lowend;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const suite = (L.suite = { href, startedAt: new Date().toISOString(), steps: {} });
  const step = async (name, run) => {
    try { suite.steps[name] = await run(); } catch (error) { suite.steps[name] = { error: String(error) }; }
    suite.last = name;
  };
  const link = () => document.querySelector(`a[href="${href}"]`);
  const backToShelf = async () => {
    document.querySelector('a[aria-label="Back to your books"]').click();
    const t0 = performance.now();
    while (!link() && performance.now() - t0 < 60000) await raf();
    await sleep(1500);
  };
  const firstChapter = () => {
    const links = [...document.querySelectorAll("dialog.toc .toc-link")];
    return links[0]?.getAttribute("href").split("/").pop();
  };
  // Scroll mode.
  L.reset();
  await step("scrollOpen", () => L.open(link()));
  await step("scrollIdle", () => L.idle(10000));
  L.reset();
  await step("scrollRead", () => L.scroll({ chapters: screens ? 0 : chapters, screens, step: 240, sampleAt: [1, 2, 3, 5, 10, 20] }));
  await step("scrollTap", () => L.tapWord());
  await step("scrollSelect", () => L.selectText());
  await step("scrollToPages", () => L.switchLayout("pages"));
  await step("pagesToScroll", () => L.switchLayout("scroll"));
  await step("scrollJump", () => L.jump(2));
  // Pages mode: open from the shelf with the layout already on pages, like a reader who reads that way.
  await step("pagesPrepare", async () => {
    document.querySelector('button[aria-label="Chapters"]').click();
    const t0 = performance.now();
    while (!document.querySelector("dialog.toc .toc-link") && performance.now() - t0 < 30000) await raf();
    const first = firstChapter();
    document.querySelector("dialog.toc .toc-link").click();
    while (!document.querySelector(`[data-chapter="${CSS.escape(first)}"] [data-block]`) && performance.now() - t0 < 90000) await raf();
    await sleep(1000);
    const switched = await L.switchLayout("pages");
    await backToShelf();
    return { first, layout: switched.layout };
  });
  L.reset();
  await step("pagesOpen", () => L.open(link()));
  L.reset();
  await step("pagesRead", () => L.turnPages({ chapters: pagesChapters, maxTurns: pagesTurns, sampleAt: [1, 2, 3, 5, 10, 20] }));
  await step("pagesTap", () => L.tapWord());
  await step("pagesSelect", () => L.selectText());
  await step("pagesJump", () => L.jump(2));
  await step("pagesToScrollEnd", () => L.switchLayout("scroll"));
  if (translation) {
    // Translation, scroll mode, from the first chapter: the arrival of the first chapter, then reading on with it on.
    await step("translationArrival", async () => {
      document.querySelector('button[aria-label="Chapters"]').click();
      const t0 = performance.now();
      while (!document.querySelector("dialog.toc .toc-link") && performance.now() - t0 < 30000) await raf();
      const first = firstChapter();
      document.querySelector("dialog.toc .toc-link").click();
      while (!document.querySelector(`[data-chapter="${CSS.escape(first)}"] [data-block]`) && performance.now() - t0 < 90000) await raf();
      await sleep(1500);
      L.translationRequests = [];
      L.reset();
      L.watch();
      const t1 = performance.now();
      const toggled = await L.setTranslation(true);
      while (!document.querySelector("[data-translation-of]") && performance.now() - t1 < 120000) await raf();
      const arrivedMs = Math.round(performance.now() - t1);
      await raf(); await raf();
      const paintedMs = Math.round(performance.now() - t1);
      await sleep(3000);
      return { toggled: toggled.pressed, arrivedMs, paintedMs, requests: L.translationRequests.slice(), ...L.churn(), ...L.snapshot("translated") };
    });
    L.reset();
    await step("translationRead", async () => {
      L.watch();
      const scroll = await L.scroll({ chapters: screens ? 0 : Math.min(5, chapters), screens: screens ? Math.round(screens / 2) : 0, step: 240, sampleAt: [1, 2, 3, 5] });
      return { ...scroll, churn: L.churn(), requests: L.translationRequests.slice() };
    });
    await step("translationPages", async () => {
      const switched = await L.switchLayout("pages");
      L.reset();
      L.watch();
      const turns = await L.turnPages({ chapters: 3, maxTurns: 120, sampleAt: [1, 2, 3] });
      const back = await L.switchLayout("scroll");
      return { switchedMs: switched.switchedMs, switchLongTasks: switched.longTasks, turns, churn: L.churn(), requests: L.translationRequests.slice(), backMs: back.switchedMs };
    });
    await step("translationOff", () => L.setTranslation(false));
  }
  suite.finishedAt = new Date().toISOString();
  suite.done = true;
  return suite;
};
