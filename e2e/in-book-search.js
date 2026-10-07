async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  const bookId = 'the-problems-of-philosophy-8c4e7684';
  const bookUrl = `${origin}/api/books/${bookId}`;
  const saved = { chapterId: 'c3', blockId: 'c3-b4', offset: 120 };
  const chapter = await (await page.request.get(`${bookUrl}/chapters/c7`)).json();
  const matches = chapter.blocks.flatMap(block => [...block.text.matchAll(/Bismarck/gi)].map(match => ({ blockId: block.id, offset: match.index })));
  assert(matches.length > 2, 'Fixture needs repeated terms in chapter five');
  const progress = async () => (await (await page.request.get(bookUrl)).json()).progress;

  for (const [layout, width] of [['scroll', 390], ['pages', 768]]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origin);
    const prepared = await page.request.put(`${bookUrl}/progress`, { data: saved });
    assert(prepared.ok(), 'Could not prepare fixture progress');
    await page.evaluate(mode => {
      const prefs = JSON.parse(localStorage.getItem('deepread.prefs') || '{}');
      localStorage.setItem('deepread.prefs', JSON.stringify({ ...prefs, layout: mode }));
    }, layout);
    await page.reload();
    await page.getByRole('link', { name: /Continue reading The Problems of Philosophy/ }).click();
    await page.getByRole('button', { name: 'Find in this book' }).click();
    const search = page.getByRole('searchbox', { name: 'Search text' });
    assert(await search.evaluate(element => element === document.activeElement), 'Search should focus its input');
    await search.fill('Bismarck');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('status').filter({ hasText: `${matches.length} matches` }).waitFor();
    const rows = page.locator('.book-search__result');
    assert(await rows.count() === matches.length, 'All repeated occurrences should be listed');
    await rows.nth(1).click();
    await page.getByRole('region', { name: 'Source visit' }).waitFor();
    await page.waitForFunction(offset => [...(CSS.highlights.get('dr-search') || [])].some(range => range.toString().toLowerCase() === 'bismarck' && range.startOffset === offset), matches[1].offset);
    const visited = await page.evaluate(() => ({
      place: history.state?.place,
      returnTo: history.state?.readingDetour?.returnTo,
      highlighted: [...(CSS.highlights.get('dr-search') || [])].map(range => ({ text: range.toString(), offset: range.startOffset })),
    }));
    assert(visited.place?.chapterId === 'c7' && visited.place?.blockId === matches[1].blockId, 'Selected repeated result should land in its own block');
    assert(visited.returnTo?.chapterId === saved.chapterId && visited.returnTo?.blockId === saved.blockId, 'Search should remember the previous reading place');
    assert(visited.highlighted.some(mark => mark.text.toLowerCase() === 'bismarck' && mark.offset === matches[1].offset), 'The selected occurrence should be marked in the text');
    await page.waitForTimeout(1500);
    assert((await progress()).blockId === saved.blockId, 'Searching must not overwrite saved progress');
    await page.getByRole('button', { name: 'Return to your place' }).click();
    await page.getByRole('region', { name: 'Source visit' }).waitFor({ state: 'hidden' });
    const returned = await page.evaluate(() => history.state?.place);
    assert(returned?.chapterId === visited.returnTo.chapterId && returned?.blockId === visited.returnTo.blockId && returned?.offset === visited.returnTo.offset, 'Return should restore the exact prior place');
    assert((await progress()).blockId === saved.blockId, 'Returning must preserve server progress');
  }
  await page.getByRole('button', { name: 'Find in this book' }).click();
  await page.getByRole('searchbox', { name: 'Search text' }).fill('zzunlikelyphrasezz');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('No passages found.').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await page.route('**/chapters/c3', route => route.fulfill({ status: 503, body: 'Search fixture unavailable' }));
  await page.getByRole('button', { name: 'Find in this book' }).click();
  await page.getByRole('searchbox', { name: 'Search text' }).fill('knowledge');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await page.unroute('**/chapters/c3');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('status').filter({ hasText: /matches/ }).waitFor();
  await page.getByRole('button', { name: 'Close search' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert(errors.length === 0, `Reader threw: ${errors.join('; ')}`);
  return 'In-book repeated-result search, exact highlight, Scroll/Pages return, saved-progress protection, empty/error/retry states passed';
}
