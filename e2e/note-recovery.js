async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const noteRoute = '**/api/books/*/notes/*';
  const bookId = await page.evaluate(() => location.pathname.split('/')[2]);
  const origin = await page.evaluate(() => location.origin);
  const existing = await (await page.request.get(`${origin}/api/books/${bookId}/notes`)).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(12, 12);
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await page.locator('#reading-settings input[value="pages"]').check();
  await page.keyboard.press('Escape');
  await page.route(noteRoute, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  const candidates = page.locator('.chapter-text [data-block]').filter({ hasText: /\S.{100}/ });
  let block;
  for (const candidate of await candidates.all()) {
    const text = await candidate.innerText();
    if (!existing.some(note => text.includes(note.quote))) { block = candidate; break; }
  }
  assert(block, 'Fixture needs an unhighlighted passage');
  await block.scrollIntoViewIfNeeded();
  const quote = await block.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode()) && text.textContent.length < 100) {}
    if (!text) throw new Error('Fixture needs a passage of at least 100 characters');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 100);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return range.toString();
  });
  await page.getByRole('button', { name: /^Highlight in / }).click();
  await page.getByRole('status', { name: 'Waiting for connection', exact: true }).waitFor();
  await page.mouse.move(195, 400);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.topbar-away'));
  const recovery = page.getByRole('status', { name: 'Waiting for connection', exact: true });
  const bounds = await recovery.boundingBox();
  assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 844 && bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Recovery must remain in the viewport when the Pages toolbar hides');
  assert((await recovery.innerText()).includes('Kept in this browser'), 'Offline save must explain browser-only durability');
  await page.unroute(noteRoute);
  await recovery.getByRole('button', { name: 'Retry save', exact: true }).click();
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor({ state: 'attached' });
  const response = await page.request.get(`${origin}/api/books/${bookId}/notes`);
  const notes = await response.json();
  assert(notes.some(note => note.quote === quote), 'Retry must save the highlighted passage on the server');
  const saved = notes.find(note => note.quote === quote);
  await page.request.delete(`${origin}/api/books/${bookId}/notes/${encodeURIComponent(saved.id)}`);
  await page.mouse.move(12, 12);
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await page.locator('#reading-settings input[value="scroll"]').check();
  await page.keyboard.press('Escape');
  return 'Offline highlight, visible Pages recovery, explicit retry and server acknowledgement passed';
}
