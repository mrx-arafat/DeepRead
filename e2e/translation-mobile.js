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
    blocks: Array.from({ length: 240 }, (_, at) => ({ id: `${id}-b${at}`, type: 'paragraph', page: n + 1,
      text: `Paragraph ${at}. Reading should remain responsive while the chapter is translated. The source words retain their original position and can still be selected for notes.` })),
  }));
  const summary = chapters.map(ch => ({ id: ch.id, title: ch.title, startPage: ch.startPage, endPage: ch.endPage, wordCount: 7000 }));
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
  await page.route('**/api/books/mobile-smooth', route => fulfill(route, { id: 'mobile-smooth', title: 'Mobile translation', author: null, pageCount: 3, chapterCount: 3, wordCount: 21000, chapters: summary, warnings: [], hasCover: false, readingStatus: 'reading', addedAt: new Date().toISOString(), progress: null }));
  await page.goto(`${origin}/book/mobile-smooth/c1`);
  await page.locator('[data-block="c1-b234"]').waitFor();
  await page.locator('[data-block="c1-b234"]').evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 96, behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('[data-chapter="c2"]'));
  await page.waitForTimeout(200);
  assert(translations.includes('c1'), 'Current chapter must translate immediately');
  assert(!translations.includes('c2'), 'Offscreen prefetched chapter must not translate on book open');
  const before = await page.locator('[data-block="c1-b234"]').evaluate(el => el.getBoundingClientRect().top);
  pending.get('c1')();
  await page.locator('[data-translation-of="c1-b234"]').waitFor();
  const after = await page.locator('[data-block="c1-b234"]').evaluate(el => el.getBoundingClientRect().top);
  assert(Math.abs(after - before) < 3, 'Translation arrival must preserve reading position');
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
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  const metrics = await page.evaluate(() => ({ tasks: window.translationLongTasks.length, maxTaskMs: Math.round(Math.max(0, ...window.translationLongTasks)) }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  return { result: 'TRANSLATION_MOBILE_PASSED', translations, metrics };
}
