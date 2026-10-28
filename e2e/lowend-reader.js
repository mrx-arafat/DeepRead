async (page) => {
  // Low-end phone reading check on a generated big book: 360x780 at DPR 2, touch, 6x CPU throttling.
  // Reports open time, scroll and page-turn frame times, long tasks, DOM and heap growth, and interaction latency,
  // so a change can be compared before and after. Numbers are machine-dependent; the shape of the growth is the point.
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ path: 'e2e/perf/lowend-probe.js' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  // The run-code sandbox has no `process`: the throttle and read length are constants here; edit them for a control run.
  const CPU_RATE = 6;
  const CHAPTERS = 10;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const link = page.locator('a.shelf-link').first();
  await link.waitFor();
  const bookHref = await link.getAttribute('href');
  const probe = (fn, ...args) => page.evaluate(([f, a]) => window.__lowend[f](...a), [fn, args]);
  // Scroll mode: open from the shelf, read ten chapters, then interact with ten chapters mounted.
  const open = await page.evaluate((href) => window.__lowend.open(document.querySelector(`a[href="${href}"]`)), bookHref);
  const idle = await probe('idle', 5000);
  const scroll = await probe('scroll', { chapters: CHAPTERS, step: 240 });
  const selection = await probe('selectText');
  await page.keyboard.press('Escape');
  const toPages = await probe('switchLayout', 'pages');
  const turns = await probe('turnPages', { chapters: 3, maxTurns: 150 });
  const toScroll = await probe('switchLayout', 'scroll');
  const jump = await probe('jump', 2);
  assert(open.openMs > 0 && scroll.chaptersPassed >= 2, `The reader did not flow through chapters: ${JSON.stringify({ open, scroll })}`);
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  const brief = (sample) => ({ chapter: sample.chapter, nodes: sample.nodes, heapMB: sample.heapMB, longTasks: sample.longTasks });
  return {
    status: 'LOWEND_READER_MEASURED',
    open: { openMs: open.openMs, longTasks: open.longTasks },
    idle: { longTasks: idle.longTasks, records: idle.records },
    scroll: { p50: scroll.p50, p95: scroll.p95, max: scroll.max, over50ms: scroll.over50ms, stalls: scroll.stalls, stallMs: scroll.stallMs, longTasks: scroll.longTasks, chaptersPassed: scroll.chaptersPassed, samples: scroll.samples.map(brief), end: brief({ chapter: 'end', ...scroll.end, longTasks: scroll.longTasks }) },
    // Reported, not asserted: headless runs have shown the bar not appearing for a scripted touch selection.
    selection: { ms: selection.ms, found: selection.found, longTasks: selection.longTasks },
    toPages: { switchedMs: toPages.switchedMs, longTasks: toPages.longTasks },
    turns: { p50: turns.p50, p95: turns.p95, max: turns.max, turns: turns.turns, longTasks: turns.longTasks },
    toScroll: { switchedMs: toScroll.switchedMs, longTasks: toScroll.longTasks },
    jump: { tocOpenMs: jump.tocOpenMs, jumpMs: jump.jumpMs, longTasks: jump.longTasks },
  };
}
