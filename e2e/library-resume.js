async (page) => {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const response = await page.request.get(`${origin}/api/books`);
  require(response.ok(), 'The fixture shelf must load');
  const books = await response.json();
  const book = books.find((item) => item.progress);
  require(book, 'Upload the fixture and save a reading position before this check');
  const before = JSON.stringify(book.progress);
  const writes = [];
  const aiRequests = [];
  const observe = (request) => {
    const path = request.url().split('?')[0].slice(origin.length);
    if (request.method() !== 'GET' && path.endsWith('/progress')) writes.push(path);
    if (path.startsWith('/api/ai/')) aiRequests.push(path);
  };
  page.on('request', observe);
  const dialog = page.getByRole('dialog', { name: 'Where I left off', exact: true });
  const contextButton = page.getByRole('button', { name: 'Where I left off', exact: true });
  const focusReturned = async () => require(await contextButton.evaluate((el) => el === document.activeElement), 'Focus must return to Where I left off');
  const open = async () => {
    await contextButton.click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('region', { name: 'Before your saved place', exact: true }).waitFor({ state: 'visible' });
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/`);
    await contextButton.waitFor({ state: 'visible' });
    await page.screenshot({ path: '.playwright-cli/library-resume-before.png' });
    await open();
    require((await dialog.locator('blockquote').first().innerText()).trim().length > 0, 'Context must show source text');
    await page.screenshot({ path: '.playwright-cli/library-resume-open.png' });
    await dialog.getByRole('button', { name: 'Close reading context', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await focusReturned();
    await open();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await focusReturned();

    const chapterPath = `/api/books/${book.id}/chapters/${book.progress.chapterId}`;
    let failedOnce = false;
    const failChapter = async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable', message: 'Fixture connection interrupted.' }) });
      } else await route.continue();
    };
    await page.route(`**${chapterPath}`, failChapter);
    await contextButton.click();
    await dialog.getByRole('alert').filter({ hasText: 'Fixture connection interrupted.' }).waitFor({ state: 'visible' });
    await page.screenshot({ path: '.playwright-cli/library-resume-error.png' });
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await dialog.getByRole('region', { name: 'Before your saved place', exact: true }).waitFor({ state: 'visible' });
    require(await dialog.getByRole('alert').count() === 0, 'Retry must clear the context error');
    await page.screenshot({ path: '.playwright-cli/library-resume-retried.png' });
    await page.unroute(`**${chapterPath}`, failChapter);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await open();
      const bounds = await dialog.boundingBox();
      require(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844, `Context must fit ${width}x844`);
      require(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Context must not overflow horizontally');
      await page.screenshot({ path: `.playwright-cli/library-resume-${width}.png` });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await focusReturned();
    }
    const afterResponse = await page.request.get(`${origin}/api/books`);
    const after = (await afterResponse.json()).find((item) => item.id === book.id);
    require(JSON.stringify(after.progress) === before, 'Opening or dismissing context must not change saved progress');
    require(writes.length === 0, `Context caused progress writes: ${writes.join(', ')}`);
    require(aiRequests.length === 0, `Context made AI requests: ${aiRequests.join(', ')}`);

    // A second book exists only in this browser's mocked metadata response, never in the fixture library.
    const second = { ...book, id: 'fixture-search-only', title: 'Fixture Shelf Title', author: 'Fixture Author', progress: null };
    const shelfFixture = async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...books, second]) });
    await page.route('**/api/books', shelfFixture);
    await page.reload();
    const search = page.getByRole('searchbox', { name: 'Find a book', exact: true });
    await search.waitFor({ state: 'visible' });
    const rows = page.locator('.shelf-item');
    require(await rows.count() === books.length + 1, 'The metadata fixture must add one shelf row');
    await search.fill('Fixture Author');
    await page.getByRole('status').filter({ hasText: '1 book found' }).waitFor({ state: 'visible' });
    require(await rows.count() === 1 && (await rows.first().innerText()).includes(second.title), 'Author filter must show only its matching book');
    await page.screenshot({ path: '.playwright-cli/library-search-author.png' });
    await search.fill('no fixture matches this');
    await page.getByRole('status').filter({ hasText: 'No books match' }).waitFor({ state: 'visible' });
    require(await rows.count() === 0, 'Unmatched metadata must hide shelf rows');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    require(await search.inputValue() === '' && await rows.count() === books.length + 1, 'Clear search must restore every row');
    await search.fill('Fixture Shelf Title');
    await page.getByRole('status').filter({ hasText: '1 book found' }).waitFor({ state: 'visible' });
    require(await rows.count() === 1, 'Title filter must show only its matching book');
    await page.getByRole('button', { name: 'Clear book search', exact: true }).click();
    require(await rows.count() === books.length + 1, 'The search-field clear button must restore the shelf');
    await page.screenshot({ path: '.playwright-cli/library-search-cleared.png' });
    await page.unroute('**/api/books', shelfFixture);
    await page.reload();
    await open();
    await dialog.getByRole('link', { name: 'Continue', exact: true }).click();
    await page.waitForURL(`**/book/${book.id}**`);
    await page.locator(`[data-block="${book.progress.blockId}"]`).waitFor({ state: 'visible' });
    await page.screenshot({ path: '.playwright-cli/library-resume-continued.png' });
    return 'Library resume passed: context source text, Close/Escape focus, no context progress writes or AI requests, mocked error retry, three viewport bounds, Continue; metadata-fixture author/title filter and both clear paths passed';
  } finally {
    page.off('request', observe);
    await page.unroute('**/api/books');
    await page.unroute(`**/api/books/${book.id}/chapters/${book.progress.chapterId}`);
  }
}
