async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(
    books.length === 1,
    "Use the illustrated book fixture in an isolated library",
  );
  const book = books[0];
  const detail = await (
    await page.request.get(`${origin}/api/books/${book.id}`)
  ).json();
  const chapterId = detail.chapters[0].id;
  const chapter = await (
    await page.request.get(
      `${origin}/api/books/${book.id}/chapters/${chapterId}`,
    )
  ).json();
  const figure = chapter.blocks.find((block) => block.type === "image");
  const code = chapter.blocks.find((block) => block.type === "code");
  assert(figure && code, "Parser must preserve the figure and code");
  await page.goto(`${origin}/book/${book.id}/${chapterId}`);
  const image = page.locator(".book-figure img");
  await image.waitFor();
  await image.scrollIntoViewIfNeeded();
  await image.evaluate((img) => img.decode());
  assert(
    await image.evaluate((img) => img.naturalWidth > 0),
    "Private figure asset must load",
  );
  const ordered = await page
    .locator(".chapter-text .row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        row.querySelector("figure") ? "figure" : row.textContent,
      ),
    );
  const at = ordered.indexOf("figure");
  assert(
    ordered[at - 1].includes("before the illustration") &&
      ordered.slice(at + 1, at + 3).some((text) => text.includes("after the illustration")),
    "Figure must stay between surrounding paragraphs",
  );
  assert(
    (await page.locator(".book-list-item").count()) === 2,
    "List items must stay separate",
  );
  const codeElement = page.locator(`[data-block="${code.id}"]`);
  assert(
    (await codeElement.textContent()) === code.text && code.text.includes("\n"),
    "Code must preserve newlines",
  );
  const styled = chapter.blocks.find((block) => block.text.includes("bold words"));
  const styledElement = page.locator(`[data-block="${styled.id}"]`);
  assert(await styledElement.textContent() === styled.text, "Inline formatting must preserve exact source text");
  assert(await styledElement.locator('span[style*="font-weight: 700"]').count() > 0, "Source bold text must render bold");
  assert(await styledElement.locator('span[style*="font-style: italic"]').count() > 0, "Source italic text must render italic");
  const proseAlignment = await styledElement.evaluate((el) => {
    const root = document.documentElement; const prior = root.dataset.align;
    root.dataset.align = "justify"; const aligned = getComputedStyle(el).textAlign;
    if (prior === undefined) delete root.dataset.align; else root.dataset.align = prior;
    return aligned;
  });
  assert(proseAlignment === "justify", "Reading alignment preferences must remain effective on source-styled text");
  const table = chapter.blocks.find((block) => block.type === "table");
  assert(table && await page.locator(`[data-block="${table.id}"] table`).count() === 1, "Aligned source cells must become a table");
  assert(await page.locator(`[data-block="${table.id}"]`).textContent() === table.text, "Table cells must preserve text offsets");
  const caption = chapter.blocks.find((block) => block.format === "caption");
  assert(caption?.text === "Figure 1. A blue illustration", "Caption must remain separate from surrounding prose");
  assert(caption && await page.locator(`[data-block="${caption.id}"]`).evaluate((el) => getComputedStyle(el).fontStyle === "italic"), "Printed caption emphasis must survive");
  await styledElement.scrollIntoViewIfNeeded();
  const selected = await styledElement.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const offset = el.textContent.indexOf("bold words");
    let before = 0; let start;
    for (const node of nodes) { if (offset < before + node.length) { start = { node, offset: offset - before }; break; } before += node.length; }
    const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(nodes.at(-1), nodes.at(-1).length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    return { offset, text: range.toString() };
  });
  await page.getByRole("toolbar", { name: "Explain, highlight, or reflect on selected text" }).getByRole("button", { name: "Highlight in yellow" }).click();
  await page.getByRole("banner").getByRole("status", { name: "Notes saved", exact: true }).waitFor();
  const notes = await (await page.request.get(`${origin}/api/books/${book.id}/notes`)).json();
  assert(notes.some((note) => note.blockId === styled.id && note.offset === selected.offset && note.quote === selected.text), "Highlight across style spans must save global source offsets");
  await page.getByRole("button", { name: "Original pages", exact: true }).click();
  const original = page.getByRole("dialog", { name: "Original page 1 of 1" });
  const originalImage = original.getByRole("img", { name: "Original printed page 1" });
  await originalImage.waitFor({ state: "visible" }); await originalImage.evaluate((img) => img.decode());
  assert(await originalImage.evaluate((img) => img.naturalHeight > 1000), "Original page must render with full source layout");
  const sourceWord = original.locator("[data-source-text-run]").filter({ hasText: "Read the" }).first();
  await sourceWord.waitFor({ state: "visible" });
  const sourceGeometry = await sourceWord.evaluate((span) => {
    const image = span.closest("dialog").querySelector("img");
    const imageRect = image.getBoundingClientRect(), textRect = span.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { text: selection.toString(), x: (textRect.left - imageRect.left) / imageRect.width, y: (textRect.top - imageRect.top) / imageRect.height, width: textRect.width / imageRect.width, color: getComputedStyle(span).color };
  });
  assert(sourceGeometry.text.trim() === "Read the", "Words must be selectable directly over the printed image");
  assert(Math.abs(sourceGeometry.x - 50 / 612) < 0.005 && sourceGeometry.y > 0.02 && sourceGeometry.y < 0.05, "Selectable words must align with their source position");
  assert(sourceGeometry.color === "rgba(0, 0, 0, 0)", "Text overlay must preserve the printed appearance");
  assert(await sourceWord.evaluate((span) => {
    const rect = span.getBoundingClientRect();
    const caret = document.caretRangeFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return caret && span.contains(caret.startContainer);
  }), "Pointer selection must reach the text over the image");
  await original.getByRole("button", { name: "Zoom original page" }).click();
  assert(await originalImage.evaluate((img) => img.getBoundingClientRect().width > img.closest(".original-page-image").clientWidth), "Original page zoom must allow detail inspection");
  const zoomGeometry = await sourceWord.evaluate((span) => {
    const imageRect = span.closest("dialog").querySelector("img").getBoundingClientRect(), textRect = span.getBoundingClientRect();
    return { x: (textRect.left - imageRect.left) / imageRect.width, width: textRect.width / imageRect.width };
  });
  assert(Math.abs(zoomGeometry.x - sourceGeometry.x) < 0.002 && Math.abs(zoomGeometry.width - sourceGeometry.width) < 0.002, "Selectable text must stay aligned while zooming");
  await page.keyboard.press("Escape");
  assert(await page.getByRole("button", { name: "Original pages", exact: true }).evaluate((button) => button === document.activeElement), "Original page closes back to its trigger");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const layout of ["scroll", "pages"]) {
      await page
        .getByRole("button", { name: "Reading settings", exact: true })
        .click();
      await page.locator(`#reading-settings input[value="${layout}"]`).check();
      await page.keyboard.press("Escape");
      await image.scrollIntoViewIfNeeded();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Book content must fit the viewport",
      );
      assert(
        await image.evaluate(
          (img) => img.getBoundingClientRect().width <= innerWidth,
        ),
        "Figure must fit the viewport",
      );
    }
  }
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  await page.getByRole("button", { name: "Reading settings", exact: true }).click();
  await page.locator('#reading-settings input[value="scroll"]').check(); await page.keyboard.press("Escape");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: ".playwright-cli/pdf-content.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Original pages", exact: true }).click();
  const phoneOriginal = page.getByRole("dialog", { name: "Original page 1 of 1" });
  await phoneOriginal.getByRole("img", { name: "Original printed page 1" }).waitFor({ state: "visible" });
  assert(await phoneOriginal.getByRole("img").evaluate((img) => img.getBoundingClientRect().width <= img.closest(".original-page-image").clientWidth), "Reopened original pages must start fitted to the phone");
  const phoneWord = phoneOriginal.locator("[data-source-text-run]").filter({ hasText: "Read the" }).first();
  await phoneWord.waitFor({ state: "visible" });
  assert(await phoneWord.evaluate((span) => {
    const imageRect = span.closest("dialog").querySelector("img").getBoundingClientRect(), textRect = span.getBoundingClientRect();
    return Math.abs((textRect.left - imageRect.left) / imageRect.width - 50 / 612) < 0.005 && textRect.right <= imageRect.right;
  }), "Selectable words must stay on the printed image on a phone");
  assert(await phoneOriginal.evaluate((dialog) => dialog.getBoundingClientRect().width <= innerWidth), "Original page controls must fit a phone");
  await page.screenshot({ path: ".playwright-cli/pdf-original-phone.png" });
  await page.keyboard.press("Escape");
  return "PDF_CONTENT_CHECKS_PASSED";
}
