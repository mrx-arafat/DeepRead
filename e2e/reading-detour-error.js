async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const bookId = 'the-problems-of-philosophy-8c4e7684';
  const origin = await page.evaluate(() => location.origin);
  const bookUrl = `${origin}/api/books/${bookId}`;
  const returnTo = { chapterId: 'c4', blockId: 'c4-b2', offset: 100 };
  const prepared = await page.request.put(`${bookUrl}/progress`, { data: returnTo });
  assert(prepared.ok(), 'Fixture saved place could not be prepared');
  await page.goto(`${origin}/book/${bookId}/c3`);
  await page.evaluate(id => history.replaceState({
    place: { chapterId: 'c3', blockId: 'c3-b3', offset: 0 },
    readingDetour: { bookId: id, returnTo: { chapterId: 'c4', blockId: 'c4-b2', offset: 100 } },
  }, ''), bookId);
  await page.reload();
  await page.locator('[data-block=c3-b3]').waitFor({ state: 'visible' });
  const route = `**/api/books/${bookId}/chapters/c4`;
  await page.route(route, request => request.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Chapter temporarily unavailable' } }) }));
  await page.getByRole('button', { name: 'Return to your place', exact: true }).click();
  await page.getByRole('button', { name: 'Back to passage', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to passage', exact: true }).click();
  await page.getByRole('region', { name: 'Source visit' }).waitFor();
  await page.locator('[data-block=c3-b3]').waitFor({ state: 'visible' });
  assert((await (await page.request.get(bookUrl)).json()).progress.blockId === returnTo.blockId, 'Failed return must preserve saved progress');
  await page.unroute(route);
  return 'Failed cross-chapter return can recover to source without changing saved progress';
}
