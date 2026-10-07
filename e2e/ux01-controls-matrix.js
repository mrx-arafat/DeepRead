async (page) => {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const viewportFits = async (locator, width, height, label) => {
    const box = await locator.boundingBox();
    require(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `${label} must fit ${width}x${height}`);
  };
  const shelfBook = page.getByRole('link', { name: 'The Problems of Philosophy', exact: true });
  const origin = page.url().split('/').slice(0, 3).join('/');
  await page.goto(origin);
  await shelfBook.waitFor();
  const chapterUrl = `${await shelfBook.getAttribute('href')}/c3`;
  await page.goto(`${origin}${chapterUrl}`);
  const chapter = page.locator('.chapter[data-chapter="c3"]');
  const title = chapter.locator('.chapter-head h2');
  const paragraph = chapter.locator('.chapter-text p[data-block]').first();
  await paragraph.waitFor();

  for (const size of [{ width: 390, height: 844 }, { width: 390, height: 600 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await title.evaluate((element) => { element.scrollIntoView({ block: 'start' }); window.scrollBy(0, -84); });
    await page.mouse.move(12, 12);
    const opening = await page.evaluate(() => {
      const chapter = document.querySelector('.chapter[data-chapter="c3"]');
      const heading = chapter.querySelector('.chapter-head h2').getBoundingClientRect();
      const first = chapter.querySelector('.chapter-text p[data-block]').getBoundingClientRect();
      return { heading: heading.toJSON(), first: first.toJSON(), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    require(!opening.overflow, `Reader must not overflow at ${size.width}x${size.height}`);
    require(opening.heading.top >= 0 && opening.heading.bottom < size.height, 'Complete chapter title must start in the viewport');
    require(opening.first.top < size.height - 32, 'First paragraph must be available in the chapter opening');
    if (size.width === 390) await page.screenshot({ path: `.playwright-cli/ux01-opening-390x${size.height}.png` });

    const settingsButton = page.getByRole('button', { name: 'Reading settings', exact: true });
    await settingsButton.click();
    const settings = page.locator('#reading-settings');
    await settings.waitFor({ state: 'visible' });
    await viewportFits(settings, size.width, size.height, 'Aa panel');
    if (size.width === 390 && size.height === 600) await page.screenshot({ path: '.playwright-cli/ux01-aa-390x600.png' });
    for (const theme of ['light', 'sepia', 'dark']) {
      await settings.locator(`input[value="${theme}"]`).check();
      require(await page.locator('html').getAttribute('data-theme') === theme, `${theme} theme must apply`);
      await viewportFits(settings, size.width, size.height, 'Aa panel');
    }
    const sizeSlider = settings.getByRole('slider', { name: 'Text size' });
    while (Number(await sizeSlider.inputValue()) > 19) await settings.getByRole('button', { name: 'Smaller text' }).click();
    await settings.getByRole('button', { name: 'Larger text' }).click();
    require(Number(await sizeSlider.inputValue()) === 20, 'Text size must change');
    await settings.getByRole('button', { name: 'Smaller text' }).click();
    await page.keyboard.press('Escape');
    require(await settings.isHidden(), 'Escape must dismiss Aa');
    require(await settingsButton.evaluate((el) => el === document.activeElement), 'Aa focus must return after Escape');
    await settingsButton.click();
    await settings.locator('input[value="light"]').check();
    if (size.height === 600) {
      await settings.getByRole('button', { name: 'Reader preferences' }).click();
      const preferences = page.locator('#reader-preferences');
      await preferences.waitFor({ state: 'visible' });
      await viewportFits(preferences, size.width, size.height, 'Reader preferences');
      require(await settings.isHidden(), 'Opening preferences must dismiss Aa');
      await page.keyboard.press('Escape');
      require(await preferences.isHidden(), 'Escape must dismiss reader preferences');
      require(await settingsButton.evaluate((element) => element === document.activeElement), 'Preferences focus must return to Aa');
    } else {
      await page.keyboard.press('Escape');
    }
  }

  await page.setViewportSize({ width: 390, height: 600 });
  await paragraph.scrollIntoViewIfNeeded();
  const word = paragraph.locator('text=Is there any knowledge').first();
  await word.click({ position: { x: 45, y: 10 } });
  const help = page.getByRole('dialog', { name: /^Meaning of / });
  await help.waitFor({ state: 'visible' });
  await viewportFits(help, 390, 600, 'Word help');
  require(await paragraph.isVisible(), 'Source passage must remain present while help is open');
  await page.keyboard.press('Escape');
  require(await help.isHidden(), 'Escape must dismiss word help');

  const selectionPoints = await paragraph.evaluate((element) => {
    const text = element.firstChild;
    const start = document.createRange();
    start.setStart(text, 0);
    start.setEnd(text, 1);
    const end = document.createRange();
    end.setStart(text, 28);
    end.setEnd(text, 29);
    return { start: start.getBoundingClientRect().toJSON(), end: end.getBoundingClientRect().toJSON() };
  });
  await page.mouse.move(selectionPoints.start.x + 2, selectionPoints.start.y + 17);
  await page.mouse.down();
  await page.mouse.move(selectionPoints.end.x + 8, selectionPoints.end.y + 17, { steps: 12 });
  await page.mouse.up();
  const selection = page.getByRole('toolbar', { name: /selected text/ });
  await selection.waitFor({ state: 'visible' });
  await viewportFits(selection, 390, 600, 'Selection actions');
  require((await page.evaluate(() => window.getSelection()?.toString() ?? '')).length > 10, 'Source passage must remain selected');
  require(await selection.getByRole('button', { name: 'Explain', exact: true }).evaluate((element) => element.getBoundingClientRect().height >= 44), 'Selection action must be touch sized');
  await page.screenshot({ path: '.playwright-cli/ux01-selection-390x600.png' });
  await page.keyboard.press('Escape');
  require(await selection.isHidden(), 'Escape must dismiss selection actions');
  require(await paragraph.evaluate((element) => element === document.activeElement), 'Focus must return to source passage');

  await page.mouse.move(12, 12);
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  const player = page.getByRole('region', { name: 'Read aloud', exact: true });
  await player.waitFor({ state: 'visible' });
  await viewportFits(player, 390, 600, 'Listening bar');
  await page.mouse.move(12, 12);
  await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
  await viewportFits(page.locator('#reading-settings'), 390, 600, 'Aa panel with listening bar');
  await page.keyboard.press('Escape');
  require(await player.isVisible(), 'Dismissing Aa must preserve listening');
  await player.getByRole('button', { name: 'Stop listening' }).click();

  return 'UX-01 controls: chapter opening, 390x844/390x600/desktop Aa themes, text change, Escape focus, word help, passage selection, and listening bar passed';
}
