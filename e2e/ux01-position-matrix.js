async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0];
  if (!origin) throw new Error("Open the isolated reader before running this check");
  const bookId = "the-problems-of-philosophy-8c4e7684";
  const blockId = "c3-b3";
  const offset = 450;
  await page.evaluate(() => localStorage.removeItem("deepread.prefs"));
  const require = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const anchor = async () => page.evaluate(({ blockId, offset }) => {
    const block = document.querySelector(`[data-block="${blockId}"]`);
    const text = block?.firstChild;
    if (!(text instanceof Text)) throw new Error("Fixture paragraph is missing");
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    const rect = range.getBoundingClientRect();
    const top = document.documentElement.dataset.layout === "pages"
      ? (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 2
      : 96;
    return { y: rect.top, eye: top, lineHeight: parseFloat(getComputedStyle(block).lineHeight),
      block: block.dataset.block, chapter: block.closest("[data-chapter]")?.getAttribute("data-chapter") };
  }, { blockId, offset });
  const settle = async () => {
    await page.waitForFunction(() => {
      const place = history.state?.place;
      return place?.chapterId === "c3" && place?.blockId === "c3-b3";
    }, null, { timeout: 5000 });
  };
  const check = async (label, tolerance = 2) => {
    const current = await anchor();
    require(current.chapter === "c3" && current.block === blockId, `${label}: fixture anchor changed`);
    require(Math.abs(current.y - current.eye) <= current.lineHeight * tolerance,
      `${label}: character left reading line (${JSON.stringify(current)})`);
    await settle();
    await page.waitForTimeout(350); // History is intentionally updated after scrolling settles.
    const place = await page.evaluate(() => history.state.place);
    require(Math.abs(place.offset - offset) <= 130,
      `${label}: saved offset drifted from passage (${JSON.stringify(place)})`);
    return current;
  };
  const appearance = page.locator("#reading-settings");
  const open = async () => {
    await page.mouse.move(12, 12);
    await page.getByRole("button", { name: "Reading settings", exact: true }).click();
    await appearance.waitFor({ state: "visible" });
  };
  const change = async (label, action) => {
    await open();
    await action();
    await page.keyboard.press("Escape");
    require(await appearance.isHidden(), `${label}: Aa did not close`);
    await check(label);
  };
  const switchLayout = async (label, layout) => {
    await settle();
    await page.waitForTimeout(350); // Compare positions after the prior reflow's history debounce.
    const before = await page.evaluate(() => history.state.place);
    await open();
    await appearance.locator(`input[value="${layout}"]`).check();
    await page.keyboard.press("Escape");
    await page.waitForFunction((value) => document.documentElement.dataset.layout === value, layout);
    await page.waitForTimeout(350); // Position history is intentionally debounced after a reader scroll.
    const after = await page.evaluate(() => history.state.place);
    require(after?.chapterId === before.chapterId && after?.blockId === before.blockId,
      `${label}: changed reading block (${JSON.stringify({ before, after })})`);
    require(Math.abs(after.offset - before.offset) <= 70,
      `${label}: changed the logical reading line (${JSON.stringify({ before, after })})`);
  };

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/book/${bookId}/c3`);
    await page.locator(`[data-block="${blockId}"]`).waitFor();
    const tip = page.getByRole("button", { name: "Dismiss tip" });
    if (await tip.isVisible()) await tip.click();
    for (const layout of ["scroll", "pages"]) {
      if (layout === "scroll") {
        await open();
        await appearance.locator('input[value="scroll"]').check();
        await page.keyboard.press("Escape");
      } else {
        await switchLayout(`${width}px Scroll to Pages`, "pages");
      }
      await page.evaluate(({ blockId, offset }) => {
        const block = document.querySelector(`[data-block="${blockId}"]`);
        const text = block?.firstChild;
        if (!(text instanceof Text)) throw new Error("Fixture paragraph is missing");
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        const eye = document.documentElement.dataset.layout === "pages"
          ? (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 2
          : 96;
        window.scrollBy({ top: range.getBoundingClientRect().top - eye, behavior: "instant" });
      }, { blockId, offset });
      await check(`${width}px ${layout} initial`);
      await change(`${width}px ${layout} font reset`, () => appearance.locator('input[value="serif"]').check());
      await change(`${width}px ${layout} font`, () => appearance.locator('input[value="sans"]').check());
      await change(`${width}px ${layout} size`, () => appearance.getByRole("button", { name: "Larger text" }).click());
      await change(`${width}px ${layout} measure reset`, () => appearance.locator('input[value="normal"][name="reading-settings-margins"]').check());
      await change(`${width}px ${layout} measure`, () => appearance.locator('input[value="wide"]').check());
      await page.setViewportSize({ width: width === 390 ? 430 : 1200, height: 844 });
      await check(`${width}px ${layout} resize`, 3);
      await page.reload();
      await page.locator(`[data-block="${blockId}"]`).waitFor();
      await check(`${width}px ${layout} reload`, 4);
      await page.setViewportSize({ width, height: 844 });
    }
    await switchLayout(`${width}px Pages to Scroll`, "scroll");
  }
  return "UX-01: logical paragraph position survived font, size, measure, resize and reload in Scroll/Pages at phone and desktop widths";
}
