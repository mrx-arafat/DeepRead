async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(books.length === 1, 'Use an isolated library with one fixture book');
  const bookId = books[0].id;
  const readerUrl = `${origin}/book/${bookId}/c2`;
  const notesUrl = `${origin}/api/books/${bookId}/notes`;
  const noteRoute = `**/api/books/${bookId}/notes/*`;
  const tabA = page;
  const tabB = await page.context().newPage();
  const errors = [];
  for (const tab of [tabA, tabB]) {
    tab.on('pageerror', error => errors.push(error.message));
    await tab.route('**/api/ai/explain', route => route.fulfill({ status: 503, body: 'AI disabled in this test' }));
    await tab.route(noteRoute, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
    await tab.goto(readerUrl);
    await tab.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  }
  assert(await tabA.evaluate(() => !!navigator.locks), 'This browser must support Web Locks');

  const selectPassage = async (tab, index) => {
    const block = tab.locator('.chapter-text [data-block]').filter({ hasText: /\S.{100}/ }).nth(index);
    await block.scrollIntoViewIfNeeded();
    const quote = await block.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode()) && text.textContent.length < 100) {}
      if (!text) throw new Error('Fixture needs a passage of at least 100 characters');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 80);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      return range.toString();
    });
    await tab.getByRole('toolbar', { name: 'Explain or highlight selected text' }).waitFor();
    return quote;
  };

  const highlightQuote = await selectPassage(tabA, 0);
  await tabA.getByRole('button', { name: 'Highlight in yellow' }).click();
  await tabA.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  const noteQuote = await selectPassage(tabB, 1);
  await tabB.getByRole('button', { name: 'Explain', exact: true }).click();
  await tabB.locator('.note[aria-label^="Explanation:"]').waitFor();
  await tabB.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert(highlightQuote !== noteQuote, 'Tabs must make distinct changes');
  assert((await (await tabA.request.get(notesUrl)).json()).length === 0, 'Failed requests must leave the server unchanged');

  const pending = () => tabB.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith(`deepread.pendingNotes.single.${id}.operations.`) && !key.endsWith('.rejected') && !key.endsWith('.done')), bookId);
  assert((await pending()).length === 2, 'Both tabs must durably append their pending changes');
  await tabA.close();
  await tabB.reload();
  await tabB.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert((await pending()).length === 2, 'Reload and closing the other tab must retain both changes');
  await tabB.unroute(noteRoute);
  const successful = [];
  tabB.on('response', response => {
    if (response.url().startsWith(`${notesUrl}/`) && response.request().method() === 'PUT' && response.ok()) successful.push(response.url());
  });
  await tabB.getByRole('status', { name: 'Waiting for connection' }).getByRole('button', { name: 'Retry save' }).click();
  await tabB.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  const saved = await (await tabB.request.get(notesUrl)).json();
  const highlight = saved.filter(note => note.mode === 'highlight' && note.quote === highlightQuote);
  const explanation = saved.filter(note => note.mode === 'simple' && note.quote === noteQuote.trim());
  assert(highlight.length === 1 && explanation.length === 1, 'Retry must keep both distinct changes exactly once');
  assert(successful.length === 2 && new Set(successful).size === 2, 'Each pending operation must receive one successful PUT');
  assert((await pending()).length === 0, 'Acknowledged changes must leave the browser outbox');
  await tabB.reload();
  await tabB.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert((await (await tabB.request.get(notesUrl)).json()).length === 2, 'Reload must preserve both server notes');
  assert(successful.length === 2, 'Reload must not resend acknowledged changes');
  assert(errors.length === 0, `Reader page errors: ${errors.join('; ')}`);
  for (const note of saved) {
    const removed = await tabB.request.delete(`${notesUrl}/${encodeURIComponent(note.id)}`);
    assert(removed.ok(), 'Could not clean up fixture note');
  }
  await tabB.close();
  return 'Two tabs kept a highlight and explanation through failed saves, tab close, reload, and one successful retry per operation';
}
