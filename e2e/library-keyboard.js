async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const booksResponse = await page.request.get(`${origin}/api/books`);
  assert(booksResponse.ok(), 'Fixture shelf must load');
  const books = await booksResponse.json();
  assert(books.length === 2, 'Use an isolated shelf with exactly two PDF fixtures');
  const [book] = books;
  const statusUrl = `${origin}/api/books/${book.id}/reading-status`;
  for (const item of books) {
    const reset = await page.request.put(`${origin}/api/books/${item.id}/reading-status`, { data: { status: 'reading' } });
    assert(reset.ok(), 'Fixture status reset failed');
    const unpin = await page.request.delete(`${origin}/api/books/${item.id}/pin`);
    assert(unpin.ok(), 'Fixture pin reset failed');
  }
  await page.goto(origin);
  const focusIs = (locator) => locator.evaluate((element) => element === document.activeElement);
  const select = page.getByRole('combobox', { name: `Reading status for ${book.title}` });
  const more = page.getByRole('button', { name: `More actions for ${book.title}` });
  const filter = (name) => page.getByRole('button', { name: new RegExp(`^${name} \\d+$`) });
  await select.waitFor();

  const readingFilter = filter('Reading');
  await readingFilter.focus();
  await page.keyboard.press('Enter');
  assert(await readingFilter.getAttribute('aria-pressed') === 'true', 'Enter must activate Reading filter');
  await page.keyboard.press('Tab');
  assert(await focusIs(filter('Saved for later')), 'Tab must move through the next status filter');
  await page.keyboard.press('Tab');
  assert(await focusIs(filter('Finished')), 'Tab must move through the final status filter');
  await page.keyboard.press('Tab');
  assert(await focusIs(page.getByRole('searchbox', { name: 'Find a book' })), 'Tab must move from filters to book search');

  await more.focus();
  await page.keyboard.press('Enter');
  assert(await more.getAttribute('aria-expanded') === 'true', 'Enter must open More actions');
  await page.keyboard.press('Escape');
  assert(await more.getAttribute('aria-expanded') === 'false', 'Escape must close More actions');
  assert(await focusIs(more), 'Escape must restore More actions focus');

  await page.keyboard.press('Enter');
  const pin = page.getByRole('button', { name: `Pin ${book.title} to top` });
  await pin.waitFor();
  await page.keyboard.press('Tab');
  assert(await focusIs(pin), 'Tab must enter the More actions panel');
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Pinned' }).getByRole('listitem').waitFor();
  assert(await focusIs(more), 'Pinning a moved row must restore More actions focus');
  await page.keyboard.press('Enter');
  const unpin = page.getByRole('button', { name: `Unpin ${book.title}` });
  await unpin.waitFor();
  await page.keyboard.press('Tab');
  assert(await focusIs(unpin), 'Tab must reach Unpin');
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Your books' }).getByRole('listitem').filter({ has: select }).waitFor();
  assert(await focusIs(more), 'Unpinning a moved row must restore More actions focus');

  await page.keyboard.press('Tab');
  assert(await focusIs(select), 'Tab must move from More actions to reading status');
  const [statusWrite] = await Promise.all([
    page.waitForResponse((response) => response.url() === statusUrl && response.request().method() === 'PUT'),
    page.keyboard.press('s'),
  ]);
  assert(statusWrite.ok(), 'Keyboard status write must succeed');
  await select.waitFor({ state: 'detached' });
  assert(await page.getByRole('region', { name: 'Your books' }).getByRole('listitem').count() === 1, 'The other Reading book must remain visible');
  assert(await focusIs(readingFilter), 'Changing status must focus the active filter when its row disappears');
  const stored = await (await page.request.get(`${origin}/api/books/${book.id}`)).json();
  assert(stored.readingStatus === 'saved', 'Keyboard status change must persist Saved for later');

  const savedFilter = filter('Saved for later');
  await savedFilter.focus();
  await page.keyboard.press('Enter');
  assert(await savedFilter.getAttribute('aria-pressed') === 'true', 'Enter must activate Saved for later filter');
  assert(await select.inputValue() === 'saved', 'Saved filter must display the changed book');
  await page.keyboard.press('Escape');
  assert(await focusIs(savedFilter), 'Escape on a filter must leave its focus in place');
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return 'Keyboard shelf passed: Tab, Enter, Escape, More actions, pin/unpin focus, native status change, filter focus after row removal';
}
