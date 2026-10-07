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

  await page.unroute('**/api/books', shelf);
  assert(errors.length === 0, `Library page errors: ${errors.join('; ')}`);
  return { result: 'Resting on the Continue card title keeps the link under the pointer, with Where I left off on top', still };
}
