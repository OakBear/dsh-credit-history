import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreditHistory, makePoint, changeBetween } from '../lib/credit-history.js';

const entry = { id: 'account-a', nickname: '测试账号', credentialRef: 'secret-reference' };
const item = total => ({ accountId: entry.id, balance: { total, packages: [{ name: '资源包', unit: 'credits', remaining: total, active: true }], expiredTotal: 0 } });
function fixture(t, query) {
  const home = mkdtempSync(join(tmpdir(), 'credit-history-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let time = Date.parse('2026-10-01T02:00:00Z');
  const options = { home, accounts: async () => [entry], query, now: () => time, pause: async () => {} };
  return { history: new CreditHistory(options), options, advance: minutes => { time += minutes * 60000; }, home };
}

test('自动采样重复触发共享一次查询，冷却期与重启不发额外请求', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { ok: true, value: { accounts: [item(100)] } }; });
  await Promise.all([f.history.balances('qoder'), f.history.balances('qoder'), f.history.balances('qoder')]);
  assert.equal(calls, 1);
  const restarted = new CreditHistory(f.options);
  const cached = await restarted.balances('qoder');
  assert.equal(cached.value.accounts[0].balance.total, 100);
  assert.equal(calls, 1);
  f.advance(15);
  await restarted.balances('qoder');
  assert.equal(calls, 2);
  assert.equal(restarted.view('qoder').accounts[0].points.length, 2);
  assert.ok(!readFileSync(join(f.home, 'credit-history/history.json'), 'utf8').includes('secret-reference'));
});

test('五分钟设置持久化，非法间隔被拒绝', async t => {
  const f = fixture(t, async () => ({ ok: true, value: { accounts: [item(0)] } }));
  await f.history.configure({ intervalMinutes: 5, enabled: false });
  const restarted = new CreditHistory(f.options);
  assert.equal(restarted.state.intervalMinutes, 5);
  assert.equal(restarted.state.enabled, false);
  await assert.rejects(restarted.configure({ intervalMinutes: 1 }));
  await restarted.balances('buddy');
  assert.equal(restarted.view('buddy').accounts[0].points[0].total, 0);
});

test('余额失败保存缺口并退避，恢复时不跨失败点计算消耗', async t => {
  let calls = 0;
  const f = fixture(t, async () => ({ ok: true, value: { accounts: [++calls === 2 ? { accountId: entry.id, balance: null } : item(100 - calls)] } }));
  await f.history.balances('qoder');
  f.advance(15); await f.history.balances('qoder');
  f.advance(15); await f.history.balances('qoder'); assert.equal(calls, 2);
  f.advance(15); await f.history.balances('qoder'); assert.equal(calls, 3);
  const points = f.history.view('qoder').accounts[0].points;
  assert.equal(points[1].status, 'failed');
  assert.equal(points[2].change.kind, 'gap');
});

test('下降、赠送、周期变更、跨日与长缺口有不同语义', () => {
  const at = Date.parse('2026-10-01T02:00:00Z');
  const a = makePoint(item(100), at), b = makePoint(item(87.65), at + 15 * 60000);
  assert.deepEqual(changeBetween(a, b), { kind: 'usage', minutes: 15, amount: 12.35 });
  assert.equal(changeBetween(b, makePoint(item(120), at + 30 * 60000)).kind, 'increase');
  const changed = makePoint(item(90), at + 15 * 60000); changed.packages[0].cycle = '新周期';
  assert.equal(changeBetween(a, changed).kind, 'reset');
  assert.equal(changeBetween(a, makePoint(item(80), at + 45 * 60000)).kind, 'gap');
  const before = makePoint(item(100), Date.parse('2026-10-01T15:55:00Z'));
  const after = makePoint(item(80), Date.parse('2026-10-01T16:10:00Z'));
  assert.equal(changeBetween(before, after).kind, 'reset');
});

test('三十天外记录被清理，来源与账号互相隔离', async t => {
  const f = fixture(t, async () => ({ ok: true, value: { accounts: [item(100)] } }));
  await f.history.balances('buddy'); await f.history.balances('qoder');
  assert.equal(f.history.view('buddy').accounts.length, 1);
  assert.equal(f.history.view('qodercn').accounts.length, 0);
  f.advance(31 * 24 * 60);
  await f.history.balances('buddy');
  assert.equal(f.history.state.series['buddy/account-a'].points.length, 1);
  assert.equal(f.history.state.series['qoder/account-a'], undefined);
});

test('不支持的来源不会触发查询，暂停后定时器不查询', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { ok: true, value: { accounts: [] } }; });
  assert.equal((await f.history.balances('../x')).ok, false);
  const dispose = f.history.start(); dispose();
  await assert.rejects(f.history.balances('buddy'));
  assert.equal(calls, 0);
});

test('后台仅查询有账号的来源，全部串行并遵守周期', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const called = []; let active = 0, peak = 0;
  const f = fixture(t, async provider => {
    active++; peak = Math.max(peak, active); called.push(provider);
    await Promise.resolve(); active--;
    return { ok: true, value: { accounts: [item(100)] } };
  });
  f.history.accounts = async provider => ['buddy', 'qoder'].includes(provider) ? [entry] : [];
  const dispose = f.history.start(); t.after(dispose);
  t.mock.timers.tick(30000); await new Promise(setImmediate);
  assert.deepEqual(called, ['buddy', 'qoder']); assert.equal(peak, 1);
  t.mock.timers.tick(30000); await new Promise(setImmediate);
  assert.equal(called.length, 2);
  f.advance(15); t.mock.timers.tick(30000); await new Promise(setImmediate);
  assert.equal(called.length, 4);
  await f.history.configure({ enabled: false });
  f.advance(15); t.mock.timers.tick(30000); await new Promise(setImmediate);
  assert.equal(called.length, 4);
});
