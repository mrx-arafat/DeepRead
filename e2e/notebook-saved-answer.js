async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(books.length === 1, 'Use a fresh isolated library with the Gutenberg fixture');
  const book = books[0];
  const notesUrl = `${origin}/api/books/${book.id}/notes`;
  const notes = async () => (await (await page.request.get(notesUrl)).json());
  assert((await notes()).length === 0, 'Start with no fixture notes');
  const answerText = 'The passage asks whether certainty survives careful examination.';
  const aiCalls = [];
  await page.route('**/api/ai/explain', route => {
    aiCalls.push(route.request().postData());
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body: `event: delta\ndata: ${JSON.stringify({ text: answerText })}\n\nevent: done\ndata: {}\n\n`,
    });
  });
  await page.goto(`${origin}/book/${book.id}/c3`);
  const block = page.locator('[data-block="c3-b2"]');
  await block.scrollIntoViewIfNeeded();
  const quote = await block.evaluate(element => {
    const text = [...element.childNodes].find(node => node instanceof Text && node.textContent.length >= 80);
    if (!text) throw new Error('Fixture needs a plain passage in c3-b2');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 80);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return range.toString().trim();
  });
  await page.getByRole('toolbar', { name: 'Explain, highlight, or reflect on selected text' }).getByRole('button', { name: 'Explain', exact: true }).click();
  const card = page.locator('.note').filter({ hasText: quote });
  await card.getByText(answerText).waitFor();
  await card.getByRole('button', { name: 'Save to notebook' }).click();
  await card.getByText('Saved to notebook').waitFor();
  await page.getByRole('banner').getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  const saved = (await notes()).filter(note => note.savedAnswer === answerText);
  assert(saved.length === 1 && saved[0].quote === quote && saved[0].mode === 'simple', 'Save to notebook must persist the completed AI answer');
  const noteId = saved[0].id;
  assert(aiCalls.length === 1, 'Creating the explanation should make exactly one AI request');

  await page.unroute('**/api/ai/explain');
  const offlineCalls = [];
  await page.route('**/api/ai/explain', route => {
    offlineCalls.push(route.request().postData());
    return route.fulfill({ status: 503, body: 'provider unavailable' });
  });
  await page.reload();
  const restored = page.locator(`.note[data-note="${noteId}"]`);
  await restored.getByText(answerText).waitFor();
  await restored.getByText('Saved to notebook').waitFor();
  assert(await restored.getByRole('button', { name: 'Try again' }).count() === 0, 'Saved snapshot must not fall back to provider error');
  assert(offlineCalls.length === 0, 'Reloading a saved answer must not call AI');

  await page.getByRole('button', { name: 'Notebook' }).click();
  const notebook = page.getByRole('dialog', { name: 'Notebook' });
  await notebook.getByText(answerText).waitFor();
  await notebook.getByText('Explanation', { exact: true }).waitFor();
  await notebook.getByRole('region', { name: 'Notebook entries' }).getByRole('button', { name: /Explanation/ }).click();
  const noteView = notebook.getByRole('region', { name: 'Selected note' });
  await noteView.getByText(answerText).waitFor();
  assert(!(await noteView.textContent()).includes('**'), 'The open answer must be formatted, not show Markdown marks');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    notebook.getByRole('button', { name: /^Export / }).click(),
  ]);
  assert(download.suggestedFilename().endsWith('-notebook.md'), 'Notebook export must be Markdown');
  await download.saveAs('.playwright-cli/notebook-saved-answer-export.md');
  assert(offlineCalls.length === 0, 'Notebook and export must use the saved answer without AI');
  assert(errors.length === 0, `Reader page errors: ${errors.join('; ')}`);
  assert((await page.request.delete(`${notesUrl}/${encodeURIComponent(noteId)}`)).ok(), 'Could not clean up isolated fixture note');
  return { result: 'Completed SSE answer saved, restored in NoteCard and Notebook, exported with provider unavailable and zero new AI fetches', noteId, answerText };
}
