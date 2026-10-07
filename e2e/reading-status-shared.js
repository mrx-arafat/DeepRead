async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const ownerCode = 'shared-status-test-code-2026';
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
  const shelf = async () => {
    const response = await page.request.get(`${origin}/api/books`);
    assert(response.ok(), 'Could not read this profile shelf');
    return response.json();
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
  await page.getByRole('link', { name: 'Back to your books' }).waitFor();
  await page.getByRole('link', { name: 'Back to your books' }).click();
  await page.getByRole('region', { name: 'Your books' }).waitFor();
  const [owned] = await shelf();
  assert(owned?.title === 'The Problems of Philosophy', 'Expected one uploaded fixture on owner shelf');
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  const share = page.getByRole('switch', { name: `Share with ${readerName}` });
  await share.waitFor();
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();
  assert((await shelf())[0]?.readingStatus === 'reading', 'Owner should remain Reading');

  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  const [received] = await shelf();
  assert(received?.sharedBy?.name === 'Owner', 'Recipient must see shared book');
  assert(received.id !== owned.id, 'Recipient must have a distinct shared-book id');
  const status = page.getByRole('combobox', { name: `Reading status for ${owned.title}` });
  assert(await status.inputValue() === 'reading', 'Shared book should start Reading');
  const [saved] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/books/${received.id}/reading-status`) && response.request().method() === 'PUT'),
    status.selectOption('finished'),
  ]);
  assert(saved.ok(), 'Recipient status save request failed');
  assert((await shelf())[0]?.readingStatus === 'finished', 'Recipient Finished status not saved');
  await page.reload();
  assert(await status.inputValue() === 'finished', 'Recipient status did not survive reload');

  await switchProfile(readerName);
  await signIn('Owner', ownerCode);
  assert((await shelf())[0]?.readingStatus === 'reading', 'Recipient changed owner status');
  await page.getByRole('button', { name: `More actions for ${owned.title}` }).click();
  await page.getByRole('button', { name: `Share ${owned.title}` }).click();
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: false }).waitFor();
  await share.click();
  await page.getByRole('switch', { name: `Share with ${readerName}`, checked: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();
  await switchProfile('Owner');
  await signIn(readerName, readerCode);
  assert(await status.inputValue() === 'finished', 'Recipient status lost on unshare and reshare');
  assert((await shelf())[0]?.readingStatus === 'finished', 'Server lost recipient status on reshare');
  const actions = page.getByRole('button', { name: `More actions for ${owned.title}` });
  await actions.click();
  assert(await page.getByRole('button', { name: `Edit ${owned.title}` }).count() === 0, 'Recipient must not edit the owner book');
  assert(await page.getByRole('button', { name: `Share ${owned.title}` }).count() === 0, 'Recipient must not reshare the owner book');
  await page.getByRole('button', { name: `Remove ${owned.title} from my shelf` }).waitFor();
  await page.getByRole('button', { name: `Pin ${owned.title} to top` }).click();
  await page.getByRole('region', { name: 'Pinned' }).getByRole('listitem').waitFor();
  await actions.click();
  await page.getByRole('button', { name: `Unpin ${owned.title}` }).click();
  await page.getByRole('region', { name: 'Your books' }).getByRole('listitem').waitFor();
  assert(errors.length === 0, `UI page errors: ${errors.join('; ')}`);
  return 'Owner/recipient status isolation, reload and reshare restoration, and recipient actions passed';
}
