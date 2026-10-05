/**
 * GREEN acceptance test for the credit-history sidebar migration.
 *
 * Asserts BOTH halves of the move the user asked for:
 *   A. 积分历史 is now a RIGHT-SIDEBAR tab (clickable, renders the chart-first panel)
 *   B. 积分历史 is GONE from Settings (the section entry was deleted, not copied)
 *
 * Reuses the durable-cookie auth helper (the launch token dies on every restart).
 *
 * Run:  node accept.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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

const BASE = 'http://127.0.0.1:3080/';
const AUTHORITY = '127.0.0.1:3080';

const results = [];
const check = (id, name, pass, evidence) => {
  results.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}`);
  if (!pass) console.log('      evidence:', JSON.stringify(evidence).slice(0, 600));
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: 'zh-CN' });
await context.addCookies([playwrightCookie(AUTHORITY)]);
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.__DSH_BOOT__, null, { timeout: 20000 });
  await page.waitForTimeout(3500);

  // ---- expand the right sidebar -------------------------------------------
  const expand = page.locator('[data-sidebar-right-expand="true"]').first();
  if (await expand.count()) await expand.click({ timeout: 10000 });
  await page.waitForTimeout(3000);

  // ---- A1: is the tab registered? ----------------------------------------
  // The sidebar PERSISTS its open tabs across sessions, so the tab may already
  // be in the strip (and no guide list is rendered). Both surfaces are the same
  // registration; assert on whichever is present, preferring the strip.
  const stripTab = page.locator('[data-dockkit-strip] [data-dockkit-tab]', { hasText: /积分历史/ }).first();
  const guideEntry = page.locator('[data-sidebar-right-guide-entry="credit-history"]').first();
  const inStrip = await stripTab.count() > 0;
  const inGuide = await guideEntry.count() > 0;
  const guide = await page.evaluate(() => ({
    entries: [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map(el => ({
      kind: el.getAttribute('data-sidebar-right-guide-entry'),
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim(),
    })),
    strip: [...document.querySelectorAll('[data-dockkit-strip] [data-dockkit-tab]')].map(el => (el.innerText ?? '').replace(/\s+/g, ' ').trim()),
  }));
  writeFileSync(join(OUT, 'accept-guide.json'), JSON.stringify({ ...guide, inStrip, inGuide }, null, 2));
  const entry = guide.entries.find(e => e.kind === 'credit-history');
  check('A1', '右侧栏存在 credit-history 入口', inStrip || !!entry, { inStrip, inGuide, guide: guide.entries.map(e => e.kind), strip: guide.strip });
  check('A2', '入口标题为「积分历史」', inStrip ? guide.strip.some(t => t.includes('积分历史')) : entry?.text?.includes('积分历史') === true,
    { strip: guide.strip, text: entry?.text });

  // ---- A2: open it and inspect the rendered panel -------------------------
  let panel = null;
  if (inStrip || entry) {
    if (inStrip) await stripTab.click({ timeout: 10000 });
    else await guideEntry.click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    panel = await page.evaluate(() => {
      // `[data-sidebar-right-tab]` is emitted TWICE: an invisible title span and
      // the real panel div. Pick the laid-out one.
      const body = [...document.querySelectorAll('[data-sidebar-right-tab]')]
        .find(el => el.getBoundingClientRect().width > 0) ?? null;
      const svg = body?.querySelector('svg');
      const text = (body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      return {
        text: text.slice(0, 700),
        hasSvg: !!svg,
        svgLabel: svg?.getAttribute('aria-label') ?? null,
        svgBox: svg ? (() => { const r = svg.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null,
        // The chart claims to be responsive: it must fill its column, not clip.
        panelBox: body ? (() => { const r = body.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null,
        scrolls: body ? body.scrollHeight > body.clientHeight : null,
        hasDetails: !!body?.querySelector('details'),
        selects: [...(body?.querySelectorAll('select') ?? [])].map(s => s.getAttribute('aria-label')),
        // Any of these leaking into the DOM means a formatter hit bad data.
        leaks: ['NaN', 'undefined', 'Infinity'].filter(t => text.includes(t)),
      };
    });
    await page.screenshot({ path: join(OUT, 'accept-panel.png') });
    check('A3', '选中后渲染出面板（含 SVG 走势图）', panel.hasSvg, panel);
    check('A4', '走势图填满侧栏列宽（响应式自适应）', (panel.svgBox?.[0] ?? 0) > 200, { svgBox: panel.svgBox, panelBox: panel.panelBox });
    check('A5', '面板文案无 NaN/undefined/Infinity', panel.leaks.length === 0, { leaks: panel.leaks, text: panel.text });
    check('A6', '面板提供来源/范围/刷新控件', panel.selects.length >= 1 && panel.text.includes('刷新'), { selects: panel.selects, text: panel.text.slice(0, 200) });
    check('A7', '明细表默认折叠（details 存在）', panel.hasDetails, { hasDetails: panel.hasDetails });
  } else {
    await page.screenshot({ path: join(OUT, 'accept-panel-missing.png') });
  }

  // ---- B: Settings must no longer list 积分历史 ---------------------------
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.locator('button[aria-label="设置"]').first().click({ timeout: 10000 });
  await page.waitForTimeout(2000);
  const nav = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return {
      cells: [...(dlg?.querySelectorAll('button') ?? [])]
        .filter(b => { const r = b.getBoundingClientRect(); return r.x < 600 && r.width > 100 && r.width < 220 && r.height > 30 && r.height < 50; })
        .map(b => (b.innerText ?? '').trim()),
      dialogHead: (dlg?.innerText ?? '').slice(0, 500),
    };
  });
  writeFileSync(join(OUT, 'accept-settings-nav.json'), JSON.stringify(nav, null, 2));
  await page.screenshot({ path: join(OUT, 'accept-settings.png') });
  check('B1', '设置导航不再出现「积分历史」', !nav.cells.some(c => c.includes('积分历史')), { cells: nav.cells });

  // ---- B2: better-sidebar's own card list should show the tab -------------
  const cardNav = page.locator('[role="dialog"] button', { hasText: /^侧边卡片$/ }).first();
  if (await cardNav.count()) {
    await cardNav.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    const cards = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return { text: (dlg?.innerText ?? '').slice(0, 3000), mentions: /积分历史/.test(dlg?.innerText ?? '') };
    });
    writeFileSync(join(OUT, 'accept-cards.json'), JSON.stringify(cards, null, 2));
    await page.screenshot({ path: join(OUT, 'accept-cards.png') });
    check('B2', '侧边卡片页登记了「积分历史」Tab', cards.mentions, { mentions: cards.mentions, text: cards.text.slice(0, 400) });
  }

  check('C1', '浏览器控制台无错误', errors.length === 0, { errors: errors.slice(0, 8) });
} catch (error) {
  check('X', '脚本异常', false, { error: String(error).slice(0, 500) });
  await page.screenshot({ path: join(OUT, 'accept-crash.png') }).catch(() => {});
} finally {
  writeFileSync(join(OUT, 'accept-report.json'), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) console.log('failed:', failed.map(f => f.id).join(', '));
process.exit(failed.length ? 1 : 0);
