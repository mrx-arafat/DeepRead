async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(books.length === 1, 'Use a fresh isolated library with the Gutenberg fixture');
  const book = books[0];
  const bookUrl = `${origin}/api/books/${book.id}`;
  const notesUrl = `${bookUrl}/notes`;
  const notes = async () => (await (await page.request.get(notesUrl)).json());
  assert((await notes()).length === 0, 'Start this journey with no fixture notes');
  const progress = async () => (await (await page.request.get(bookUrl)).json()).progress;
  const savedPlace = { chapterId: 'c3', blockId: 'c3-b3', offset: 120 };
  assert((await page.request.put(`${bookUrl}/progress`, { data: savedPlace })).ok(), 'Could not prepare saved reading place');
  await page.goto(`${origin}/book/${book.id}/c3`);
  await page.getByRole('button', { name: 'Notebook' }).waitFor();

  // Select the second occurrence in one paragraph, not a merely matching passage elsewhere.
  const sourceBlock = page.locator('[data-block="c3-b4"]');
  await sourceBlock.scrollIntoViewIfNeeded();
  const quote = await sourceBlock.evaluate(element => {
    const text = element.textContent;
    const first = text.indexOf('the table');
    const second = text.indexOf('the table', first + 1);
    if (second < 0) throw new Error('Fixture needs two occurrences of the table in c3-b4');
    const length = 60;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    let start = null;
    let end = null;
    let cursor = 0;
    while ((node = walker.nextNode())) {
      const next = cursor + node.textContent.length;
      if (!start && second >= cursor && second < next) start = { node, offset: second - cursor };
      if (!end && second + length > cursor && second + length <= next) end = { node, offset: second + length - cursor };
      cursor = next;
    }
    if (!start || !end) throw new Error('Could not map repeated occurrence to text nodes');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return range.toString();
  });
  assert(quote.startsWith('the table') && quote.length === 60, 'Selected the wrong repeated passage');
  await page.getByRole('toolbar', { name: 'Explain, highlight, or reflect on selected text' }).getByRole('button', { name: 'Reflect' }).click();
  const notebook = page.getByRole('dialog', { name: 'Notebook' });
  await notebook.waitFor();
  await notebook.getByRole('textbox', { name: 'Your reflection' }).fill('First thought about this precise table.');
  await notebook.getByRole('button', { name: 'Save reflection' }).click();
  await notebook.getByText('First thought about this precise table.').waitFor();
  await notebook.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  let reflections = (await notes()).filter(note => note.mode === 'reflection');
  assert(reflections.length === 1 && reflections[0].quote === quote && reflections[0].blockId === 'c3-b4', 'Reflection must persist on the selected block');
  const reflectionId = reflections[0].id;
  const reflectionOffset = reflections[0].offset;
  assert(reflectionOffset > 0, 'Reflection must keep the second occurrence offset');
  await notebook.getByRole('button', { name: 'Close notebook' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Notebook' }).click();
  await notebook.getByText('First thought about this precise table.').waitFor();

  await notebook.getByRole('searchbox', { name: 'Search notebook' }).fill('no matching notebook entry');
  await notebook.getByText('No entries match these filters.').waitFor();
  await notebook.getByRole('searchbox', { name: 'Search notebook' }).fill('precise table');
  await notebook.getByText('1 entry').waitFor();
  await notebook.getByRole('combobox', { name: 'Filter by chapter' }).selectOption('c4');
  await notebook.getByText('No entries match these filters.').waitFor();
  await notebook.getByRole('combobox', { name: 'Filter by chapter' }).selectOption('c3');
  await notebook.getByText('1 entry').waitFor();
  await notebook.getByRole('button', { name: 'Edit' }).click();
  await notebook.getByRole('textbox', { name: 'Your reflection' }).fill('Revised thought about the same occurrence.');
  const noteRoute = `**/api/books/${book.id}/notes/*`;
  await page.route(noteRoute, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await notebook.getByRole('button', { name: 'Save changes' }).click();
  await notebook.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert((await notes()).find(note => note.id === reflectionId)?.text === 'First thought about this precise table.', 'Failed edit must not change the server copy');
  await notebook.getByRole('searchbox', { name: 'Search notebook' }).fill('');
  await notebook.getByText('Revised thought about the same occurrence.').waitFor();
  await page.unroute(noteRoute);
  await notebook.getByRole('status', { name: 'Waiting for connection' }).getByRole('button', { name: 'Retry save' }).click();
  await notebook.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  reflections = (await notes()).filter(note => note.mode === 'reflection');
  assert(reflections.length === 1 && reflections[0].id === reflectionId && reflections[0].offset === reflectionOffset && reflections[0].text === 'Revised thought about the same occurrence.', 'Editing must preserve identity and source while changing the text');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    notebook.getByRole('button', { name: 'Export selected' }).click(),
  ]);
  assert(download.suggestedFilename().endsWith('-notebook.md'), 'Export should download Markdown');
  await download.saveAs('.playwright-cli/notebook-export.md');

  const beforeVisit = await progress();
  await notebook.getByRole('button', { name: 'Open passage' }).click();
  await page.getByRole('region', { name: 'Source visit' }).waitFor();
  assert(await notebook.isHidden(), 'Open passage should dismiss the notebook');
  assert((await progress()).blockId === beforeVisit.blockId && (await progress()).offset === beforeVisit.offset, 'Visiting the source must not overwrite reading progress');
  const source = await page.evaluate(() => ({
    block: document.activeElement?.getAttribute('data-block'),
    highlight: (() => {
      const range = CSS.highlights?.get('dr-search')?.values().next().value;
      if (!(range instanceof Range)) return null;
      const block = range.startContainer.parentElement?.closest('[data-block]');
      if (!block) return null;
      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      return { blockId: block.getAttribute('data-block'), offset: before.toString().length, text: range.toString() };
    })(),
  }));
  assert(source.highlight?.blockId === 'c3-b4' && source.highlight.offset === reflectionOffset && source.highlight.text === quote, 'Open passage must mark the saved second occurrence exactly');
  await page.getByRole('button', { name: 'Return to your place' }).click();
  await page.getByRole('region', { name: 'Source visit' }).waitFor({ state: 'hidden' });
  assert(JSON.stringify(await progress()) === JSON.stringify(beforeVisit), 'Return must preserve the reading progress from before the source visit');

  await page.getByRole('button', { name: 'Notebook' }).click();
  await notebook.getByRole('button', { name: 'Remove reflection' }).click();
  await notebook.getByText('Entry removed.').waitFor();
  await notebook.getByRole('button', { name: 'Undo' }).click();
  await notebook.getByText('Revised thought about the same occurrence.').waitFor();
  await notebook.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert((await notes()).filter(note => note.id === reflectionId).length === 1, 'Undo must restore the saved reflection');

  await notebook.getByRole('button', { name: 'Close notebook' }).click();
  const highlightBlock = page.locator('[data-block="c3-b5"]');
  await highlightBlock.scrollIntoViewIfNeeded();
  const highlightQuote = await highlightBlock.evaluate(element => {
    const text = [...element.childNodes].find(node => node instanceof Text && node.textContent.length >= 70);
    if (!text) throw new Error('Fixture needs a plain 70-character passage in c3-b5');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 70);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return range.toString();
  });
  await page.getByRole('toolbar', { name: 'Explain, highlight, or reflect on selected text' }).getByRole('button', { name: 'Highlight in yellow' }).click();
  await page.getByRole('banner').getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Notebook' }).click();
  await notebook.getByText('Revised thought about the same occurrence.').waitFor();
  await notebook.getByText(highlightQuote).waitFor();
  await notebook.getByText('2 entries').waitFor();
  assert((await notes()).some(note => note.mode === 'highlight' && note.quote === highlightQuote.trim()), 'Highlight must be listed and saved');
  const phone = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    dialog: document.querySelector('.notebook')?.getBoundingClientRect().toJSON(),
  }));
  assert(phone.pageWidth <= phone.viewport && phone.dialog.x >= 0 && phone.dialog.right <= phone.viewport, 'Notebook must fit the 390px phone viewport');
  await page.screenshot({ path: '.playwright-cli/notebook-390x844.png' });
  assert(errors.length === 0, `Reader page errors: ${errors.join('; ')}`);
  for (const note of await notes()) assert((await page.request.delete(`${notesUrl}/${encodeURIComponent(note.id)}`)).ok(), 'Could not clean up isolated fixture note');
  return { result: 'Notebook reflection, highlight, edit retry, filters, Markdown export, exact source, Return, Undo, reload, and phone passed', reflectionId, reflectionOffset, phone };
}
