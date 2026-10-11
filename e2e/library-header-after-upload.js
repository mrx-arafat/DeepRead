async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const appearance = page.locator('summary').filter({ hasText: 'Appearance' });
  await page.waitForURL(/\/book\//);
  await page.goto(await page.evaluate(() => location.origin));
  await page.getByRole('button', { name: 'Add a book', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  const boxes = await Promise.all([
    page.getByRole('heading', { name: 'DeepRead', exact: true }),
    page.getByRole('button', { name: 'Add a book', exact: true }),
    appearance,
    page.getByRole('button', { name: 'Owner, profile menu' }),
  ].map(locator => locator.boundingBox()));
  const centers = boxes.map(box => box.y + box.height / 2);
  assert(Math.max(...centers) - Math.min(...centers) < 3, 'Desktop controls must share one centerline');
  for (const theme of ['Light', 'Dark', 'Sepia']) {
    await appearance.click();
    await page.getByRole('radio', { name: theme, exact: true }).check();
    await page.keyboard.press('Escape');
    await page.reload();
    await appearance.waitFor();
    assert(await page.locator('html').getAttribute('data-theme') === theme.toLowerCase(), 'Theme must persist');
    await appearance.click();
    const contrast = await page.evaluate(() => {
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      return [...document.querySelectorAll('.library-top .button, .profile-menu-button, .dashboard-theme label')].every(element => {
        const foreground = luminance(getComputedStyle(element).color);
        let surface = element;
        while (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
        const background = luminance(getComputedStyle(surface).backgroundColor);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5;
      });
    });
    assert(contrast, `${theme} header labels must meet 4.5:1 contrast`);
    await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: '/tmp/deepread-header-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await appearance.click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await page.locator('.library').ariaSnapshot();
  await page.screenshot({ path: '/tmp/deepread-header-mobile.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: '/tmp/deepread-header-desktop.png' });
  return 'HEADER_CHECKS_PASSED';
}
