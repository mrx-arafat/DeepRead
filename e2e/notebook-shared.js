async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const ownerCode = 'shared-notebook-test-code-2026';
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
    await page.goto(origin);
    await page.getByRole('button', { name: `${name}, profile menu` }).click();
    await page.getByRole('button', { name: 'Switch profile' }).click();
    await page.getByRole('heading', { name: "Who's reading?" }).waitFor();
  };
  const get = async path => {
    const response = await page.request.get(`${origin}${path}`);
    assert(response.ok(), `${path} returned ${response.status()}`);
    return response.json();
  };
  const writeReflection = async (id, blockId, text) => {
    await page.goto(`${origin}/book/${id}/c3`);
    await page.getByRole('button', { name: 'Notebook' }).waitFor();
    const block = page.locator(`[data-block="${blockId}"]`);
    await block.scrollIntoViewIfNeeded();
    const quote = await block.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node || node.textContent.length < 45) throw new Error('Fixture passage changed');
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 45);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      return range.toString();
    });
    await page.getByRole('toolbar', { name: 'Explain, highlight, or reflect on selected text' }).getByRole('button', { name: 'Reflect' }).click();
    const notebook = page.getByRole('dialog', { name: 'Notebook' });
    await notebook.getByRole('textbox', { name: 'Your reflection' }).fill(text);
    await notebook.getByRole('button', { name: 'Save reflection' }).click();
    await notebook.getByText(text).waitFor();
    await notebook.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
    return { notebook, quote };
  };
  const exportAndCheck = async (notebook, included, excluded) => {
    await page.evaluate(() => {
      window.__notebookExports = [];
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        void blob.text().then(text => window.__notebookExports.push(text));
        return original(blob);
      };
    });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      notebook.getByRole('button', { name: 'Export selected' }).click(),
    ]);
    assert(download.suggestedFilename().endsWith('-notebook.md'), 'Notebook export should download Markdown');
    await page.waitForFunction(() => window.__notebookExports.length === 1);
    const markdown = await page.evaluate(() => window.__notebookExports[0]);
    assert(markdown.includes(included), 'Export omitted this reader\'s reflection');
    assert(!markdown.includes(excluded), 'Export leaked the other reader\'s reflection');
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
  const [owned] = await get('/api/books');
  assert(owned?.title === 'The Problems of Philosophy', 'Expected owner fixture');
  const ownerText = 'Only the owner sees this table reflection';
  const readerText = 'Only Mina sees this separate reflection';
  let { notebook } = await writeReflection(owned.id, 'c3-b4', ownerText);
  assert(!(await notebook.textContent()).includes(readerText), 'Owner notebook contains recipient text');
  await exportAndCheck(notebook, ownerText, readerText);
  await notebook.getByRole('button', { name: 'Close notebook' }).click();
  await page.goto(origin);
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  const share = page.getByRole('switch', { name: `Share with ${readerName}` });
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();

  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  const [received] = await get('/api/books');
  assert(received?.sharedBy?.name === 'Owner' && received.id !== owned.id, 'Shared copy needs a separate reader identity');
  assert((await get(`/api/books/${received.id}/notes`)).length === 0, 'Owner notes leaked to recipient API');
  assert((await page.request.get(`${origin}/api/books/${owned.id}/notes`)).status() === 404, 'Recipient accessed owner book ID');
  ({ notebook } = await writeReflection(received.id, 'c3-b5', readerText));
  assert(!(await notebook.textContent()).includes(ownerText), 'Recipient notebook leaked owner reflection');
  await exportAndCheck(notebook, readerText, ownerText);
  await notebook.getByRole('button', { name: 'Close notebook' }).click();

  await switchProfile(readerName);
  await signIn('Owner', ownerCode);
  await page.goto(`${origin}/book/${owned.id}/c3`);
  await page.getByRole('button', { name: 'Notebook' }).click();
  notebook = page.getByRole('dialog', { name: 'Notebook' });
  await notebook.getByText(ownerText).waitFor();
  assert(!(await notebook.textContent()).includes(readerText), 'Owner notebook leaked recipient reflection');
  const ownerNotes = await get(`/api/books/${owned.id}/notes`);
  assert(ownerNotes.length === 1 && ownerNotes[0].text === ownerText, 'Recipient changed owner notes');
  assert((await page.request.get(`${origin}/api/books/${received.id}/notes`)).status() === 404, 'Owner accessed recipient book ID');
  await exportAndCheck(notebook, ownerText, readerText);
  await notebook.getByRole('button', { name: 'Close notebook' }).click();
  await page.goto(origin);
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: false }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();

  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  assert((await get('/api/books')).length === 0, 'Unshared book remains on recipient shelf');
  assert((await page.request.get(`${origin}/api/books/${received.id}`)).status() === 404, 'Unshared book detail remains accessible');
  assert((await page.request.get(`${origin}/api/books/${received.id}/notes`)).status() === 404, 'Unshared notes remain accessible');
  await page.goto(`${origin}/book/${received.id}/c3`);
  await page.getByText('That book is not in your library. It may have been deleted.').waitFor();
  assert(await page.getByRole('button', { name: 'Notebook' }).count() === 0, 'Revoked book still exposes Notebook');

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
  await page.goto(`${origin}/book/${received.id}/c3`);
  await page.getByRole('button', { name: 'Notebook' }).click();
  notebook = page.getByRole('dialog', { name: 'Notebook' });
  await notebook.getByText(readerText).waitFor();
  assert(!(await notebook.textContent()).includes(ownerText), 'Reshared notebook leaked owner reflection');
  const restored = await get(`/api/books/${received.id}/notes`);
  assert(restored.length === 1 && restored[0].text === readerText, 'Reshare lost recipient reflection');
  await exportAndCheck(notebook, readerText, ownerText);
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return 'Shared Notebook owner/recipient UI and exports, revocation, and reshare restoration passed';
}
