async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const ownerCode = 'shared-detour-test-code-2026';
  const readerCode = '246810';
  const readerName = 'Mina';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const signIn = async (name, code) => {
    await page.getByRole('button', { name: new RegExp(`^${name}(?: Admin)?$`) }).click();
    await page.getByRole('textbox', { name: `Enter ${name}'s code` }).fill(code);
    await page.getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: `${name}, profile menu` }).waitFor();
  };
  const switchProfile = async name => {
    await page.getByRole('button', { name: `${name}, profile menu` }).click();
    await page.getByRole('button', { name: 'Switch profile' }).click();
    await page.getByRole('heading', { name: "Who's reading?" }).waitFor();
  };
  const getJson = async path => {
    const response = await page.request.get(`${origin}${path}`);
    assert(response.ok(), `Could not read ${path}: ${response.status()}`);
    return response.json();
  };
  const put = async (path, data) => {
    const response = await page.request.put(`${origin}${path}`, { data });
    assert(response.ok(), `Could not prepare ${path}: ${response.status()}`);
  };
  const addHighlight = async (id, block, quote) => {
    const noteId = await page.evaluate(() => crypto.randomUUID());
    await put(`/api/books/${id}/notes/${noteId}`, {
      note: { id: noteId, chapterId: 'c3', blockId: block.id, offset: 0, quote, lang: 'bn', mode: 'highlight', color: 'yellow' },
      before: null,
    });
  };
  const context = async (expected, excluded) => {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Where I left off', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Where I left off' });
    await dialog.getByRole('region', { name: 'Before your saved place' }).waitFor();
    const highlight = dialog.getByRole('region', { name: 'Your highlight' });
    await highlight.waitFor();
    assert((await highlight.textContent()).includes(expected), 'Reminder did not show this reader\'s highlight');
    assert(!(await highlight.textContent()).includes(excluded), 'Reminder leaked the other reader\'s highlight');
    assert((await dialog.getByRole('region', { name: 'Before your saved place' }).getByRole('blockquote').textContent()).length <= 600, 'Prior passage is not bounded');
    await dialog.getByRole('button', { name: 'Close reading context' }).click();
  };

  await page.goto(origin);
  await page.getByRole('heading', { name: "Who's reading?" }).waitFor();
  await signIn('Owner', ownerCode);
  await page.getByRole('button', { name: 'Owner, profile menu' }).click();
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Add a profile' }).click();
  await page.getByRole('form', { name: 'Add a profile' }).getByRole('textbox', { name: 'Name' }).fill(readerName);
  await page.getByRole('form', { name: 'Add a profile' }).getByLabel('Code').fill(readerCode);
  await page.getByRole('form', { name: 'Add a profile' }).getByRole('button', { name: 'Add profile' }).click();
  await page.getByText('Added Mina.').waitFor();
  await page.getByRole('link', { name: 'Back to the library' }).click();

  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/problems-of-philosophy.pdf');
  await page.getByRole('link', { name: 'Back to your books' }).click();
  const [owned] = await getJson('/api/books');
  assert(owned?.title === 'The Problems of Philosophy', 'Expected uploaded owner fixture');
  const ownerId = owned.id;
  const chapter = await getJson(`/api/books/${ownerId}/chapters/c3`);
  const ownerSource = chapter.blocks.find(block => block.id === 'c3-b3');
  const readerSource = chapter.blocks.find(block => block.id === 'c3-b4');
  const readerPlace = chapter.blocks.find(block => block.id === 'c3-b5');
  assert(ownerSource && readerSource && readerPlace, 'Fixture chapter changed');
  const ownerQuote = ownerSource.text.slice(0, 52);
  const readerQuote = readerSource.text.slice(0, 52);
  assert(ownerQuote !== readerQuote, 'Fixture needs distinct highlight text');
  await put(`/api/books/${ownerId}/progress`, { chapterId: 'c3', blockId: readerSource.id, offset: Math.min(120, readerSource.text.length) });
  await addHighlight(ownerId, ownerSource, ownerQuote);
  await context(ownerQuote, readerQuote);

  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  const share = page.getByRole('switch', { name: `Share with ${readerName}` });
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();

  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  const [received] = await getJson('/api/books');
  assert(received?.sharedBy?.name === 'Owner' && received.id !== ownerId, 'Recipient needs their own shared-book identity');
  const readerId = received.id;
  assert((await getJson(`/api/books/${readerId}/notes`)).length === 0, 'Owner highlight leaked through notes API');
  await put(`/api/books/${readerId}/progress`, { chapterId: 'c3', blockId: readerPlace.id, offset: Math.min(100, readerPlace.text.length) });
  await addHighlight(readerId, readerSource, readerQuote);
  await context(readerQuote, ownerQuote);
  assert((await getJson(`/api/books/${readerId}`)).progress.blockId === readerPlace.id, 'Recipient saved place changed during context');

  await switchProfile(readerName);
  await signIn('Owner', ownerCode);
  assert((await getJson(`/api/books/${ownerId}`)).progress.blockId === readerSource.id, 'Recipient moved owner progress');
  const ownerNotes = await getJson(`/api/books/${ownerId}/notes`);
  assert(ownerNotes.length === 1 && ownerNotes[0].quote === ownerQuote, 'Recipient changed or leaked owner highlights');
  await context(ownerQuote, readerQuote);
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: false }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();

  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  assert((await getJson('/api/books')).length === 0, 'Unshared book remains on recipient shelf');
  assert((await page.request.get(`${origin}/api/books/${readerId}`)).status() === 404, 'Unshared book detail remains accessible');
  assert((await page.request.get(`${origin}/api/books/${readerId}/notes`)).status() === 404, 'Unshared notes remain accessible');
  await page.goto(`${origin}/book/${readerId}`);
  await page.getByText('That book is not in your library. It may have been deleted.').waitFor();

  await page.goto(origin);
  await switchProfile(readerName);
  await signIn('Owner', ownerCode);
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();
  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  assert((await getJson(`/api/books/${readerId}`)).progress.blockId === readerPlace.id, 'Reshare lost recipient progress');
  const readerNotes = await getJson(`/api/books/${readerId}/notes`);
  assert(readerNotes.length === 1 && readerNotes[0].quote === readerQuote, 'Reshare lost recipient highlight');
  await context(readerQuote, ownerQuote);
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return 'Shared reading context, per-reader progress and highlights, revocation, and reshare restoration passed';
}
