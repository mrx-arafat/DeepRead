async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(books.length === 1, 'Use an isolated library with only the Gutenberg fixture');
  const book = books[0];
  const bookUrl = `${origin}/api/books/${book.id}`;
  const notesUrl = `${bookUrl}/notes`;
  const notes = async () => (await (await page.request.get(notesUrl)).json());
  const progress = async () => (await (await page.request.get(bookUrl)).json()).progress;
  assert((await notes()).length === 0, 'Start with no fixture notes');

  const savedPlace = { chapterId: 'c3', blockId: 'c3-b3', offset: 120 };
  assert((await page.request.put(`${bookUrl}/progress`, { data: savedPlace })).ok(), 'Could not set the reading place');
  await page.goto(`${origin}/book/${book.id}/c3`);
  await page.getByRole('button', { name: 'Notebook' }).waitFor();

  const sourceBlock = page.locator('[data-block="c3-b4"]');
  await sourceBlock.scrollIntoViewIfNeeded();
  const quote = await sourceBlock.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = [...Array.from({ length: 20 }, () => walker.nextNode())].find(item => item?.textContent?.length >= 60);
    if (!node) throw new Error('Fixture needs a 60-character text node in c3-b4');
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 60);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return range.toString();
  });
  await page.getByRole('toolbar', { name: 'Explain, highlight, or reflect on selected text' }).getByRole('button', { name: 'Reflect' }).click();
  const notebook = page.getByRole('dialog', { name: 'Notebook' });
  await notebook.getByRole('textbox', { name: 'Your reflection' }).fill('A thought attached to this passage.');
  await notebook.getByRole('button', { name: 'Save reflection' }).click();
  await notebook.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  const reflection = (await notes()).find(note => note.mode === 'reflection' && note.quote === quote);
  assert(reflection?.blockId === 'c3-b4', 'Reflection did not save on its selected source');

  try {
    const chapter = await (await page.request.get(`${bookUrl}/chapters/c3`)).json();
    const block = chapter.blocks.find(item => item.id === reflection.blockId);
    assert(block && block.text.slice(reflection.offset, reflection.offset + quote.length) === quote, 'Saved reflection needs a valid source before corruption');
    const staleOffset = block.text.length + 1;
    const changed = await page.request.put(`${notesUrl}/${encodeURIComponent(reflection.id)}`, {
      data: { note: { ...reflection, offset: staleOffset }, before: null },
    });
    assert(changed.status() === 204, `Could not persist stale source offset: ${changed.status()}`);
    assert((await notes()).find(note => note.id === reflection.id)?.offset === staleOffset, 'Stale offset did not reach storage');

    await page.reload();
    await page.getByRole('button', { name: 'Notebook' }).click();
    await notebook.getByText('A thought attached to this passage.').waitFor();
    const before = { url: page.url(), progress: await progress(), scrollY: await page.evaluate(() => window.scrollY) };
    await notebook.getByRole('button', { name: 'Open passage' }).click();
    await notebook.getByRole('alert').getByText('This passage is no longer available in the book.').waitFor();
    assert(await notebook.isVisible(), 'Missing source should leave the Notebook open');
    assert(await page.getByRole('region', { name: 'Source visit' }).count() === 0, 'Missing source must not start a source visit');
    assert(page.url() === before.url, 'Missing source must not navigate to another passage');
    assert(await page.evaluate(() => window.scrollY) === before.scrollY, 'Missing source must not scroll to another passage');
    assert(JSON.stringify(await progress()) === JSON.stringify(before.progress), 'Missing source must not change saved reading progress');
    assert(errors.length === 0, `Reader page errors: ${errors.join('; ')}`);
    return { result: 'Stale Notebook source reports unavailable without navigation or progress change', staleOffset };
  } finally {
    await page.request.delete(`${notesUrl}/${encodeURIComponent(reflection.id)}`);
  }
}
