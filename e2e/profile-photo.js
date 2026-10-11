async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Owner(?: Admin)?$/ }).click();
  await page.getByRole('textbox', { name: "Enter Owner's code" }).fill('profile-photo-test-code-2026');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Owner, profile menu' }).click();
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  const profiles = async () => (await page.request.get(`${origin}/api/profiles`)).json();
  const owner = (await profiles()).find(profile => profile.admin);
  let previousPhoto = null;

  // A real browser-generated image, with the MIME metadata a file picker supplies (or omits).
  const choosePhoto = async (type, corrupt = false) => {
    await page.locator('input[type="file"]').evaluate((input, { type, corrupt }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext('2d');
      context.fillStyle = '#387acb';
      context.fillRect(0, 0, 400, 300);
      const format = type.startsWith('image/') ? type : 'image/jpeg';
      const bytes = Uint8Array.from(atob(canvas.toDataURL(format).split(',')[1]), char => char.charCodeAt(0));
      const files = new DataTransfer();
      files.items.add(new File([corrupt ? 'not an image' : bytes], `camera.${format.split('/')[1]}`, { type }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { type, corrupt });
  };
  for (const type of ['image/jpeg', 'image/png', 'image/webp', '', 'application/octet-stream']) {
    await page.getByRole('button', { name: 'Edit Owner', exact: true }).click();
    await choosePhoto(type);
    const alert = page.locator('.admin-photo [role="alert"]');
    assert(await alert.count() === 0, `Valid photo rejected for MIME ${JSON.stringify(type)}: ${await alert.allTextContents()}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved Owner.', { exact: true }).waitFor();
    const updated = (await profiles()).find(profile => profile.id === owner.id);
    assert(updated.avatar.photo && updated.avatar.photo !== previousPhoto, `Photo was not updated for ${type}`);
    previousPhoto = updated.avatar.photo;
    const response = await page.request.get(`${origin}/api/profiles/${owner.id}/avatar?v=${previousPhoto}`);
    assert(response.ok() && /^image\/(webp|jpeg)$/.test(response.headers()['content-type']), 'Saved avatar could not be loaded');
    await page.reload();
    await page.getByRole('button', { name: 'Edit Owner', exact: true }).waitFor();
    assert((await profiles()).find(profile => profile.id === owner.id).avatar.photo === previousPhoto, 'Photo did not persist after reload');
    await page.waitForFunction(() => {
      const image = document.querySelector('.admin-row .avatar-photo');
      return image?.complete && image.naturalWidth === 256 && image.naturalHeight === 256;
    });
  }

  // Unknown MIME metadata must not bypass server validation or replace the last good photo.
  await page.getByRole('button', { name: 'Edit Owner', exact: true }).click();
  await choosePhoto('', true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'That file is not a picture DeepRead can use.' }).waitFor();
  assert((await profiles()).find(profile => profile.id === owner.id).avatar.photo === previousPhoto, 'Invalid image replaced the saved photo');

  // A connection failure leaves the dialog open, allowing Save to retry the same selection.
  await choosePhoto('image/jpeg');
  const photoRoute = `**/api/admin/profiles/${owner.id}/photo`;
  await page.route(photoRoute, route => route.abort(), { times: 1 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'DeepRead is not reachable.' }).waitFor();
  assert((await profiles()).find(profile => profile.id === owner.id).avatar.photo === previousPhoto, 'Failed upload replaced the saved photo');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Saved Owner.', { exact: true }).waitFor();
  assert((await profiles()).find(profile => profile.id === owner.id).avatar.photo !== previousPhoto, 'Retry did not save the photo');

  // Removal still works after replacing a photo, including in the desktop layout.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Edit Owner', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Remove photo' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: 'Edit Owner', exact: true }).waitFor();
  assert((await profiles()).find(profile => profile.id === owner.id).avatar.photo === null, 'Photo removal did not persist');
  assert((await page.request.get(`${origin}/api/profiles/${owner.id}/avatar`)).status() === 404, 'Removed photo is still served');
  assert(await page.locator('.admin-row .avatar-art').count() === 1, 'Built-in avatar was not restored');
  return 'Photo formats, MIME fallback, rendering, persistence, invalid image rejection, failed-upload retry and removal passed';
}
