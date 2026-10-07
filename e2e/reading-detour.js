async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const bookId = 'the-problems-of-philosophy-8c4e7684';
  const origin = await page.evaluate(() => location.origin);
  const bookUrl = `${origin}/api/books/${bookId}`;
  const saved = { chapterId: 'c3', blockId: 'c3-b4', offset: 120 };
  const chapter = await (await page.request.get(`${bookUrl}/chapters/c3`)).json();
  const source = chapter.blocks.find(block => block.id === 'c3-b3');
  assert(source, 'Fixture needs the source paragraph in chapter one');
  const noteId = await page.evaluate(() => crypto.randomUUID());
  const note = { id: noteId, chapterId: 'c3', blockId: source.id, offset: 0, quote: source.text.slice(0, 52), lang: 'bn', mode: 'highlight', color: 'yellow' };
  const prepared = await page.request.put(`${bookUrl}/notes/${noteId}`, { data: { note, before: null } });
  assert(prepared.ok(), 'Fixture highlight could not be prepared');
  const progress = async () => (await (await page.request.get(bookUrl)).json()).progress;
  const resetPlace = async () => {
    const response = await page.request.put(`${bookUrl}/progress`, { data: saved });
    assert(response.ok(), 'Fixture saved place could not be prepared');
  };
  const startDetour = async () => {
    await page.getByRole('button', { name: 'Where I left off', exact: true }).click();
    await page.getByRole('link', { name: 'View highlight in book', exact: true }).click();
    await page.getByRole('region', { name: 'Source visit' }).waitFor();
    assert(page.url().endsWith(`/book/${bookId}/c3`), 'Source link must open the highlighted chapter');
  };

  for (const [layout, width] of [['scroll', 390], ['pages', 768]]) {
    await page.setViewportSize({ width, height: 844 });
    await resetPlace();
    await page.goto(origin);
    await page.evaluate(mode => {
      const prefs = JSON.parse(localStorage.getItem('deepread.prefs') || '{}');
      localStorage.setItem('deepread.prefs', JSON.stringify({ ...prefs, layout: mode }));
    }, layout);
    await page.reload();
    const before = await progress();
    assert(before.chapterId === saved.chapterId && before.blockId === saved.blockId && before.offset === saved.offset, 'Fixture must begin at the saved place');
    const progressWrites = [];
    const onRequest = request => {
      if (request.method() === 'PUT' && request.url().endsWith(`/${bookId}/progress`)) progressWrites.push(request.url());
    };
    page.on('request', onRequest);
    await startDetour();
    await page.waitForTimeout(1500);
    assert(progressWrites.length === 0, 'A source visit must not save the source as progress');
    assert((await progress()).blockId === saved.blockId, 'Server progress must remain at the saved block');

    await page.setViewportSize({ width: width === 390 ? 768 : 390, height: 844 });
    await page.getByRole('button', { name: 'Return to your place', exact: true }).click();
    await page.getByRole('region', { name: 'Source visit' }).waitFor({ state: 'hidden' });
    const restored = await page.evaluate(() => ({
      place: history.state?.place,
      activeBlock: document.activeElement?.getAttribute('data-block'),
      activeLine: (() => {
        const text = document.activeElement?.firstChild;
        if (!(text instanceof Text)) return null;
        const range = document.createRange();
        range.setStart(text, Math.min(120, text.length - 1));
        range.setEnd(text, Math.min(121, text.length));
        return range.getBoundingClientRect().toJSON();
      })(),
    }));
    assert(restored.place?.chapterId === saved.chapterId && restored.place?.blockId === saved.blockId && restored.place?.offset === saved.offset, 'Return must retain the exact logical place');
    assert(restored.activeBlock === saved.blockId, 'Return should focus the restored passage');
    assert(restored.activeLine?.y >= 0 && restored.activeLine.y < 844, 'Restored passage must be inside the viewport');
    await page.getByRole('link', { name: 'Back to your books' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Where I left off', exact: true }).waitFor();
    assert((await progress()).blockId === saved.blockId, 'Returning and leaving must not replace the saved passage');
    page.off('request', onRequest);
  }

  await resetPlace();
  await page.reload();
  await startDetour();
  await page.reload();
  await page.getByRole('region', { name: 'Source visit' }).waitFor();
  await page.getByRole('link', { name: 'Back to your books' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Where I left off', exact: true }).waitFor();
  assert((await progress()).blockId === saved.blockId, 'Reloading and leaving a source visit must preserve saved progress');
  await page.request.delete(`${bookUrl}/notes/${noteId}`);
  assert(pageErrors.length === 0, `Reader threw an error: ${pageErrors.join('; ')}`);
  return 'Source visit, exact return, resize, Scroll/Pages, reload and leave preserved progress';
}
