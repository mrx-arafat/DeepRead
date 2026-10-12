async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: /^Owner(?: Admin)?$/ }).click();
  await page.getByRole('textbox', { name: "Enter Owner's code" }).fill('ux02-profile-test-code-2026');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const appearance = page.locator('summary').filter({ hasText: 'Appearance' });
  await appearance.waitFor({ timeout: 5000 });
  let overlaps = 0;
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.library').ariaSnapshot();
    await appearance.click();
    await page.getByRole('radio', { name: 'Sepia', exact: true }).check();
    assert(await page.locator('html').getAttribute('data-theme') === 'sepia', 'Theme must change');
    await page.locator('.library').ariaSnapshot();
    await page.keyboard.press('Escape');
    assert(!(await page.getByRole('radio', { name: 'Sepia', exact: true }).isVisible()), 'Escape must close appearance');
    await page.getByRole('button', { name: 'Owner, profile menu' }).click();
    await page.getByRole('button', { name: 'Switch profile' }).waitFor();
    const profileCoversTheme = await page.locator('.profile-menu-panel').evaluate(panel => {
      const theme = document.querySelector('.library-appearance summary').getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const left = Math.max(theme.left, box.left), right = Math.min(theme.right, box.right);
      const top = Math.max(theme.top, box.top), bottom = Math.min(theme.bottom, box.bottom);
      const overlap = left < right && top < bottom;
      return { overlap, covered: !overlap || panel.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)) };
    });
    if (profileCoversTheme.overlap) overlaps++;
    assert(profileCoversTheme.covered, `Profile dropdown must cover the theme button beside Switch profile at ${width}px`);
    await page.locator('.library').ariaSnapshot();
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Header must fit viewport');
  }
  assert(overlaps > 0, 'Check must exercise an overlapping narrow header layout');
  await page.getByRole('button', { name: 'Add a book', exact: true }).click();
}
