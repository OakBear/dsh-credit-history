/**
 * Repair the tab-enable state (an earlier probe accidentally clicked the card's
 * enable toggle instead of its gear) and then verify the tab's own gear panel.
 *
 * Card anatomy (dsh-better-sidebar SideCardSection.tsx):
 *   button.cardMain     -> enable/disable toggle (aria-pressed mirrors state)
 *   button.cardSettings -> gear, ONLY rendered while the tab is enabled
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

const results = [];
const check = (id, name, pass, evidence) => {
  results.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}`);
  if (!pass) console.log('      evidence:', JSON.stringify(evidence).slice(0, 700));
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: 'zh-CN' });
await context.addCookies([playwrightCookie('127.0.0.1:3080')]);
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

/** Read the credit card's live state from the open settings dialog. */
const readCard = () => page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]');
  for (const el of dlg.querySelectorAll('div')) {
    if (!/(^|\s)_[a-z0-9]+_card(\s|$)/.test(String(el.className ?? ''))) continue;
    if ((el.querySelector('[class*="cardTitle"]')?.innerText?.trim() ?? '') !== '积分历史') continue;
    const main = el.querySelector('button[class*="cardMain"]');
    const gear = el.querySelector('button[class*="cardSettings"]');
    return {
      enabled: main?.getAttribute('aria-pressed') === 'true',
      hasGear: !!gear,
      gearAria: gear?.getAttribute('aria-label') ?? null,
      cardClass: String(el.className ?? ''),
    };
  }
  return null;
});

try {
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.__DSH_BOOT__, null, { timeout: 20000 });
  await page.waitForTimeout(3500);
  await page.locator('button[aria-label="设置"]').first().click({ timeout: 10000 });
  await page.waitForTimeout(2000);
  await page.locator('[role="dialog"] button', { hasText: /^侧边卡片$/ }).first().click({ timeout: 8000 });
  await page.waitForTimeout(2500);

  let card = await readCard();
  console.log('initial card state:', JSON.stringify(card));

  // ---- repair: re-enable the tab if a probe left it off --------------------
  if (card && !card.enabled) {
    await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      for (const el of dlg.querySelectorAll('div')) {
        if (!/(^|\s)_[a-z0-9]+_card(\s|$)/.test(String(el.className ?? ''))) continue;
        if ((el.querySelector('[class*="cardTitle"]')?.innerText?.trim() ?? '') !== '积分历史') continue;
        el.querySelector('button[class*="cardMain"]')?.click();
        return;
      }
    });
    await page.waitForTimeout(2000);
    card = await readCard();
    console.log('after repair:', JSON.stringify(card));
  }
  check('R1', '「积分历史」Tab 处于启用状态', card?.enabled === true, card);

  // ---- the gear must exist while enabled ----------------------------------
  check('G1', '启用后卡片出现齿轮（功能设置）按钮', card?.hasGear === true,
    { hasGear: card?.hasGear, gearAria: card?.gearAria });

  if (card?.hasGear) {
    await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      for (const el of dlg.querySelectorAll('div')) {
        if (!/(^|\s)_[a-z0-9]+_card(\s|$)/.test(String(el.className ?? ''))) continue;
        if ((el.querySelector('[class*="cardTitle"]')?.innerText?.trim() ?? '') !== '积分历史') continue;
        el.querySelector('button[class*="cardSettings"]')?.click();
        return;
      }
    });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: join(OUT, 'gear-open.png') });

    const popup = await page.evaluate(() => {
      // The gear popup is the topmost layer; scan the whole document for our rows.
      const text = document.body.innerText;
      const hasToggle = /后台记录/.test(text);
      const hasInterval = /采样间隔/.test(text);
      const i = text.indexOf('后台记录');
      // Find the select whose options are the sampling intervals.
      const intervalSelect = [...document.querySelectorAll('select')]
        .find(s => [...s.options].some(o => o.value === '15') && [...s.options].some(o => o.value === '5'));
      const toggle = [...document.querySelectorAll('input[type="checkbox"]')]
        .find(box => box.closest('div,label,section')?.innerText?.includes('后台记录'));
      return {
        hasToggle, hasInterval,
        intervalOptions: intervalSelect ? [...intervalSelect.options].map(o => `${o.text.trim()}:${o.value}`) : null,
        intervalValue: intervalSelect?.value ?? null,
        toggleChecked: toggle ? toggle.checked : null,
        around: i >= 0 ? text.slice(i - 60, i + 260).replace(/\s+/g, ' ') : null,
      };
    });
    writeFileSync(join(OUT, 'gear-panel.json'), JSON.stringify(popup, null, 2));
    check('G2', '齿轮面板含「后台记录」开关', popup.hasToggle, popup);
    check('G3', '齿轮面板含「采样间隔」5/15 分钟选项', popup.hasInterval && (popup.intervalOptions?.length ?? 0) === 2, popup);
    check('G4', '开关状态来自后端（非硬编码默认）', popup.toggleChecked !== null, { toggleChecked: popup.toggleChecked });
  }

  // ---- the tab is back in the guide list ----------------------------------
  // Close the gear popup AND the settings dialog first: the dialog covers the
  // sidebar's expand button, so clicking it while the dialog is open times out.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const closeBtn = page.locator('[role="dialog"] button[aria-label="关闭"]').first();
  if (await closeBtn.count()) { await closeBtn.click({ timeout: 8000 }).catch(() => {}); }
  await page.waitForTimeout(900);
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }).catch(() => {});

  const exp = page.locator('[data-sidebar-right-expand="true"]').first();
  if (await exp.count()) await exp.click({ timeout: 8000 });
  await page.waitForTimeout(2500);
  const guide = await page.evaluate(() => [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map(e => e.getAttribute('data-sidebar-right-guide-entry')));
  check('R2', '修复后右侧栏重新出现 credit-history 入口', guide.includes('credit-history'), { guide });
  await page.screenshot({ path: join(OUT, 'gear-restored.png') });

  check('C1', '控制台无错误', errors.length === 0, { errors: errors.slice(0, 6) });
} catch (error) {
  check('X', '脚本异常', false, { error: String(error).slice(0, 400) });
  await page.screenshot({ path: join(OUT, 'gear-crash.png') }).catch(() => {});
} finally {
  writeFileSync(join(OUT, 'gear-report.json'), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) console.log('failed:', failed.map(f => f.id).join(', '));
process.exit(failed.length ? 1 : 0);
