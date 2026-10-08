import * as React from 'react';
import { buildTrend, changeKindOf } from './trend-geometry.js';
import { SAMPLING_MINUTES, samplingSelectValue } from './history-settings.js';
const h = React.createElement;

export const PROVIDERS = {
  codearts: 'CodeArts', buddy: 'CodeBuddy', workbuddy: 'WorkBuddy', lobsterai: 'LobsterAI',
  qoder: 'Qoder 国际版', qodercn: 'Qoder 中国版', trae: 'TRAE', cline: 'Cline', loomy: 'Loomy', raccoon: 'Raccoon',
};

const RANGES = [[1, '1 小时'], [24, '24 小时'], [168, '7 天']];

const fmt = n => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
/** Sampling spans are measured in minutes; report them at a readable scale. */
const duration = minutes => (minutes >= 120
  ? `${(minutes / 60).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时`
  : `${Number(minutes).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 分钟`);
const stamp = t => new Date(t).toLocaleString('zh-CN', { hour12: false });
const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const dateTime = t => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const describe = change => {
  if (change?.kind === 'usage') return `约 ${duration(change.minutes)}净消耗 ${fmt(change.amount)}`;
  if (change?.kind === 'increase') return '余额补充或资源包变动，不计为消耗';
  if (change?.kind === 'reset') return '跨日或额度周期变动，不计为消耗';
  return '无连续采样，无法估算';
};

/** Theme-aware tokens with light/dark-safe fallbacks (the sidebar renders in both). */
const TOKEN = {
  text: 'var(--dsw-alias-label-primary, #1b1f26)',
  sub: 'var(--dsw-alias-label-secondary, #6b7280)',
  faint: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
  card: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
  glass: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))',
  brand: 'var(--dsw-alias-brand-primary, #4f9cf9)',
  warn: '#d99a40',
  error: 'var(--dsw-alias-state-error-primary, #df6e63)',
};

/** Measure the host element so the chart draws at real pixel size (crisp text in a narrow column). */
function useElementSize() {
  const ref = React.useRef(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => setSize({ width: node.clientWidth || 0, height: node.clientHeight || 0 });
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/**
 * The x-axis end labels. A range that crosses midnight reads backwards as bare
 * clock times ("06:40 → 00:47"), so anything but a same-day window carries the
 * date; the full window is spelled out separately by the caller.
 */
const axisLabel = (from, to) => {
  const a = new Date(from), b = new Date(to);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? { start: clock(from), end: clock(to) } : { start: dateTime(from), end: dateTime(to) };
};

/**
 * The hero chart: an area+line balance curve, drawn at measured pixel size.
 *
 * 几何计算全部收在 `trend-geometry.js`（纯函数、可在 node 下单测）。
 * ⚠️ **图表不再显示空缺**（用户要求：「一段时间空缺的话，就把它合并在一起，
 * 不需要把它显示为空缺」）：跨 `gap` / `reset` / 失败采样一律连成**一条**曲线，
 * 也没有虚线断点标记。该契约在 `buildTrend` 里，不在这里 —— 组件渲染不了，
 * 判据留在组件里就等于没覆盖。
 */
export function Trend({ points }) {
  const [wrapRef, { width, height: boxHeight }] = useElementSize();
  const [hover, setHover] = React.useState(null);
  // Chart-first: the plot claims the wrapper's leftover height once the hover
  // readout row is reserved, with a floor so it still reads as a chart. When
  // the wrapper has no flex parent (standalone use) the floor applies.
  const READOUT = 44;
  const height = Math.max(160, Math.min(460, Math.round(boxHeight) - READOUT) || 0);

  const valid = points.filter(p => p.status === 'ok');

  if (!valid.length) {
    return h('div', { ref: wrapRef, style: { width: '100%' } },
      h('div', {
        style: {
          height, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          border: `1px dashed ${TOKEN.border}`, borderRadius: 12, padding: 18,
          color: TOKEN.sub, fontSize: 12, lineHeight: 1.7,
        },
      }, '尚无余额记录。后台将在启动后约 30 秒开始采样；至少两个有效采样才能画出走势与消耗估算。'));
  }

  const trend = buildTrend(points, { width, height });
  const { curves, segments, domain, ticks, tickLabels, layout, scale } = trend;
  const { minAt, lastAt } = domain;
  const { width: w, padLeft, padTop, innerW, innerH } = layout;
  const { xOf: x, yOf: y } = scale;

  // Hover picks the NEAREST sample by pixel distance on the x-axis. It walks the
  // valid samples, not all points: a failed sample has no balance to read out.
  const plot = trend.valid;

  const onMove = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < plot.length; i++) {
      const distance = Math.abs(x(plot[i]) - px);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    setHover(best);
  };

  const axis = axisLabel(minAt, lastAt);
  const active = hover === null ? null : plot[hover];
  const readout = active && active.status === 'ok' ? active : null;

  return h('div', { ref: wrapRef, style: { width: '100%', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', {
      style: {
        minHeight: READOUT, marginBottom: 6, fontSize: 11, lineHeight: 1.6, color: TOKEN.sub,
        display: 'flex', alignItems: 'center', gap: 8,
      },
    },
    readout
      ? h(React.Fragment, null,
        h('strong', { style: { color: TOKEN.text, fontSize: 14 } }, `${fmt(readout.total)}`),
        h('span', null, stamp(readout.at)),
        h('span', { style: { color: changeKindOf(readout) === 'usage' ? TOKEN.brand : TOKEN.faint } }, describe(readout.change)))
      : h('span', { style: { color: TOKEN.faint } }, '悬停查看某一时刻的余额与区间变化')),
    h('svg', {
      width: w, height, viewBox: `0 0 ${w} ${height}`, role: 'img',
      'aria-label': '积分余额历史走势图',
      style: { display: 'block', flex: 'none', color: TOKEN.text, touchAction: 'pan-y', cursor: 'crosshair' },
      onMouseMove: onMove, onMouseLeave: () => setHover(null),
    },
    h('defs', null, h('linearGradient', { id: 'ch-area', x1: 0, y1: 0, x2: 0, y2: 1 },
      h('stop', { offset: '0%', stopColor: TOKEN.brand, stopOpacity: 0.28 }),
      h('stop', { offset: '100%', stopColor: TOKEN.brand, stopOpacity: 0.02 }))),
    ticks.map((value, i) => {
      const gy = y({ total: value });
      return h('g', { key: `tick-${i}` },
        h('line', { x1: padLeft, x2: padLeft + innerW, y1: gy, y2: gy, stroke: 'currentColor', strokeOpacity: 0.12 }),
        h('text', { x: padLeft - 8, y: gy + 3.5, textAnchor: 'end', fill: 'currentColor', fontSize: 10, opacity: 0.55 }, tickLabels[i]));
    }),
    // 面积与折线都只有**一段** —— 空缺不再开口。见 trend-geometry.js 的契约。
    curves.map(({ area: polygon }, i) => h('polygon', { key: `area-${i}`, points: polygon, fill: 'url(#ch-area)' })),
    curves.map(({ polyline }, i) => h('polyline', {
      key: `line-${i}`, points: polyline, fill: 'none', stroke: TOKEN.brand, strokeWidth: 1.5, strokeOpacity: 0.55,
      strokeLinejoin: 'round', strokeLinecap: 'round',
    })),
    segments.map(({ a, b, usage }, i) => h('line', {
      key: `seg-${i}`, x1: x(a), y1: y(a), x2: x(b), y2: y(b),
      stroke: usage ? TOKEN.brand : TOKEN.warn, strokeWidth: 2, strokeLinecap: 'round',
    })),
    // ⚠️ 这里**不再**画「虚线断点」。原先每个 gap/失败采样都画一条竖直虚线让曲线
    // 与面积「明显断开」，那正是用户要删掉的「把空缺显示为空缺」。曲线现在直接跨
    // 过去；空缺仍可从 x 轴的稀疏读出来（相邻两点的水平间距明显更宽）。
    active ? h('g', null,
      h('line', { x1: x(active), x2: x(active), y1: padTop, y2: padTop + innerH, stroke: 'currentColor', strokeOpacity: 0.28, strokeDasharray: '3 3' }),
      active.status === 'ok' ? h('circle', { cx: x(active), cy: y(active), r: 4.5, fill: TOKEN.brand, stroke: TOKEN.text, strokeWidth: 1.5 }) : null) : null,
    valid.map((p, i) => h('circle', {
      key: `pt-${i}`, cx: x(p), cy: y(p), r: hover === plot.indexOf(p) ? 0 : 2.6,
      fill: TOKEN.brand, stroke: TOKEN.text, strokeWidth: 1, strokeOpacity: 0.5, fillOpacity: 0.9,
    })),
    h('text', { x: padLeft, y: height - 7, fill: 'currentColor', fontSize: 10, opacity: 0.55 }, axis.start),
    h('text', { x: padLeft + innerW, y: height - 7, textAnchor: 'end', fill: 'currentColor', fontSize: 10, opacity: 0.55 }, axis.end)));
}

function Segmented({ value, onChange, options }) {
  return h('div', {
    style: { display: 'inline-flex', border: `1px solid ${TOKEN.border}`, borderRadius: 8, overflow: 'hidden' },
  }, options.map(([id, label]) => h('button', {
    key: id, type: 'button', onClick: () => onChange(id),
    style: {
      border: 0, padding: '4px 9px', fontSize: 11, cursor: 'pointer',
      background: value === id ? TOKEN.glass : 'transparent',
      color: value === id ? TOKEN.text : TOKEN.sub,
      fontWeight: value === id ? 600 : 400,
    },
  }, label)));
}

const selectStyle = {
  border: `1px solid ${TOKEN.border}`, borderRadius: 8, padding: '5px 8px',
  background: 'transparent', color: 'inherit', fontSize: 12, maxWidth: '100%',
};

/**
 * The sidebar tab body: chart-first, tuned for a narrow column.
 * Owns its own provider / account / range state (there is no wrapper page).
 */
export function CreditHistoryPanel({ rpcCall, visible = true, sessionId }) {
  const [provider, setProvider] = React.useState('qodercn');
  const [hours, setHours] = React.useState(24);
  const [accountId, setAccountId] = React.useState('');
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [available, setAvailable] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  // 会话自动切源只做一次（每个 sessionId 一次）：它是**种子**不是锁定 ——
  // 用户手动切走之后，本轮会话内不再被拉回。
  const seededRef = React.useRef('');

  // 当前会话最近用的供应商：宿主按 sessionId 查（实时观察 + 重启后按需解压
  // 会话文件兜底）。查不到 / 旧版宿主不认识这个方法（会抛错）都静默回落，
  // 维持原有「可用探针选第一个有账号的来源」的行为。
  React.useEffect(() => {
    if (!sessionId || seededRef.current === sessionId) return;
    seededRef.current = sessionId;
    let alive = true;
    rpcCall('session.provider', { sessionId })
      .then(result => {
        const seed = result?.provider;
        if (!alive || typeof seed !== 'string' || !PROVIDERS[seed]) return;
        // 可用探针若已先返回，也只在种子属于可用来源时覆盖 —— 种子对应的
        // 来源没有账号时，维持探针选中的那个（有账号的）来源更实用。
        setProvider(current => (available === null || available.includes(seed) ? seed : current));
      })
      .catch(() => { /* 旧版宿主 / 查询失败：静默维持默认 */ });
    return () => { alive = false; };
  }, [sessionId, rpcCall, available]);

  // Which API sources actually have accounts: one cheap LOCAL read per source
  // (view() only filters the local history file — it never queries upstream).
  React.useEffect(() => {
    let alive = true;
    const probe = async () => {
      const found = [];
      await Promise.all(Object.keys(PROVIDERS).map(async id => {
        try {
          const result = await rpcCall('history.read', { provider: id, hours: 1 });
          if (result?.accounts?.length) found.push(id);
        } catch { /* a source that cannot be read simply does not appear */ }
      }));
      if (!alive) return;
      const ordered = Object.keys(PROVIDERS).filter(id => found.includes(id));
      setAvailable(ordered);
      setProvider(current => (ordered.includes(current) ? current : (ordered[0] || current)));
    };
    void probe();
    return () => { alive = false; };
  }, [rpcCall, nonce]);

  React.useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const result = await rpcCall('history.read', { provider, hours });
        if (!alive) return;
        setData(result); setError('');
      } catch (e) { if (alive) setError(e?.message || '无法读取历史'); }
    };
    void read();
    if (!visible) return () => { alive = false; };
    // Local file reads only; the sidebar tab keeps refreshing while it is open.
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void read(); }, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [provider, hours, rpcCall, visible]);

  const refresh = async () => {
    setBusy(true);
    try {
      const result = await rpcCall('history.read', { provider, hours });
      setData(result); setError(''); setNonce(n => n + 1);
    } catch (e) { setError(e?.message || '无法读取历史'); }
    finally { setBusy(false); }
  };

  const accounts = data?.accounts || [];
  const row = accounts.find(a => a.accountId === accountId) || accounts[0];
  const points = row?.points || [];
  const last = points[points.length - 1];
  const latestValid = points.filter(p => p.status === 'ok')[points.filter(p => p.status === 'ok').length - 1];
  const units = [...new Set((latestValid?.packages || []).filter(p => p.active).map(p => p.unit))];
  const unit = units.length === 1 ? units[0] : '额度';
  const recent = points.filter(p => p.change?.kind === 'usage');
  const estimate = recent.reduce((sum, p) => sum + p.change.amount, 0);
  const span = recent.reduce((sum, p) => sum + p.change.minutes, 0);
  const sourceList = available?.length ? available : Object.keys(PROVIDERS);
  const hasAccounts = accounts.length > 0;

  // The native tab body host is a BLOCK scroller with a definite height, so
  // the root declares height:100% + its own overflow (the same contract the
  // host's own tab bodies use) instead of relying on flex: 1.
  return h('div', {
    style: { height: '100%', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box', padding: '10px 12px 20px', fontSize: 12, color: TOKEN.text, display: 'flex', flexDirection: 'column' },
  },
    // ---- controls -------------------------------------------------------
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
      h('select', {
        'aria-label': 'API 来源', value: provider, style: { ...selectStyle, flex: '1 1 110px' },
        onChange: e => { setProvider(e.target.value); setAccountId(''); },
      }, sourceList.map(id => h('option', { key: id, value: id }, PROVIDERS[id] || id))),
      h('button', {
        type: 'button', onClick: () => void refresh(), disabled: busy, title: '重新读取本机历史',
        style: { ...selectStyle, cursor: 'pointer', opacity: busy ? 0.55 : 1 },
      }, busy ? '读取中…' : '刷新')),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 } },
      accounts.length > 1
        ? h('select', {
          'aria-label': '历史账号', value: row?.accountId || '', style: { ...selectStyle, flex: '1 1 120px' },
          onChange: e => setAccountId(e.target.value),
        }, accounts.map(a => h('option', { key: a.accountId, value: a.accountId }, a.nickname || a.accountId)))
        : (row ? h('span', { style: { color: TOKEN.sub, flex: '1 1 auto' } }, row.nickname || row.accountId) : null),
      h(Segmented, { value: hours, onChange: setHours, options: RANGES })),

    error ? h('p', { role: 'alert', style: { color: TOKEN.error, margin: '10px 0 0' } }, error) : null,

    // ---- hero numbers ---------------------------------------------------
    h('div', { style: { marginTop: 14, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 26, fontWeight: 650, letterSpacing: '-0.02em' } },
        last?.status === 'ok' ? fmt(last.total) : '—'),
      h('span', { style: { fontSize: 11, color: TOKEN.sub } }, hasAccounts ? unit : '暂无账号')),
    h('div', { style: { marginTop: 4, fontSize: 11, color: TOKEN.sub, lineHeight: 1.6 } },
      recent.length
        ? `区间净消耗 ${fmt(estimate)} ${unit} · 覆盖约 ${duration(span)} · ${recent.length} 段`
        : '本区间暂无可估算的连续消耗'),

    // ---- the chart ------------------------------------------------------
    // `flex: 1 1 auto` lets the hero chart absorb the tab's leftover height, so
    // a tall sidebar gets a big chart instead of dead space under a fixed one.
    h('div', { style: { marginTop: 10, flex: '1 1 auto', minHeight: 200, display: 'flex', flexDirection: 'column' } },
      h(Trend, { points })),

    // ---- status ---------------------------------------------------------
    h('p', { style: { fontSize: 11, color: TOKEN.faint, margin: '8px 0 0', lineHeight: 1.65 } },
      last
        ? `${stamp(last.at)} · ${last.status === 'ok' ? describe(last.change) : '查询失败，该时刻没有余额记录'}`
        : '正在等待第一次采样。'),

    // ---- details --------------------------------------------------------
    points.length > 1 ? h('details', { style: { marginTop: 12 } },
      h('summary', { style: { cursor: 'pointer', fontSize: 11, color: TOKEN.sub } }, `最近 ${Math.min(12, points.length)} 次采样明细`),
      h('div', { style: { overflowX: 'auto', marginTop: 8 } },
        h('table', { style: { width: '100%', fontSize: 11, borderCollapse: 'collapse' } },
          h('thead', null, h('tr', null, ['时间', '余额', '期间变化'].map(label => h('th', {
            key: label, style: { textAlign: 'left', padding: '4px 6px', color: TOKEN.faint, fontWeight: 500, whiteSpace: 'nowrap' },
          }, label)))),
          // Key by position too: the host's `view()` does not deduplicate, so two
          // samples can share one timestamp (clock adjustment, manual repair).
          h('tbody', null, points.slice(-12).reverse().map((p, i) => h('tr', { key: `${p.at}-${p.status}-${i}` },
            h('td', { style: { padding: '4px 6px', whiteSpace: 'nowrap', color: TOKEN.sub } }, stamp(p.at)),
            h('td', { style: { padding: '4px 6px', whiteSpace: 'nowrap' } }, p.status === 'ok' ? fmt(p.total) : '查询失败'),
            h('td', { style: { padding: '4px 6px', color: TOKEN.faint } }, describe(p.change)))))))) : null,

    // ---- caveats --------------------------------------------------------
    h('p', { style: { fontSize: 10.5, color: TOKEN.faint, margin: '12px 0 0', lineHeight: 1.7 } },
      '用量是相邻余额的净下降估算，包含此账号在其他客户端的消费；积分补充、到期或周期重置可能遮蔽实际消耗，跨日与资源包变化不计入。走势图按真实时间连续绘制，采样稀疏处不另作标记。历史保留 30 天，退出 dsh 后暂停采样。'));
}

/**
 * The tab's gear panel (betterSidebar `settings.render`): the background-sampling
 * controls. These write the plugin's OWN backend state through its RPC, so the
 * gear stays the single source of truth (unlike declarative `pluginToggles`,
 * which would persist a second copy in the sidebar's prefs document).
 */
export function HistorySettings({ rpcCall }) {
  const first = Object.keys(PROVIDERS)[0];
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    rpcCall('history.read', { provider: first, hours: 1 })
      .then(result => { if (alive) setData(result); })
      .catch(e => { if (alive) setError(e?.message || '无法读取采样设置'); });
    return () => { alive = false; };
  }, [rpcCall, first]);

  const configure = async payload => {
    setBusy(true);
    try {
      const result = await rpcCall('history.configure', payload);
      setData(prev => ({ ...prev, ...result })); setError('');
    } catch (e) { setError(e?.message || '设置保存失败'); }
    finally { setBusy(false); }
  };

  const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0' };
  return h('div', { style: { fontSize: 12, padding: '2px 0' } },
    h('div', { style: rowStyle },
      h('span', null, '后台记录'),
      h('input', {
        type: 'checkbox', checked: data?.enabled ?? true, disabled: busy || !data,
        onChange: e => void configure({ enabled: e.target.checked }),
      })),
    h('div', { style: rowStyle },
      h('span', null, '采样间隔'),
      h('select', {
        // ⚠️ 取值与选项都来自 `history-settings.js`（纯模块、有单测）：
        // 采样默认值改成 5 之后，这里若还写 `|| 15`、还把 15 排第一，
        // 下拉框会先显示「15 分钟」再跳成「5 分钟」，用户会以为自己选的被改回去了。
        style: selectStyle, value: samplingSelectValue(data), disabled: busy || !data,
        onChange: e => void configure({ intervalMinutes: Number(e.target.value) }),
      }, ...SAMPLING_MINUTES.map(minutes => h('option', { key: minutes, value: minutes }, `${minutes} 分钟`)))),
    error ? h('p', { role: 'alert', style: { color: TOKEN.error, margin: '6px 0 0' } }, error) : null,
    h('p', { style: { fontSize: 10.5, color: TOKEN.faint, margin: '8px 0 0', lineHeight: 1.7 } },
      '自动采样设置对全部 API 源生效，后台按来源与账号串行执行。仅自动采样失败时延长间隔，最多 60 分钟。关闭本面板仍会采样，退出 dsh 才暂停。Jet Hub 的手动查询保持原有行为。'));
}
