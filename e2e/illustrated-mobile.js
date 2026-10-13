async (page) => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('deepread.prefs', JSON.stringify({ translation: true, lang: 'bn', layout: 'scroll', chapterNotes: false })));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const images = await page.evaluate(() => Object.fromEntries([480, 960, 1440, 2000].map(width => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width * 0.75;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2c6990'; ctx.fillRect(0, 0, width, canvas.height);
    ctx.fillStyle = 'white'; ctx.font = `${width / 15}px serif`; ctx.fillText('Illustrated reading', width / 10, width / 3);
    return [width, canvas.toDataURL('image/png').split(',')[1]];
  })));
  // The CLI sandbox omits Buffer; response bodies still expose its native constructor.
  // route.fulfill requires Buffer's base64 encoding, which Uint8Array.toString lacks.
  const BinaryBuffer = (await (await page.request.get(`${origin}/`)).body()).constructor;
  const decode = value => BinaryBuffer.from(value, 'base64');
  const blocks = [];
  for (let at = 0; at < 600; at++) {
    blocks.push({ id: `b${at}`, type: 'paragraph', page: 1, text: `Paragraph ${at}. This illustrated chapter keeps the original words selectable while large figures load. Reading should stay comfortable on a phone with translation enabled.` });
    if (at % 12 === 5) blocks.push({ id: `figure${at}`, type: 'image', page: 1, text: '', image: { src: `figures/${at.toString(16).padStart(64, '0')}.png`, width: 2000, height: 1500, alt: `Illustration ${at}` } });
  }
  const chapter = { id: 'c1', title: 'Illustrated chapter', startPage: 1, endPage: 1, blocks };
  const requests = []; const requestedFigures = []; let release; let waiting = true;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/books/illustrated-mobile/**', async route => {
    const url = { pathname: route.request().url().split('?')[0], width: route.request().url().match(/[?&]width=(\d+)/)?.[1] };
    if (url.pathname.includes('/figures/')) {
      requests.push(url.width || 'original');
      requestedFigures.push(url.pathname);
      if (waiting) await gate;
      return route.fulfill({ contentType: 'image/png', body: decode(images[url.width || 2000]) });
    }
    if (url.pathname.endsWith('/translation')) return route.fulfill({ json: { lang: 'bn', engine: 'microsoft', blocks: Object.fromEntries(blocks.filter(b => b.type !== 'image').map(b => [b.id, 'অনুবাদের সময় মূল লেখা এবং পড়ার অবস্থান ঠিক থাকবে।'])) } });
    if (url.pathname.endsWith('/chapters/c1')) return route.fulfill({ json: chapter });
    if (url.pathname.endsWith('/notes')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/progress')) return route.fulfill({ json: { ...route.request().postDataJSON(), percent: 20, chapterTitle: chapter.title, updatedAt: new Date().toISOString() } });
    return route.continue();
  });
  await page.route('**/api/books/illustrated-mobile', route => route.fulfill({ json: { id: 'illustrated-mobile', title: 'Illustrated mobile', author: null, pageCount: 1, chapterCount: 1, wordCount: 18000, chapters: [{ ...chapter, blocks: undefined, wordCount: 18000 }], warnings: [], hasCover: false, readingStatus: 'reading', addedAt: new Date().toISOString(), progress: null } }));
  // Image responses deliberately remain pending until their reserved geometry is measured.
  await page.goto(`${origin}/book/illustrated-mobile/c1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-translation-of="b0"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const image = page.locator('.book-figure img').first();
  await image.scrollIntoViewIfNeeded();
  const before = await image.evaluate(img => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, top: img.getBoundingClientRect().top, complete: img.complete }));
  assert(!before.complete && before.height > 100 && Math.abs(before.width / before.height - 4 / 3) < 0.01, 'Pending figures must reserve their full phone aspect ratio before decoding');
  waiting = false; release();
  await page.waitForFunction(() => {
    const img = document.querySelector('.book-figure img');
    return img?.complete && img.naturalWidth > 0;
  }, null, { timeout: 10000 });
  await image.evaluate(img => img.decode());
  const after = await image.evaluate(img => ({ height: img.getBoundingClientRect().height, top: img.getBoundingClientRect().top, src: img.currentSrc }));
  assert(Math.abs(before.height - after.height) < 1 && Math.abs(before.top - after.top) < 3, `Image decoding must not move the page: ${JSON.stringify({before, after})}`);
  assert(after.src.includes('width=480'), `Phone should request a downsampled image: ${after.src}`);
  assert(requests.length < 15 && !requests.includes('original'), `Opening must defer distant originals: ${JSON.stringify(requests)}`);
  assert(!requestedFigures.some(url => url.endsWith(blocks.filter(block => block.type === 'image').at(-1).image.src)), 'Opening must not fetch the final distant figure');
  const managed = await page.evaluate(() => {
    const chunks = [...document.querySelectorAll('.text-chunk')];
    return { all: chunks.length, contained: chunks.filter(c => c.hasAttribute('data-mobile-rendering')).length, skippedFigures: chunks.filter(c => c.querySelector('.book-figure') && !c.firstElementChild.checkVisibility({ contentVisibilityAuto: true })).length };
  });
  assert(managed.contained === managed.all && managed.skippedFigures > 40, `Figure-rich chapters must retain distant rendering skips: ${JSON.stringify(managed)}`);
  const anchor = page.locator('[data-block="b300"]');
  await anchor.evaluate(el => scrollBy({ top: el.getBoundingClientRect().top - 95, behavior: 'instant' }));
  await page.waitForTimeout(250);
  const selected = await anchor.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range);
    return getSelection().toString();
  });
  assert(selected === blocks.find(b => b.id === 'b300').text, 'Selection must preserve the complete canonical source text');
  await page.evaluate(() => getSelection().removeAllRanges());
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(100);
    await image.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Illustrated reading must fit phone width');
    assert(await image.evaluate(img => Math.abs(img.getBoundingClientRect().width / img.getBoundingClientRect().height - 4 / 3) < 0.01), 'Responsive figures must preserve source aspect ratio');
  }
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await page.locator('#reading-settings input[value="pages"]').check(); await page.keyboard.press('Escape');
  assert(await page.locator('[data-mobile-rendering]').count() === 0, 'Pages layout must release scroll containment');
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await page.locator('#reading-settings input[value="scroll"]').check(); await page.keyboard.press('Escape');
  assert(await page.locator('[data-mobile-rendering]').count() > 0, 'Scroll layout must restore containment');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.goto(`${origin}/book/illustrated-mobile/c1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-translation-of="b0"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const img = document.querySelector('.book-figure img');
    return img?.complete && img.naturalWidth > 0 && /[?&]width=(960|1440)(?:&|$)/.test(img.currentSrc);
  }, null, { timeout: 10000 });
  await image.evaluate(img => img.decode());
  const highDensity = await image.evaluate(img => ({ dpr: devicePixelRatio, src: img.currentSrc, ratio: img.getBoundingClientRect().width / img.getBoundingClientRect().height }));
  assert(highDensity.dpr === 2 && /[?&]width=(960|1440)(?:&|$)/.test(highDensity.src), `Dense phones should select an appropriately downsampled figure: ${JSON.stringify(highDensity)}`);
  assert(Math.abs(highDensity.ratio - 4 / 3) < 0.01 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Dense phone figures must preserve their ratio and fit the viewport');
  assert(!requests.includes('original'), `Phone DPR must never fetch an oversized original: ${JSON.stringify(requests)}`);
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return { status: 'ILLUSTRATED_MOBILE_PASSED', managed, highDensity, requestedWidths: [...new Set(requests)] };
}
