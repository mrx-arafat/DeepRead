async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('deepread.prefs', JSON.stringify({ translation: true, lang: 'bn', layout: 'scroll', chapterNotes: false }));
    window.translationLongTasks = [];
    new PerformanceObserver(list => window.translationLongTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const chapters = ['c1', 'c2', 'c3'].map((id, n) => ({
    id, title: `Section ${n + 1}`, startPage: n + 1, endPage: n + 1,
    blocks: Array.from({ length: 800 }, (_, at) => ({ id: `${id}-b${at}`, type: 'paragraph', page: n + 1,
      text: `Paragraph ${at}. Reading should remain responsive while the chapter is translated. The source words retain their original position and can still be selected for notes.` })),
  }));
  const summary = chapters.map(ch => ({ id: ch.id, title: ch.title, startPage: ch.startPage, endPage: ch.endPage, wordCount: 24000 }));
  const translations = [];
  const pending = new Map();
  const fulfill = (route, value) => route.fulfill({ json: value });
  await page.route('**/api/books/mobile-smooth/**', async route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const match = path.match(/\/chapters\/(c\d)(\/translation)?$/);
    if (match) {
      const chapter = chapters.find(ch => ch.id === match[1]);
      if (!match[2]) return fulfill(route, chapter);
      translations.push(chapter.id);
      let release; const wait = new Promise(resolve => { release = resolve; }); pending.set(chapter.id, release); await wait;
      return fulfill(route, { lang: 'bn', engine: 'microsoft', blocks: Object.fromEntries(chapter.blocks.map(block => [block.id, `অনুচ্ছেদ ${block.id}। বই পড়ার সময় অনুবাদ চালু থাকলেও লেখা নির্বাচন ও পড়ার অবস্থান ঠিক থাকবে।`])) });
    }
    if (path.endsWith('/notes')) return fulfill(route, []);
    if (path.endsWith('/progress')) { const data = route.request().postDataJSON(); return fulfill(route, { ...data, percent: 40, chapterTitle: 'Section 2', updatedAt: new Date().toISOString() }); }
    return route.continue();
  });
  await page.route('**/api/books/mobile-smooth', route => fulfill(route, { id: 'mobile-smooth', title: 'Mobile translation', author: null, pageCount: 3, chapterCount: 3, wordCount: 72000, chapters: summary, warnings: [], hasCover: false, readingStatus: 'reading', addedAt: new Date().toISOString(), progress: null }));
  await page.goto(`${origin}/book/mobile-smooth/c1`);
  await page.locator('[data-block="c1-b792"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-block="c1-b792"]').evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 96, behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('[data-chapter="c2"]'));
  await page.waitForTimeout(200);
  assert(translations.includes('c1'), 'Current chapter must translate immediately');
  assert(!translations.includes('c2'), 'Offscreen prefetched chapter must not translate on book open');
  const before = await page.locator('[data-block="c1-b792"]').evaluate(el => el.getBoundingClientRect().top);
  pending.get('c1')();
  await page.locator('[data-translation-of="c1-b792"]').waitFor();
  const after = await page.locator('[data-block="c1-b792"]').evaluate(el => el.getBoundingClientRect().top);
  assert(Math.abs(after - before) < 3, `Translation arrival must preserve reading position: ${before} -> ${after}`);
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await page.locator('#reading-settings').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('[data-block="c2-b20"]').evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 96, behavior: 'instant' }));
  for (let attempt = 0; attempt < 30 && !pending.has('c2'); attempt++) await page.waitForTimeout(50);
  assert(pending.has('c2'), 'Entering a prefetched chapter must start its translation');
  pending.get('c2')();
  await page.locator('[data-translation-of="c2-b20"]').waitFor();
  const anchor = page.locator('[data-block="c2-b20"]');
  // Integer scroll rounding must leave the source row just inside the eye line.
  await anchor.evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 95, behavior: 'instant' }));
  const toggleTop = await anchor.evaluate(el => el.getBoundingClientRect().top);
  const requestCount = translations.length;
  for (const enabled of [false, true]) {
    await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
    await page.locator('#reading-settings-translation').click();
    await page.keyboard.press('Escape');
    if (enabled) await page.locator('[data-translation-of="c2-b20"]').waitFor();
    else await page.locator('[data-translation-of="c2-b20"]').waitFor({ state: 'detached' });
    const toggledTop = await anchor.evaluate(el => el.getBoundingClientRect().top);
    assert(Math.abs(toggledTop - toggleTop) < 3, `Translation toggle must preserve reading position: ${JSON.stringify({ enabled, toggleTop, toggledTop })}`);
  }
  assert(translations.length === requestCount, 'Switching translation back on must reuse fetched answers');
  // Compare identical continuous scrolls in this browser with and without retained-row rendering.
  const measureScroll = async () => {
    await page.locator('[data-block="c2-b2"]').evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 96, behavior: 'instant' }));
    await page.waitForTimeout(500);
    const trace = [];
    const collect = event => trace.push(...event.value);
    cdp.on('Tracing.dataCollected', collect);
    await cdp.send('Tracing.start', { categories: 'devtools.timeline', options: 'record-as-much-as-possible' });
    const beforeScroll = await cdp.send('Performance.getMetrics');
    const result = await page.evaluate(async () => {
      const intervals = [];
      let previous = performance.now();
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(); intervals.push(now - previous); previous = now;
        scrollBy({ top: 160, behavior: 'instant' });
      }
      intervals.sort((a, b) => a - b);
      return { p95FrameMs: Math.round(intervals[Math.floor(intervals.length * 0.95)]), maxFrameMs: Math.round(intervals.at(-1)) };
    });
    const afterScroll = await cdp.send('Performance.getMetrics');
    const completed = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end'); await completed;
    cdp.off('Tracing.dataCollected', collect);
    result.paintMs = Math.round(trace.filter(event => event.ph === 'X' && event.name === 'Paint').reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000);
    const metric = (metrics, name) => metrics.metrics.find(entry => entry.name === name)?.value ?? 0;
    result.layoutMs = Math.round((metric(afterScroll, 'LayoutDuration') - metric(beforeScroll, 'LayoutDuration')) * 1000);
    result.styleMs = Math.round((metric(afterScroll, 'RecalcStyleDuration') - metric(beforeScroll, 'RecalcStyleDuration')) * 1000);
    return result;
  };
  await cdp.send('Performance.enable');
  const renderingOverride = await page.addStyleTag({ content: '.chapter-text > .text-chunk { content-visibility: visible !important; }' });
  const baseline = await measureScroll();
  await renderingOverride.evaluate(el => el.remove());
  const optimized = await measureScroll();
  const scrolling = { baseline, optimized };
  // Performance numbers are reported, not tied to machine-specific wall-clock thresholds.
  // The enforceable budget is how much distant text the browser still has to render.
  const rendering = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chapter-text > .text-chunk')];
    return { total: rows.length, managed: rows.filter(row => getComputedStyle(row).contentVisibility === 'auto').length,
      skipped: rows.filter(row => row.firstElementChild && !row.firstElementChild.checkVisibility({ contentVisibilityAuto: true })).length };
  });
  assert(rendering.managed > 10 && rendering.managed < 50, `Long translated chapters must use a bounded number of rendering chunks: ${JSON.stringify(rendering)}`);
  assert(rendering.skipped > rendering.total / 2, `Most distant chunks must skip rendering: ${JSON.stringify(rendering)}`);
  // The native source DOM remains available, including selections spanning adjacent paragraphs.
  const selected = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('[data-chapter="c2"] [data-block]')];
    const range = document.createRange();
    range.setStart(blocks[47].firstChild, 0); range.setEnd(blocks[48].firstChild, 20);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  });
  assert(selected.includes('Paragraph 47.') && selected.includes('Paragraph 48.'), 'Source selection must survive across managed chunks');
  // Width changes must discard old intrinsic heights; returning to the same width restores the same geometry.
  const heightBeforeResize = await page.locator('[data-chapter="c2"]').evaluate(el => el.getBoundingClientRect().height);
  await page.setViewportSize({ width: 320, height: 844 }); await page.waitForTimeout(400);
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  const heightAfterResize = await page.locator('[data-chapter="c2"]').evaluate(el => el.getBoundingClientRect().height);
  assert(Math.abs(heightAfterResize - heightBeforeResize) < 3, `Resizing must restore exact translated chapter height: ${heightBeforeResize} -> ${heightAfterResize}`);
  const focusedRow = await page.locator('[data-block="c2-b20"]').evaluate(el => {
    el.focus({ preventScroll: true });
    const visibility = getComputedStyle(el.closest('.text-chunk')).contentVisibility;
    el.blur(); return visibility;
  });
  assert(focusedRow === 'visible', 'Keyboard focus must release containment so its outline and hint are not clipped');
  const character = () => page.locator('[data-block="c2-b20"]').evaluate(el => {
    const range = document.createRange(); range.setStart(el.firstChild, 90); range.setEnd(el.firstChild, 91);
    return range.getBoundingClientRect().top;
  });
  const characterTop = await character();
  await page.evaluate(top => scrollBy({ top: top - 96, behavior: 'instant' }), characterTop);
  const beforeSize = await character();
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await page.locator('#reading-settings').getByRole('button', { name: 'Larger text' }).click();
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  assert(Math.abs((await character()) - beforeSize) < 3, 'Translated text size changes must preserve the logical source line');
  for (const layout of ['pages', 'scroll']) {
    await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
    await page.locator(`#reading-settings input[value="${layout}"]`).check();
    await page.keyboard.press('Escape'); await page.waitForTimeout(350);
    const contained = await page.evaluate(() => document.querySelectorAll('[data-mobile-rendering]').length);
    assert(layout === 'pages' ? contained === 0 : contained > 10 && contained < 50, `${layout} layout must use the appropriate rendering strategy`);
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  const metrics = await page.evaluate(() => ({ tasks: window.translationLongTasks.length, maxTaskMs: Math.round(Math.max(0, ...window.translationLongTasks)) }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  return { result: 'TRANSLATION_MOBILE_PASSED', translations, metrics, scrolling, rendering };
}
