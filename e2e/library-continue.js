async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = await page.evaluate(() => location.origin);
  const books = await (await page.request.get(`${origin}/api/books`)).json();
  assert(books.length === 1, 'Use a fresh isolated library with the Gutenberg fixture');
  const book = books[0];
  assert((await page.request.put(`${origin}/api/books/${book.id}/progress`, { data: { chapterId: 'c3', blockId: 'c3-b3', offset: 120 } })).ok(), 'Could not prepare a reading place');
  // The full Continue card, with its title, shows only beside other books: one more on the shelf, from the response alone.
  const shelf = async (route) => {
    const response = await route.fetch();
    const listed = await response.json();
    const other = { ...listed[0], id: 'fixture-continue-other', title: 'Another Fixture Book', progress: null };
    await route.fulfill({ response, body: JSON.stringify([...listed, other]) });
  };
  await page.route('**/api/books', shelf);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin);
  const title = page.locator('.continue-card .continue-title');
  await title.waitFor();

  // Rest the pointer on the title. The whole card is the Continue link, so the link must stay under it, frame after frame:
  // a hover style that changed the link's box once made it and the title swap places every frame, and the cursor blinked.
  const box = await title.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  const still = await page.evaluate(async ({ x, y }) => {
    const link = document.querySelector('.continue-card .continue-action');
    let changes = 0;
    const count = () => { changes += 1; };
    document.addEventListener('mouseover', count, true);
    const hits = [];
    for (let frame = 0; frame < 30; frame++) {
      hits.push(link.contains(document.elementFromPoint(x, y)));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    document.removeEventListener('mouseover', count, true);
    return { onLink: hits.filter(Boolean).length, frames: hits.length, changes };
  }, { x: box.x + 40, y: box.y + box.height / 2 });
  assert(still.onLink === still.frames, `The Continue link must stay under a resting pointer (${still.onLink}/${still.frames} frames)`);
  assert(still.changes === 0, `A resting pointer must not keep changing what it is over (${still.changes} changes)`);

  // The card-wide link must not swallow the card's other action.
  const context = page.getByRole('button', { name: 'Where I left off' });
  const contextBox = await context.boundingBox();
  const contextOnTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.continue-context') !== null,
    { x: contextBox.x + contextBox.width / 2, y: contextBox.y + contextBox.height / 2 });
  assert(contextOnTop, 'Where I left off must stay clickable above the card-wide link');

  const resume = page.getByRole('dialog', { name: 'Where I left off', exact: true });
  const spacing = [];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 360 }]) {
    await page.setViewportSize(viewport);
    await context.click();
    const emptyHighlight = resume.getByText('No saved highlight before this place in this chapter.', { exact: true });
    await emptyHighlight.waitFor();
    const continueReading = resume.getByRole('link', { name: 'Continue', exact: true });
    await continueReading.scrollIntoViewIfNeeded();
    const messageBox = await emptyHighlight.boundingBox();
    const actionBox = await continueReading.boundingBox();
    const dialogBox = await resume.boundingBox();
    const gap = actionBox.y - (messageBox.y + messageBox.height);
    assert(gap >= 16, `Resume message needs at least 16px before Continue at ${viewport.width}px (got ${gap}px)`);
    assert(actionBox.height >= 44, `Continue needs a 44px touch target at ${viewport.width}px`);
    assert(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= viewport.width && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= viewport.height,
      `Resume dialog must fit ${viewport.width}x${viewport.height}`);
    assert(actionBox.y >= dialogBox.y && actionBox.y + actionBox.height <= dialogBox.y + dialogBox.height,
      `Continue must be reachable inside the scrolled dialog at ${viewport.width}px`);
    const overflow = await resume.evaluate(el => ({ dialog: el.scrollWidth > el.clientWidth, page: document.documentElement.scrollWidth > innerWidth, scrolling: el.scrollHeight > el.clientHeight }));
    assert(!overflow.dialog && !overflow.page, `Resume dialog must not overflow horizontally at ${viewport.width}px`);
    if (viewport.width === 320) assert(overflow.scrolling, 'The short mobile viewport must exercise dialog scrolling');
    spacing.push({ width: viewport.width, gap, targetHeight: actionBox.height, scrolling: overflow.scrolling });
    await page.keyboard.press('Escape');
    await resume.waitFor({ state: 'hidden' });
  }

  await page.unroute('**/api/books', shelf);
  assert(errors.length === 0, `Library page errors: ${errors.join('; ')}`);
  return { result: 'Continue card stays under the pointer; resume actions have space and fit desktop and mobile dialogs', still, spacing };
}
