import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { CreditHistory } from '../lib/credit-history.js';
import { registerHistoryRpc, apply } from '../lib/index.js';
import { createBalanceReader, loadBalanceModules } from '../lib/balance-reader.js';

test('已有历史完整迁移到独立目录，旧文件不改写', t => {
  const home = mkdtempSync(join(tmpdir(), 'history-migration-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = { version: 1, enabled: true, intervalMinutes: 5, attempts: {}, failures: {}, series: {
    'qoder/a': { provider: 'qoder', accountId: 'a', nickname: '旧账号', points: [{ at: Date.now(), status: 'ok', total: 42, packages: [] }] },
  } };
  mkdirSync(join(home, 'jet-hub'));
  const raw = JSON.stringify(old); writeFileSync(join(home, 'jet-hub/credit-history.json'), raw);
  const history = new CreditHistory({ home, accounts: async () => [], query: async () => { throw new Error('不能查询'); } });
  assert.equal(history.view('qoder').accounts[0].points[0].total, 42);
  assert.equal(history.state.intervalMinutes, 5);
  assert.equal(readFileSync(join(home, 'jet-hub/credit-history.json'), 'utf8'), raw);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'credit-history/history.json'), 'utf8')), old);
});

test('独立 API 只读取本机历史，没有手动查询上游入口', async () => {
  let endpoint, reads = 0;
  registerHistoryRpc({ fetch: { register: spec => { endpoint = spec; } } }, { view: () => { reads++; return { accounts: [] }; } });
  assert.equal(endpoint.path, '/api/credit-history');
  const call = async method => (await (await endpoint.fetch(new Request('http://localhost/api/credit-history', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'credit-history', payload: { method, payload: {} } }),
  }))).json()).result;
  assert.equal((await call('history.read')).ok, true);
  assert.equal((await call('credits.balances')).ok, false);
  assert.equal(reads, 1);
});

/**
 * A hook-free React stand-in. The client bundle keeps `react` external and
 * resolves it through the module loader, so a the test can inject this and then
 * call components directly: every hook returns an inert value and the whole
 * render path still executes (a crash, a bad helper reference, or a `NaN`
 * formatter surfaces without needing a browser).
 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol('react.fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: fn => fn(),
  useCallback: fn => fn,
};

/** Load the BUILT bundle exactly as the browser shell does, and expose what it registered. */
function loadClient() {
  let client;
  const registered = [], settingsSections = [], disposers = [];
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => {
      client = module.factory(spec => {
        if (spec === 'react') return fakeReact;
        throw new Error(`客户端只应依赖 react，实际请求了 ${spec}`);
      });
    } } },
  });
  assert.ok(client, 'client.js 必须通过 __ModuleLoader__ 注册模块');
  return { client, module: client, registered, settingsSections, disposers };
}

/**
 * A minimal cordis-shaped context. `inject(services, cb)` only calls back when
 * the service exists (like cordis), hands the callback a SCOPE carrying the
 * service plus `effect()`, and `effect` immediately runs its body and collects
 * the returned disposer — so a test can assert both registration and unmount.
 */
function fakeClientContext({ registered, settingsSections, disposers }) {
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    // Kept as a tripwire: the plugin must never register a Settings section again.
    slots: {
      inject: (_name, fn) => fn(),
      register: spec => { if (spec?.name === 'settings.section') settingsSections.push(spec); return () => {}; },
    },
  };
  ctx.inject = (services, callback) => {
    const wanted = Array.isArray(services) ? services : [services];
    // A missing service must NOT run the body — that is the whole point of inject.
    if (!wanted.includes('betterSidebar')) return;
    const scope = { ...ctx, betterSidebar: { registerTab: spec => { registered.push(spec); return () => { spec.disposed = true; }; } } };
    scope.effect = execute => { disposers.push(execute()); return () => {}; };
    callback(scope);
  };
  ctx.effect = execute => { disposers.push(execute()); return () => {}; };
  return ctx;
}

test('客户端注册右侧边栏 Tab，且完全不再注册设置页入口', () => {
  const { client, registered, settingsSections, disposers } = loadClient();
  // `client` was created inside the vm context, so its arrays are cross-realm:
  // spread them into this realm's Array before a strict deep-equal.
  assert.deepEqual([...client.inject], ['connection', 'betterSidebar']);
  client.apply(fakeClientContext({ client, registered, settingsSections, disposers }));

  // The sidebar tab is the ONE surface: correct id/title, single instance, and
  // a gear panel so the sampler controls live with the data.
  assert.equal(registered.length, 1);
  const [tab] = registered;
  assert.equal(tab.id, 'credit-history');
  assert.equal(tab.title, '积分历史');
  assert.equal(tab.single, true);
  assert.equal(typeof tab.component, 'function');
  assert.equal(typeof tab.settings?.render, 'function');

  // The migration is a MOVE, not a copy: the Settings section is gone.
  assert.deepEqual(settingsSections, []);

  // Registration rides ctx.effect, so disposing the plugin unmounts the tab.
  assert.equal(disposers.length, 1);
  disposers.forEach(fn => fn());
});

test('边栏面板与齿轮设置共用本机 RPC 桥，调用失败会抛出可读错误', async () => {
  const loaded = loadClient();
  const calls = [];
  const ctx = fakeClientContext(loaded);
  ctx.connection.rpc = { call: async (path, name, body) => { calls.push({ path, name, body }); return { ok: true, value: { accounts: [] } }; } };
  loaded.client.apply(ctx);

  // Both surfaces must reach the host through the SAME bridge, on the plugin's
  // own endpoint — a new UI must not grow a second, differently-shaped channel.
  const tabBridge = loaded.registered[0].component({ visible: true }).props.rpcCall;
  const gearBridge = loaded.registered[0].settings.render().props.rpcCall;
  assert.equal(typeof tabBridge, 'function');
  assert.equal(typeof gearBridge, 'function');

  await gearBridge('history.configure', { enabled: true, intervalMinutes: 5 });
  await tabBridge('history.read', { provider: 'qodercn', hours: 24 });
  assert.deepEqual(calls.map(c => [c.path, c.name, c.body.method]), [
    ['/api', 'credit-history', 'history.configure'],
    ['/api', 'credit-history', 'history.read'],
  ]);
  assert.deepEqual(calls[0].body.payload, { enabled: true, intervalMinutes: 5 });
  assert.equal(calls[1].body.payload.provider, 'qodercn');

  // The host answers `{ ok: false, error }`; the bridge must surface that message
  // as a thrown Error instead of handing the panel an empty state.
  const bad = loadClient();
  const badCtx = fakeClientContext(bad);
  badCtx.connection.rpc = { call: async () => ({ ok: false, error: { message: '仅支持 5 或 15 分钟采样' } }) };
  bad.client.apply(badCtx);
  await assert.rejects(
    () => bad.registered[0].component({ visible: true }).props.rpcCall('history.configure', { intervalMinutes: 7 }),
    /仅支持 5 或 15 分钟采样/,
  );
  bad.disposers.forEach(fn => fn());
});

/** Flatten an element tree built by the fake React into searchable text. */
function treeText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(' ');
  const { type, props, children } = node;
  const attrs = Object.entries(props || {})
    // Handlers are skipped: their SOURCE text would be scanned as if rendered.
    .filter(([, v]) => typeof v !== 'function')
    .map(([k, v]) => `${k}=${v === null || typeof v === 'object' ? '' : v}`).join(' ');
  return `${typeof type === 'string' ? type : 'component'} ${attrs} ${(children || []).map(treeText).join(' ')}`;
}

/** Count rendered SVG elements by tag, so a "drawn or not" claim is checkable. */
function countTags(node, tag) {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countTags(child, tag), 0);
  const self = node.type === tag ? 1 : 0;
  return self + (node.children || []).reduce((sum, child) => sum + countTags(child, tag), 0);
}

/** Every SVG coordinate/attribute and label must be a real number, never NaN. */
function assertNoNaN(label, node) {
  const text = treeText(node);
  for (const bad of ['NaN', 'undefined', 'Infinity']) {
    assert.ok(!text.includes(bad), `${label} 的渲染结果不应包含 ${bad}`);
  }
}

test('走势图在边界数据下不产生 NaN，也不把断点画成消耗', () => {
  const { module } = loadClient();
  const at = Date.now();
  const ok = (minutes, total, kind, extra = {}) => ({
    at: at + minutes * 60000, status: 'ok', total, intervalMinutes: 15,
    change: kind ? { kind, minutes, amount: 1 } : undefined, ...extra,
  });

  // One valid point only: the y-domain is degenerate, so `high - low` would be 0.
  assertNoNaN('单点', module.Trend({ points: [ok(0, 100, undefined)] }));
  // All samples failed: falls through to the empty-state placeholder.
  assertNoNaN('全部失败', module.Trend({ points: [{ at, status: 'failed' }, { at: at + 1, status: 'failed' }] }));
  // A zero balance (y-domain low bound clamps at 0) and a huge one.
  assertNoNaN('零余额', module.Trend({ points: [ok(0, 0, undefined), ok(15, 0, 'usage')] }));
  assertNoNaN('极大余额', module.Trend({ points: [ok(0, 1e9, undefined), ok(15, 1e9 - 1, 'usage')] }));
  // A failure at each end of the window: the x-domain must still contain them.
  assertNoNaN('两端断点', module.Trend({ points: [
    { at, status: 'failed' }, ok(15, 500, 'gap'), ok(30, 400, 'increase'), { at: at + 45 * 60000, status: 'failed' },
  ] }));
  // 30 dense samples in a narrow column: tick generation must stay finite.
  const dense = Array.from({ length: 30 }, (_, i) => ok(i * 15, 1000 - i * 7, i ? 'usage' : undefined));
  assertNoNaN('30 点', module.Trend({ points: dense }));

  // A `gap` interval must not be drawn as a solid consumed segment: only the
  // polyline (faint context line) should appear, with no highlighted segment.
  const usage = module.Trend({ points: [ok(0, 100, undefined), ok(15, 90, 'usage')] });
  const gap = module.Trend({ points: [ok(0, 100, undefined), ok(15, 90, 'gap')] });
  const increase = module.Trend({ points: [ok(0, 100, undefined), ok(15, 120, 'increase')] });
  const segStroke = node => {
    const found = [];
    const walk = current => {
      if (!current || typeof current !== 'object') return;
      if (Array.isArray(current)) { current.forEach(walk); return; }
      if (current.props?.strokeWidth === 2 && current.props?.strokeLinecap === 'round') found.push(current.props.stroke);
      (current.children || []).forEach(walk);
    };
    walk(node);
    return found;
  };
  assert.equal(segStroke(usage).length, 1, 'usage 相邻点应画 1 段高亮');
  assert.equal(segStroke(gap).length, 0, 'gap 相邻点不应画成实线消耗段');
  assert.equal(segStroke(increase).length, 1, 'increase 相邻点应画 1 段（非消耗色）');
  assert.notEqual(segStroke(usage)[0], segStroke(increase)[0], '消耗与非消耗必须用不同颜色区分');
});

test('孤立单点不产生退化折线，面积/折线只在 >=2 点的连续段上画', () => {
  const { module } = loadClient();
  const at = Date.now();
  const p = (minutes, total, kind) => ({
    at: at + minutes * 60000, status: 'ok', total, intervalMinutes: 15,
    change: kind ? { kind, minutes: 15, amount: 1 } : undefined,
  });
  const bad = minutes => ({ at: at + minutes * 60000, status: 'failed' });

  const tags = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'polyline' || node.type === 'polygon') tags.push({ type: node.type, points: node.props.points });
    (node.children || []).forEach(walk);
  };

  // One isolated valid sample between two failures: no line can be drawn, and
  // the chart must not emit a 1-vertex polyline or a zero-width area for it.
  const circles = [];
  const walkCircles = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walkCircles); return; }
    if (node.type === 'circle') circles.push(node.props);
    (node.children || []).forEach(walkCircles);
  };
  const isolated = module.Trend({ points: [bad(0), p(15, 500, 'usage'), bad(30)] });
  walk(isolated);
  assert.equal(tags.length, 0, '孤立单点不应产生折线或面积元素');
  // ...but it must still be VISIBLE: the per-point circle is what draws it.
  walkCircles(isolated);
  const sampleDots = circles.filter(c => c.r === 2.6);
  assert.equal(sampleDots.length, 1, '孤立单点仍应绘制 1 个样本圆点');
  assert.ok(Number.isFinite(sampleDots[0].cx) && Number.isFinite(sampleDots[0].cy), '样本圆点坐标应有限');

  // Two adjacent valid samples DO form one run.
  tags.length = 0;
  walk(module.Trend({ points: [p(0, 500, undefined), p(15, 480, 'usage')] }));
  assert.equal(tags.filter(t => t.type === 'polyline').length, 1, '相邻两点应画 1 条折线');
  assert.equal(tags.filter(t => t.type === 'polygon').length, 1, '相邻两点应画 1 块面积');

  // A run, an isolated dot, then another run: two lines, and the dot is skipped.
  tags.length = 0;
  walk(module.Trend({ points: [
    p(0, 900, undefined), p(15, 880, 'usage'), bad(30), p(45, 700, 'usage'), p(60, 690, 'usage'),
  ] }));
  const lines = tags.filter(t => t.type === 'polyline');
  assert.equal(lines.length, 2, '两段连续 + 中间断点应画 2 条折线');
  for (const l of lines) {
    assert.ok(l.points.trim().split(/\s+/).length >= 2, '每条折线至少 2 个顶点');
  }
  assert.equal(tags.filter(t => t.type === 'polygon').length, 2, '面积同样只在连续段上画');
});

test('长断点把折线与面积切断，并留下可见的断点标记', () => {
  const { module } = loadClient();
  const at = Date.now();
  const p = (minutes, total, kind, minutes2) => ({
    at: at + minutes * 60000, status: 'ok', total, intervalMinutes: 15,
    change: kind ? { kind, minutes: minutes2 ?? 15, amount: 1 } : undefined,
  });
  // A 105-minute hole: the two sides must NOT be bridged by one polyline.
  const tree = module.Trend({ points: [p(0, 1000), p(15, 900, 'usage'), p(30, 850, 'usage'), p(135, 400, 'gap', 105), p(150, 390, 'usage')] });

  const polylines = [];
  const walk = (node, tag) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, tag)); return; }
    if (node.type === tag) polylines.push(node.props.points);
    (node.children || []).forEach(n => walk(n, tag));
  };
  walk(tree, 'polyline');
  assert.equal(polylines.length, 2, 'gap 应把折线切成 2 段，而不是连成一条直线');
  // A dashed break marker must exist at the gap (and be non-error colored).
  const dashed = [];
  const walkLines = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walkLines); return; }
    if (node.type === 'line' && node.props?.strokeDasharray && node.props?.strokeWidth !== 2) dashed.push(node.props.stroke);
    (node.children || []).forEach(walkLines);
  };
  walkLines(tree);
  assert.ok(dashed.length >= 1, 'gap 处应画虚线断点标记');
});

test('大余额不把 y 轴标签挤出画布（左侧留白自适应）', () => {
  const { module } = loadClient();
  const at = Date.now();
  const big = [
    { at, status: 'ok', total: 1e9, intervalMinutes: 15, change: { kind: 'gap' } },
    { at: at + 900000, status: 'ok', total: 1e9 - 1, intervalMinutes: 15, change: { kind: 'usage', minutes: 15, amount: 1 } },
    { at: at + 1800000, status: 'ok', total: 1e9 - 3, intervalMinutes: 15, change: { kind: 'usage', minutes: 15, amount: 2 } },
  ];
  const tree = module.Trend({ points: big });
  const texts = [];
  const walkText = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walkText); return; }
    if (node.type === 'text') texts.push(node);
    (node.children || []).forEach(walkText);
  };
  walkText(tree);
  // Find the y-axis labels (right-aligned) and prove they start inside the canvas.
  const axisTexts = texts.filter(t => t.props.textAnchor === 'end');
  assert.ok(axisTexts.length >= 2, '应有 y 轴刻度标签');
  assert.ok(axisTexts.length > 2, '应有多条刻度（不含 x 轴两端标签）');
  for (const t of axisTexts) {
    const label = String(t.children?.[0] ?? '');
    const estWidth = label.length * 6.4;
    assert.ok(t.props.x - estWidth >= 0, `标签「${label}」起点 ${t.props.x - estWidth} 应 >= 0，不能被裁切`);
  }
  // Whatever unit the layout picks, neighbouring ticks must stay distinguishable:
  // two ticks rendering the same string is the misleading failure mode.
  const labels = axisTexts.map(t => String(t.children?.[0] ?? ''));
  assert.equal(new Set(labels).size, labels.length, `刻度标签不应重复：${labels.join(',')}`);
});

test('混排 0 与 10 亿时刻度仍不重叠、不重复', () => {
  const { module } = loadClient();
  const at = Date.now();
  const pts = [
    { at, status: 'ok', total: 0, intervalMinutes: 15, change: { kind: 'increase' } },
    { at: at + 900000, status: 'ok', total: 5e8, intervalMinutes: 15, change: { kind: 'increase' } },
    { at: at + 1800000, status: 'ok', total: 1e9, intervalMinutes: 15, change: { kind: 'usage', minutes: 15, amount: 1 } },
  ];
  const texts = [];
  const walkText = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walkText); return; }
    if (node.type === 'text') texts.push(node);
    (node.children || []).forEach(walkText);
  };
  walkText(module.Trend({ points: pts }));
  const axisTexts = texts.filter(t => t.props.textAnchor === 'end');
  const labels = axisTexts.map(t => String(t.children?.[0] ?? ''));
  for (const t of axisTexts) {
    const label = String(t.children?.[0] ?? '');
    assert.ok(t.props.x - label.length * 6.4 >= 0, `标签「${label}」不应越过画布左边`);
  }
  // 0 and 1e9 in one axis: every tick must still print a distinct value.
  assert.equal(new Set(labels).size, labels.length, `刻度标签不应重复：${labels.join(',')}`);
});

test('面板组件在无 Hook 环境下也能构建元素树，不产生 NaN 文案', () => {
  const { module } = loadClient();
  assert.equal(typeof module.CreditHistoryPanel, 'function');
  assert.equal(typeof module.Trend, 'function');
  assert.equal(Object.keys(module.PROVIDERS).length, 10);

  // A structural smoke test: with inert hooks the component still walks its
  // whole render path, so a top-level crash (or a bad helper reference) fails here.
  const empty = module.CreditHistoryPanel({ rpcCall: async () => ({ accounts: [] }) });
  assert.ok(empty, '无账号时仍应渲染占位结构');
  const failed = module.Trend({ points: [{ at: Date.now(), status: 'error', total: null }] });
  assert.ok(failed, '全部采样失败时应渲染空态占位');
});

test('后台余额协议正确区分国际版和中国版，并隔离失败账号', async () => {
  const called = [];
  const m = { credentialRef: x => x, QODER: { id: 'qoder' }, QODER_CN: { id: 'qodercn' },
    fetchQoderCreditBalance: async (_c, p) => { called.push(p.id); return { total: 9, packages: [] }; } };
  const query = createBalanceReader({ modules: m, accounts: async () => [{ id: 'bad', credentialRef: 'bad' }, { id: 'good', credentialRef: 'good' }],
    resolve: async ref => ({ value: ref === 'bad' ? 'invalid' : '{}' }), pause: async () => {} });
  const res = await query('qodercn'); assert.equal(res.value.accounts[0].balance, null);
  assert.equal(res.value.accounts[1].balance.total, 9); assert.deepEqual(called, ['qodercn']);
  await query('qoder'); assert.deepEqual(called, ['qodercn', 'qoder']);
});

test('恢复后的 Jet Hub 连续手动刷新每次都查询，没有 5 或 15 分钟缓存', async t => {
  const root = join(homedir(), '.dsh/profiles/web/node_modules/dsh-codearts-auth');
  const { registerJetHubRpc } = await import(pathToFileURL(join(root, 'lib/jet-hub-rpc.js')));
  let endpoint, requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ code: 0, data: { Response: { Data: { Accounts: [{ PackageName: '测试资源包', CycleCapacityRemain: 42 - requests, CycleCapacitySize: 50, CycleCapacityUsed: 8 + requests }] } } } });
  });
  const ctx = { logger: { warn() {}, info() {} }, inject: (_names, fn) => fn(ctx),
    credentials: { resolve: async () => ({ value: JSON.stringify({ access_token: 'mock', domain: 'copilot.tencent.com', user_id: 'test' }) }) },
    connection: { fetch: { register: value => { endpoint = value; } } } };
  registerJetHubRpc(ctx, { listAccounts: async () => [{ id: 'a', credentialRef: 'BUDDY_ACCOUNT_TEST' }] }, ...Array(10).fill({}));
  const refresh = async () => (await (await endpoint.fetch(new Request('http://localhost/api/jet-hub', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'jet-hub', payload: { method: 'credits.balances', payload: { provider: 'buddy' } } }),
  }))).json()).result;
  assert.equal((await refresh()).value.accounts[0].balance.total, 41);
  assert.equal((await refresh()).value.accounts[0].balance.total, 40);
  assert.equal(requests, 2);
});

test('已安装的十种余额协议函数可加载，无网络请求', async () => {
  const m = await loadBalanceModules(join(homedir(), '.dsh/profiles/web'));
  for (const fn of ['fetchCreditBalance', 'fetchLobsteraiCreditBalance', 'fetchQoderCreditBalance', 'fetchTraeCreditBalance', 'fetchClineCreditBalance',
    'fetchLoomyCreditBalance', 'fetchRaccoonCreditBalance', 'fetchCodeArtsAccountInfoDetailed', 'credentialRef']) assert.equal(typeof m[fn], 'function');
});

test('独立插件启动及卸载只管理自己的接口和定时器', async t => {
  const home = mkdtempSync(join(tmpdir(), 'independent-plugin-'));
  const cleanups = []; let endpoint, disposed = false;
  t.after(() => { for (const fn of cleanups.reverse()) fn?.(); rmSync(home, { recursive: true, force: true }); });
  await apply({
    get: () => ({ home, dir: join(homedir(), '.dsh/profiles/web') }),
    accountPool: { listAccounts: async () => [] },
    credentials: { resolve: async () => { throw new Error('启动不应读取凭据'); } },
    connection: { fetch: { register: value => { endpoint = value; return () => { disposed = true; }; } } },
    logger: { info() {}, warn() {} }, effect: fn => { cleanups.push(fn()); },
  });
  assert.equal(endpoint.path, '/api/credit-history');
  assert.equal(cleanups.length, 2);
  for (const fn of cleanups.splice(0).reverse()) fn();
  assert.equal(disposed, true);
});
