async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  await page.goto(origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(books.length === 2, 'Use an isolated shelf with two fixture books');
  const [newest, older] = books;
  const statusUrl = id => `${origin}/api/books/${id}/reading-status`;
  const status = async id => (await (await page.request.get(`${origin}/api/books/${id}`)).json()).readingStatus;
  const progress = async id => (await (await page.request.get(`${origin}/api/books/${id}`)).json()).progress;
  const initialProgress = await Promise.all(books.map(book => progress(book.id)));
  for (const book of books) {
    const reset = await page.request.put(statusUrl(book.id), { data: { status: 'reading' } });
    assert(reset.ok(), 'Could not prepare fixture status');
  }
  await page.reload();
  const select = book => page.getByRole('combobox', { name: `Reading status for ${book.title}` });
  const choose = async (book, value) => {
    const [response] = await Promise.all([
      page.waitForResponse(result => result.url() === statusUrl(book.id) && result.request().method() === 'PUT'),
      select(book).selectOption(value),
    ]);
    assert(response.ok(), `Could not save ${value} fixture status`);
  };
  await page.getByRole('region', { name: 'Continue reading' }).getByRole('heading', { name: newest.title }).waitFor();
  await page.getByRole('searchbox', { name: 'Find a book' }).fill(newest.title);
  await page.getByRole('button', { name: 'All 1' }).waitFor();
  await page.getByRole('button', { name: 'Reading 1' }).waitFor();
  await page.getByRole('button', { name: 'Clear book search' }).click();

  await choose(newest, 'saved');
  assert(await status(newest.id) === 'saved', 'Saved for later must persist on the server');
  await page.getByRole('region', { name: 'Continue reading' }).getByRole('heading', { name: older.title }).waitFor();
  await page.getByRole('button', { name: /^Saved for later / }).click();
  assert(await page.getByRole('region', { name: 'Continue reading' }).count() === 0, 'Saved filter should not show a Reading Continue card');
  assert(await page.getByRole('region', { name: 'Your books' }).getByRole('listitem').count() === 1, 'Saved filter should show only the saved book');

  await choose(newest, 'finished');
  await page.getByText('No books marked saved for later.').waitFor();
  assert(await page.getByRole('button', { name: /^Saved for later / }).evaluate(element => element === document.activeElement), 'Focus should survive when the changed book leaves its filter');
  assert(await status(newest.id) === 'finished', 'Finished should persist independently of progress');
  await page.getByRole('button', { name: 'Show all books' }).click();
  await page.reload();
  assert(await select(newest).inputValue() === 'finished', 'Manual status must survive reload');

  await choose(newest, 'reading');
  await page.getByRole('region', { name: 'Continue reading' }).getByRole('heading', { name: newest.title }).waitFor();
  assert(await status(newest.id) === 'reading', 'Finished must be manually correctable');
  await page.route(statusUrl(newest.id), route => route.fulfill({ status: 503, body: 'fixture write failed' }));
  const [failed] = await Promise.all([
    page.waitForResponse(result => result.url() === statusUrl(newest.id) && result.request().method() === 'PUT'),
    select(newest).selectOption('saved'),
  ]);
  assert(failed.status() === 503, 'Fixture must reject the status write');
  await page.getByRole('alert').filter({ hasText: 'could not be saved' }).waitFor();
  assert(await select(newest).inputValue() === 'reading', 'A rejected status must roll back in the shelf');
  assert(await status(newest.id) === 'reading', 'A rejected status must not change server state');
  await page.unroute(statusUrl(newest.id));
  for (const [index, book] of books.entries()) {
    assert(JSON.stringify(await progress(book.id)) === JSON.stringify(initialProgress[index]), 'Status edits must not change reading progress');
  }
  await page.getByRole('button', { name: `More actions for ${newest.title}` }).click();
  await page.getByRole('button', { name: `Pin ${newest.title} to top` }).waitFor();
  assert(errors.length === 0, `Library threw: ${errors.join('; ')}`);
  return 'Per-reader status change, filters, reload, manual correction, rollback, progress preservation, and existing More actions passed';
}
