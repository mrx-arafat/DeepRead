async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const shelf = async () => {
    const response = await page.request.get(`${origin}/api/books`);
    assert(response.ok(), 'Could not inspect the isolated shelf');
    return response.json();
  };
  const upload = async path => {
    assert(await page.getByRole('button', { name: 'Add a book (PDF)' }).isVisible(), 'Upload action must be visible');
    await page.locator('input[type="file"]').setInputFiles(path);
    await page.getByRole('link', { name: 'Back to your books' }).waitFor();
    await page.getByRole('link', { name: 'Back to your books' }).click();
    await page.getByRole('region', { name: 'Your books' }).waitFor();
  };
  const more = title => page.getByRole('button', { name: `More actions for ${title}` });
  const row = title => page.locator('.shelf-item').filter({ has: more(title) });
  const select = title => page.getByRole('combobox', { name: `Reading status for ${title}` });

  await page.goto(origin);
  assert((await shelf()).length === 0, 'Run only against a fresh, empty local shelf');
  await page.getByText('No books yet. Add a PDF to start reading.').waitFor();
  const emptyBefore = await page.getByRole('main').ariaSnapshot();
  assert(emptyBefore.includes('No books yet. Add a PDF to start reading.'), 'Empty state must explain the next action');
  await upload('e2e/fixtures/problems-of-philosophy.pdf');
  const [first] = await shelf();
  assert(first?.title === 'The Problems of Philosophy', 'First book upload did not persist');
  assert(await page.getByRole('region', { name: 'Your books' }).getByRole('listitem').count() === 1, 'One-book shelf must show one row');
  assert(await select(first.title).inputValue() === 'reading', 'New book must preserve its default Reading status');
  await more(first.title).click();
  await page.getByRole('button', { name: `Edit ${first.title}` }).waitFor();
  await page.getByRole('button', { name: `Remove ${first.title}` }).waitFor();
  await page.keyboard.press('Escape');
  assert(await more(first.title).getAttribute('aria-expanded') === 'false', 'Escape must close More actions');
  await row(first.title).getByRole('link').first().click();
  await page.getByRole('link', { name: 'Back to your books' }).waitFor();
  await page.getByRole('link', { name: 'Back to your books' }).click();
  await page.getByRole('region', { name: 'Continue reading' }).getByRole('heading', { name: 'Continue reading' }).waitFor();
  const oneBook = await page.getByRole('main').ariaSnapshot();
  assert(oneBook.includes('Continue reading') && oneBook.includes(first.title), 'One-book shelf must offer Continue');
  await page.getByRole('link', { name: `Continue reading ${first.title}` }).click();
  await page.getByRole('link', { name: 'Back to your books' }).click();

  await upload('/tmp/deepread-shelf-matrix-second.pdf');
  const books = await shelf();
  assert(books.length === 2 && books[0].id !== first.id, 'Second book upload did not create a separate row');
  const second = books[0];
  await page.getByRole('group', { name: 'Filter by reading status' }).waitFor();
  const search = page.getByRole('searchbox', { name: 'Find a book' });
  await search.fill(first.title);
  await page.getByRole('status').filter({ hasText: '1 book found' }).waitFor();
  assert(await page.locator('.shelf-item').count() === 1 && await row(first.title).count() === 1, 'Title filter must narrow to the first book');
  await page.getByRole('button', { name: 'Clear book search' }).click();
  assert(await page.locator('.shelf-item').count() === 2, 'Clearing title search must restore both books');

  const statusUrl = `${origin}/api/books/${first.id}/reading-status`;
  const [saved] = await Promise.all([
    page.waitForResponse(response => response.url() === statusUrl && response.request().method() === 'PUT'),
    select(first.title).selectOption('saved'),
  ]);
  assert(saved.ok(), 'Saving the first book for later failed');
  await page.getByRole('button', { name: 'Saved for later 1' }).click();
  assert(await row(first.title).count() === 1 && await row(second.title).count() === 0, 'Status filter must show only Saved books');
  await search.fill(second.title);
  await page.getByRole('status').filter({ hasText: 'No saved for later books match' }).waitFor();
  assert(await page.locator('.shelf-item').count() === 0, 'Title and status filters must combine');
  await page.getByRole('button', { name: 'Show all books' }).click();
  assert(await page.locator('.shelf-item').count() === 2, 'Show all books must reset both filters');

  await more(second.title).click();
  const [pinned] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/books/${second.id}/pin`) && response.request().method() === 'PUT'),
    page.getByRole('button', { name: `Pin ${second.title} to top` }).click(),
  ]);
  assert(pinned.ok(), 'Pin request failed');
  await page.getByRole('region', { name: 'Pinned' }).getByRole('listitem').waitFor();
  assert(await page.getByRole('region', { name: 'Pinned' }).getByRole('listitem').count() === 1, 'Pinned book must move to its section');
  assert(await more(second.title).evaluate(element => element === document.activeElement), 'Focus must follow a row moved by pinning');
  await more(second.title).click();
  await page.getByRole('button', { name: `Edit ${second.title}` }).waitFor();
  const [unpinned] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/books/${second.id}/pin`) && response.request().method() === 'DELETE'),
    page.getByRole('button', { name: `Unpin ${second.title}` }).click(),
  ]);
  assert(unpinned.ok(), 'Unpin request failed');
  await page.getByRole('region', { name: 'Your books' }).getByRole('listitem').first().waitFor();
  assert(await page.getByRole('region', { name: 'Pinned' }).count() === 0, 'Unpinned book must return to Your books');
  assert(await row(second.title).count() === 1, 'Unpin must preserve the book row');
  await page.reload();
  await page.locator('.shelf-item').nth(1).waitFor();
  assert(await page.locator('.shelf-item').count() === 2, 'Both books must survive reload');
  assert(await select(first.title).inputValue() === 'saved', 'Manual status must survive reload');
  assert(await page.getByRole('region', { name: 'Pinned' }).count() === 0, 'Unpin must survive reload');
  await upload('/tmp/deepread-shelf-matrix-third.pdf');
  const manyBooks = await shelf();
  assert(manyBooks.length === 3, 'Many-book shelf must retain all three books');
  assert(await page.locator('.shelf-item').count() === 3, 'Many-book shelf must render every row');
  for (const item of manyBooks) {
    await more(item.title).click();
    await page.getByRole('button', { name: `Pin ${item.title} to top` }).waitFor();
    await page.getByRole('button', { name: `Edit ${item.title}` }).waitFor();
    await page.getByRole('button', { name: `Remove ${item.title}` }).waitFor();
    await page.keyboard.press('Escape');
  }
  assert(errors.length === 0, `Shelf raised browser errors: ${errors.join('; ')}`);
  return 'Empty upload, one-book Continue and More actions, two-book filters, pin/unpin focus, reload, and three-book actions passed';
}
