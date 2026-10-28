async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // On a phone only the rows near the reader are on the page (the chunk window); a far block is reached by scrolling
  // its chunk's placeholder into view, which mounts its rows.
  const reach = async (blockId) => {
    await page.evaluate(async (id) => {
      if (document.getElementById(id)) return;
      const number = Number(id.match(/(\d+)$/)?.[1]);
      const prefix = id.replace(/\d+$/, '');
      const chunk = [...document.querySelectorAll('[data-chunk]')].filter(el => el.dataset.chunk.startsWith(prefix) && Number(el.dataset.chunk.slice(prefix.length)) <= number).at(-1);
      if (!chunk) throw new Error(`no chunk holds ${id}`);
      chunk.scrollIntoView({ block: 'start' });
      for (let tick = 0; tick < 100 && !document.getElementById(id); tick++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!document.getElementById(id)) throw new Error(`${id} did not mount`);
    }, blockId);
  };
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
  await page.locator('[data-block="c1-b0"]').waitFor();
  await reach('c1-b792');
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
  await reach('c2-b20');
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
  // A continuous scroll through the windowed chapters, with frame, layout, style and paint numbers reported.
  const measureScroll = async () => {
    await reach('c2-b2');
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
  const optimized = await measureScroll();
  const scrolling = { optimized };
  // Performance numbers are reported, not tied to machine-specific wall-clock thresholds.
  // The enforceable budget is how much text is on the page at all: far chunks are placeholders without rows.
  const rendering = await page.evaluate(() => {
    const chunks = [...document.querySelectorAll('.chapter-text > .text-chunk')];
    return { total: chunks.length, placeholders: chunks.filter(chunk => chunk.hasAttribute('data-placeholder')).length, rows: document.querySelectorAll('.chapter-text .row').length };
  });
  assert(rendering.total > 30 && rendering.placeholders > rendering.total / 2, `Most distant chunks must be placeholders: ${JSON.stringify(rendering)}`);
  assert(rendering.rows > 0 && rendering.rows <= 480, `Rows on the page must stay bounded: ${JSON.stringify(rendering)}`);
  // The source DOM near the reader is the real one, including selections spanning adjacent chunks.
  await reach('c2-b47');
  await page.locator('[data-block="c2-b47"]').evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 96, behavior: 'instant' }));
  await page.waitForTimeout(300);
  const selected = await page.evaluate(() => {
    const range = document.createRange();
    range.setStart(document.getElementById('c2-b47').firstChild, 0); range.setEnd(document.getElementById('c2-b48').firstChild, 20);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  });
  assert(selected.includes('Paragraph 47.') && selected.includes('Paragraph 48.'), 'Source selection must survive across chunks');
  // Width changes must discard old heights; returning to the same width restores the text the reader is at. Far chunks
  // are placeholders with estimated heights, so the whole chapter's height is not exact; the rows being read are.
  const anchorGeometry = () => page.locator('#c2-b48').evaluate(el => { const box = el.getBoundingClientRect(); return { top: box.top, height: box.height }; });
  const beforeResize = await anchorGeometry();
  await page.setViewportSize({ width: 320, height: 844 }); await page.waitForTimeout(400);
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  const afterResize = await anchorGeometry();
  assert(Math.abs(afterResize.top - beforeResize.top) < 3 && Math.abs(afterResize.height - beforeResize.height) < 1,
    `Resizing must restore the translated text being read: ${JSON.stringify(beforeResize)} -> ${JSON.stringify(afterResize)}`);
  // Keyboard focus pins its chunk: the row stays on the page however far the reader scrolls, and goes once focus leaves.
  await reach('c2-b20');
  await page.locator('[data-block="c2-b20"]').evaluate(el => el.focus({ preventScroll: true }));
  await reach('c2-b300');
  await page.waitForTimeout(500);
  assert(await page.evaluate(() => document.getElementById('c2-b20')?.closest('.text-chunk')?.hasAttribute('data-placeholder') === false), 'Keyboard focus must keep its chunk on the page');
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(600);
  assert(await page.evaluate(() => document.getElementById('c2-b20') === null), 'An unfocused chunk far from the reader must become a placeholder');
  await reach('c2-b20');
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
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    // Both layouts keep far chunks as placeholders, never inside the page's own measurement band (a page above, a page and 240px below).
    const windowed = await page.evaluate(() => {
      const placeholders = [...document.querySelectorAll('[data-placeholder]')];
      const inBand = placeholders.filter(el => { const box = el.getBoundingClientRect(); return box.bottom > -innerHeight && box.top < innerHeight + 240; }).length;
      return { placeholders: placeholders.length, inBand };
    });
    assert(windowed.placeholders > 10 && windowed.inBand === 0, `${layout} layout must keep far chunks as placeholders clear of the page band: ${JSON.stringify(windowed)}`);
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  const metrics = await page.evaluate(() => ({ tasks: window.translationLongTasks.length, maxTaskMs: Math.round(Math.max(0, ...window.translationLongTasks)) }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  return { result: 'TRANSLATION_MOBILE_PASSED', translations, metrics, scrolling, rendering };
}
