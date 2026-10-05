/**
 * Capture the final deliverable states for the report:
 *   1. panel overview (chart-first layout, large chart)
 *   2. hover interaction (readout for one sample)
 *   3. the tab's own gear settings
 *   4. narrow column (~360px) to show responsiveness
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { playwrightCookie } from './lib/auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const PW_ROOT = 'C:/Users/qq/Documents/merchant/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright';
const require = createRequire(join(PW_ROOT, 'index.js'));
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: 'zh-CN' });
await context.addCookies([playwrightCookie('127.0.0.1:3080')]);
const page = await context.newPage();

await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!window.__DSH_BOOT__, null, { timeout: 20000 });
await page.waitForTimeout(3500);
const exp = page.locator('[data-sidebar-right-expand="true"]').first();
if (await exp.count()) await exp.click({ timeout: 10000 });
await page.waitForTimeout(3000);

// Open the tab (persisted state may already have it open).
const inStrip = page.locator('[data-dockkit-strip] [data-dockkit-tab]', { hasText: /积分历史/ }).first();
if (await inStrip.count()) await inStrip.click({ timeout: 8000 });
else await page.locator('[data-sidebar-right-guide-entry="credit-history"]').first().click({ timeout: 8000 });
await page.waitForTimeout(2500);

const panel = page.locator('[data-sidebar-right-tab]').filter({ has: page.locator('svg') }).first();
await page.screenshot({ path: join(OUT, 'final-1-overview.png') });
console.log('captured overview');

// Hover the middle of the chart to exercise the nearest-sample readout.
const box = await panel.locator('svg').first().boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'final-2-hover.png') });
  const readout = await panel.evaluate(el => (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 260));
  console.log('hover readout:', readout);
}

// Narrow column: shrink the viewport so the sidebar gets less room.
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(1800);
await page.screenshot({ path: join(OUT, 'final-3-narrow.png') });
const narrow = await page.evaluate(() => {
  const body = [...document.querySelectorAll('[data-sidebar-right-tab]')].find(el => el.getBoundingClientRect().width > 0);
  const svg = body?.querySelector('svg');
  const text = (body?.innerText ?? '').replace(/\s+/g, ' ');
  return {
    bodyW: Math.round(body?.getBoundingClientRect().width ?? 0),
    svgW: Math.round(svg?.getBoundingClientRect().width ?? 0),
    svgH: Math.round(svg?.getBoundingClientRect().height ?? 0),
    leaks: ['NaN', 'undefined', 'Infinity'].filter(t => text.includes(t)),
  };
});
console.log('narrow:', JSON.stringify(narrow));
await browser.close();
console.log('done ->', OUT);
