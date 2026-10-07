async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const ownerCode = 'ux02-profile-test-code-2026';
  const readerCode = '246810';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const signIn = async (name, code) => {
    await page.getByRole('button', { name: new RegExp(`^${name}(?: Admin)?$`) }).click();
    await page.getByRole('textbox', { name: `Enter ${name}'s code` }).fill(code);
    await page.getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: `${name}, profile menu` }).waitFor();
  };
  const switchProfile = async name => {
    if (await page.getByRole('link', { name: 'Back to your books' }).count()) {
      await page.getByRole('link', { name: 'Back to your books' }).click();
    }
    await page.getByRole('button', { name: `${name}, profile menu` }).click();
    await page.getByRole('button', { name: 'Switch profile' }).click();
    await page.getByRole('heading', { name: "Who's reading?" }).waitFor();
  };
  const notes = async id => {
    const response = await page.request.get(`${origin}/api/books/${id}/notes`);
    assert(response.ok(), `Could not read notes for ${id}`);
    return response.json();
  };
  const pending = async (profileId, bookId) => page.evaluate(({ profileId, bookId }) =>
    Object.keys(localStorage).filter(key => key.startsWith(`deepread.pendingNotes.${profileId}.${bookId}.operations.`) && !key.endsWith('.rejected') && !key.endsWith('.done')),
    { profileId, bookId });
  const highlight = async index => {
    const block = page.locator('.chapter-text [data-block]').filter({ hasText: /\S.{100}/ }).nth(index);
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
      return range.toString().trim();
    });
    await page.getByRole('button', { name: 'Highlight in yellow' }).click();
    return quote;
  };

  await page.goto(origin);
  await page.getByRole('heading', { name: "Who's reading?" }).waitFor();
  await signIn('Owner', ownerCode);
  const ownerProfile = (await (await page.request.get(`${origin}/api/session`)).json()).session.profile;
  await page.getByRole('button', { name: 'Owner, profile menu' }).click();
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Add a profile' }).click();
  await page.getByRole('form', { name: 'Add a profile' }).getByRole('textbox', { name: 'Name' }).fill('Mina');
  await page.getByRole('form', { name: 'Add a profile' }).getByLabel('Code').fill(readerCode);
  await page.getByRole('form', { name: 'Add a profile' }).getByRole('button', { name: 'Add profile' }).click();
  await page.getByText('Added Mina.').waitFor();
  const profiles = await (await page.request.get(`${origin}/api/profiles`)).json();
  const minaProfile = profiles.find(profile => profile.name === 'Mina');
  assert(minaProfile, 'Mina profile was not created');
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/problems-of-philosophy.pdf');
  await page.getByRole('link', { name: 'Back to your books' }).click();
  const [owned] = await (await page.request.get(`${origin}/api/books`)).json();
  assert(owned?.title === 'The Problems of Philosophy', 'Expected one fixture book');
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  await page.getByRole('switch', { name: 'Share with Mina' }).click();
  await page.getByRole('switch', { name: 'Share with Mina', checked: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();

  const ownerUrl = `${origin}/book/${owned.id}/c2`;
  const ownerWrite = `**/api/books/${owned.id}/notes/*`;
  await page.route(ownerWrite, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await page.goto(ownerUrl);
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  const ownerQuote = await highlight(0);
  await page.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert((await pending(ownerProfile.id, owned.id)).length === 1, 'Owner pending note was not retained');
  await switchProfile('Owner');
  await signIn('Mina', readerCode);
  const [received] = await (await page.request.get(`${origin}/api/books`)).json();
  assert(received?.sharedBy?.name === 'Owner', 'Mina must receive the shared book');
  await page.goto(`${origin}/book/${received.id}/c2`);
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert(await page.locator('.chapter-text mark').count() === 0, 'Owner pending highlight leaked into Mina reader');
  assert((await notes(received.id)).length === 0, 'Owner pending note was sent as Mina');
  assert((await pending(ownerProfile.id, owned.id)).length === 1, 'Mina session altered owner outbox');
  const minaQuote = await highlight(1);
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert((await notes(received.id)).filter(note => note.quote === minaQuote).length === 1, 'Mina note was not saved exactly once');
  await switchProfile('Mina');
  await signIn('Owner', ownerCode);
  await page.goto(ownerUrl);
  await page.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert((await pending(ownerProfile.id, owned.id)).length === 1, 'Owner pending note disappeared on profile switch');
  assert((await notes(owned.id)).length === 0, 'Mina note leaked into owner book');
  await page.unroute(ownerWrite);
  await page.getByRole('status', { name: 'Waiting for connection' }).getByRole('button', { name: 'Retry save' }).click();
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert((await notes(owned.id)).filter(note => note.quote === ownerQuote).length === 1, 'Owner recovery did not save exactly once');
  assert((await pending(ownerProfile.id, owned.id)).length === 0, 'Acknowledged owner note remained pending');

  await page.route(ownerWrite, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  const expiringQuote = await highlight(2);
  await page.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert((await pending(ownerProfile.id, owned.id)).length === 1, 'Second owner note was not durable before expiry');
  await page.context().clearCookies();
  await page.unroute(ownerWrite);
  await page.getByRole('status', { name: 'Waiting for connection' }).getByRole('button', { name: 'Retry save' }).click();
  await page.getByRole('heading', { name: "Who's reading?" }).waitFor();
  assert((await pending(ownerProfile.id, owned.id)).length === 1, 'Expired session erased the pending note');
  const signedOutNotes = await page.request.get(`${origin}/api/books/${owned.id}/notes`);
  assert(signedOutNotes.status() === 401, 'Signed-out browser unexpectedly read owner notes');
  await page.route(ownerWrite, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await signIn('Owner', ownerCode);
  await page.goto(ownerUrl);
  await page.getByRole('status', { name: 'Waiting for connection' }).waitFor();
  assert((await pending(ownerProfile.id, owned.id)).length === 1, 'Re-authentication lost the pending note');
  await page.unroute(ownerWrite);
  await page.getByRole('status', { name: 'Waiting for connection' }).getByRole('button', { name: 'Retry save' }).click();
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert((await notes(owned.id)).filter(note => note.quote === expiringQuote).length === 1, 'Post-expiry retry did not save exactly once');
  assert((await pending(ownerProfile.id, owned.id)).length === 0, 'Post-expiry acknowledgement remained pending');
  await page.reload();
  await page.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  assert((await notes(owned.id)).length === 2, 'Reload changed the two acknowledged owner notes');
  const blockedStorage = await page.context().newPage();
  blockedStorage.on('pageerror', error => errors.push(error.message));
  await blockedStorage.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('deepread.pendingNotes.')) throw new DOMException('Site data blocked', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await blockedStorage.route(ownerWrite, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await blockedStorage.goto(ownerUrl);
  await blockedStorage.getByRole('status', { name: 'Notes saved', exact: true }).waitFor();
  const block = blockedStorage.locator('.chapter-text [data-block]').filter({ hasText: /\S.{100}/ }).nth(3);
  await block.scrollIntoViewIfNeeded();
  await block.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode()) && text.textContent.length < 100) {}
    if (!text) throw new Error('Fixture needs another passage');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 80);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
  await blockedStorage.getByRole('button', { name: 'Highlight in yellow' }).click();
  const unavailable = blockedStorage.getByRole('status', { name: 'Note recovery is unavailable' });
  await unavailable.waitFor();
  assert((await unavailable.innerText()).includes('Keep this page open. Closing it may lose unsaved changes.'), 'Blocked browser storage must warn that the unsaved note is not durable');
  assert(await unavailable.getByRole('button', { name: 'Retry save' }).isVisible(), 'Storage failure must retain a retry action');
  assert((await notes(owned.id)).length === 2, 'Blocked storage test unexpectedly wrote to the server');
  await blockedStorage.close();
  assert(errors.length === 0, `Reader page errors: ${errors.join('; ')}`);
  return 'Profile switch, expired session and blocked-storage recovery states passed; acknowledged notes saved exactly once';
}
