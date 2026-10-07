async (page) => {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const openAppearance = async () => {
    await page.mouse.move(12, 12);
    await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  };
  await openAppearance();
  await page.getByRole('button', { name: 'Reader preferences', exact: true }).click({ timeout: 3000 });
  const preferences = page.locator('#reader-preferences');
  await preferences.waitFor({ state: 'visible' });
  require(await page.locator('#reading-settings').isHidden(), 'Appearance must close when preferences open');
  await preferences.getByLabel('Explain in', { exact: true }).selectOption('es');
  await page.keyboard.press('Escape');
  require(await preferences.isHidden(), 'Escape must dismiss reader preferences');
  require(await page.getByRole('button', { name: 'Reading settings', exact: true }).evaluate(el => el === document.activeElement), 'Focus must return to Aa');
  await page.reload();
  await openAppearance();
  const appearance = page.locator('#reading-settings');
  require(await appearance.getByLabel('Explain in', { exact: true }).count() === 0, 'Appearance must not contain language configuration');
  await page.getByRole('button', { name: 'Reader preferences', exact: true }).click();
  require(await preferences.getByLabel('Explain in', { exact: true }).inputValue() === 'es', 'Language must survive reload');
  await preferences.getByRole('button', { name: 'Voice settings', exact: true }).click();
  const voice = page.locator('#reading-voice');
  await voice.waitFor({ state: 'visible' });
  require(await preferences.isHidden(), 'Preferences must close when voice settings open');
  require(await voice.getByRole('radio', { name: 'This device', exact: true }).isChecked(), 'Device voice must remain selected');
  await page.keyboard.press('Escape');
  require(await voice.isHidden(), 'Escape must dismiss voice settings');

  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  const player = page.getByRole('region', { name: 'Read aloud', exact: true });
  await player.getByRole('button', { name: 'Voice settings', exact: true }).click();
  await voice.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  require(await player.isVisible(), 'Dismissing voice settings must not stop listening');
  await player.getByRole('button', { name: 'Stop listening', exact: true }).click();

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const layout of ['scroll', 'pages']) {
      await openAppearance();
      await appearance.locator(`input[value="${layout}"]`).check();
      await page.keyboard.press('Escape');
      for (const theme of ['light', 'sepia', 'dark']) {
        await openAppearance();
        await appearance.locator(`input[value="${theme}"]`).check();
        const bounds = await appearance.boundingBox();
        require(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844, 'Appearance must fit the viewport');
        await page.keyboard.press('Escape');
        require(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Reader must not overflow horizontally');
      }
      if (layout === 'pages') {
        // Resizing can leave a logical position between page boundaries; align with one real turn first.
        const initial = await page.evaluate(() => scrollY);
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.waitForFunction(previous => scrollY > previous + 10, initial);
        const before = await page.evaluate(() => scrollY);
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.waitForFunction(previous => scrollY > previous + 10, before);
        await page.getByRole('button', { name: 'Previous page', exact: true }).click();
        await page.waitForFunction(previous => Math.abs(scrollY - previous) < 3, before);
      }
    }
  }
  await openAppearance();
  await appearance.locator('input[value="light"]').check();
  await appearance.locator('input[value="scroll"]').check();
  await page.keyboard.press('Escape');
  return 'Reader comfort: separate controls, persistence, focus return, player dismissal, three widths, three themes and both layouts passed';
}
