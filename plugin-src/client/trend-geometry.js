/**
 * 积分走势图的几何计算 —— **纯函数**模块，不依赖 React、DOM 或宿主。
 *
 * 为什么要单独成模块：单测跑在 node 下，而 `react` 不在依赖里，组件渲染不了。
 * 因此一切需要被断言的判据都必须落在纯函数里才**真跑得到**覆盖
 * （本仓库既有惯例：`new-account.js` / `model-bulk.js` / `account-model-link.js`）。
 *
 * ## 契约：空缺**不再**打断曲线
 *
 * 用户要求：「一段时间空缺的话，就把它合并在一起，不需要把它显示为空缺」。
 * `buildTrend` 因此**只产出一段曲线**（`runs.length === 1`），跨越三类「看不见的点」：
 * 1. `change.kind === 'gap'` —— 相邻两次有效采样间隔过长（宿主侧无法估算消耗）；
 * 2. `status !== 'ok'` 的失败采样 —— 它没有 `total`，本就不在有效点里；
 * 3. `change.kind === 'reset'` —— 跨日或资源包身份变化（它此前就连着画，保持不变）。
 *
 * 于是「断点」这个概念在几何层被移除：`breaks` **恒为空数组**（字段保留，既让调用方
 * 解构不报错，也让契约本身可被断言）。x 轴仍按**真实时间**线性映射，空缺处就是一条
 * 更长的直线段/斜线 —— 不做压缩、不插顶点。
 */

/** 宿主侧 `changeBetween` 会给出的四种区间类型；其余一律按未知处理。 */
export const CHANGE_KINDS = ['usage', 'increase', 'reset', 'gap'];

/** 数字格式化（坐标轴刻度与概要数字共用同一实现，避免两处风格漂移）。 */
export const fmt = n => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 });

const PAD_RIGHT = 16;
const PAD_TOP = 14;
const PAD_BOTTOM = 24;
const MIN_WIDTH = 240;
const MIN_INNER = 40;
/** x 轴最小时间跨度：只有一个采样点时也要有一条可读的横轴。 */
const MIN_SPAN_MS = 60000;

/** 有效采样：既有余额又有数值。失败采样没有 `total`，天然落在曲线之外。 */
export function isValidSample(point) {
  return point?.status === 'ok' && Number.isFinite(point.total);
}

/**
 * 归一化一个采样的区间变化类型，供面板与几何层共用（唯一的判定入口）。
 *
 * - 失败采样没有区间可言 → `'failed'`；
 * - 宿主将来新增的未知 `kind` → `'unknown'`：**不得**被当成断点，否则又会把
 *   空缺画成空缺（本模块的存在意义就是不让这件事再发生）。
 */
export function changeKindOf(point) {
  if (!isValidSample(point)) return 'failed';
  const kind = point?.change?.kind;
  return CHANGE_KINDS.includes(kind) ? kind : 'unknown';
}

/**
 * 轴刻度落在 1/2/5×10ⁿ 的档位上。
 *
 * ⚠️ `minStep` 是**数据粒度下限**（0 = 不限制）：当全部余额都是整数时传 1，
 * 轴就不允许细分到 1 以下，否则会出现「0 / 0.5 / 1」这种**半个积分**的刻度。
 *
 * 触发场景是**恒定余额**（本机真实数据里有：一个 qoder 账号 66 个采样点全为 0）：
 * 此时 `range === 0`，上下各留 `max(1, …)` 的空白 ⇒ 定义域塌成 `[0, 1]`，
 * 4 等分后再归到「≤5」档就得到步长 **0.5**。积分是整数计数的（也有账号是
 * 2191.54 这样的小数，故不能一律取整），所以下限应由**数据自己**给出。
 */
export function niceTicks(low, high, count = 4, minStep = 0) {
  const span = high - low;
  if (!(span > 0)) return [low];
  // ⚠️ 先对 `span / count` 与 `minStep` 取大，再归档位：若先归档位再抬到
  // `minStep`，步长可能落到档位之外（如 3），刻度就不再是「好看的数」。
  const raw = Math.max(span / count, minStep);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let v = Math.ceil(low / step) * step; v <= high + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

/**
 * Y 轴刻度标签。优先用完整分组数字（无歧义）；只有当实测标签宽度超出它在窄栏里
 * 该占的份额时才缩写。**一律缩写比它所替代的裁剪更糟**：在 ~1e9 量级上，相邻两个
 * 刻度会一起被写成「10 亿」。
 */
const axisNumber = (value, decimals) => {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(decimals)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(decimals)} 万`;
  return fmt(value);
};

/** 轴标签在 10px 字号下的粗略渲染宽度。 */
const labelWidth = text => text.length * 6.4;

/**
 * 选择 Y 轴刻度标签以及它们需要的左侧留白。只要放得下就用完整精度；否则切到紧凑
 * 单位，并把留白封顶，使绘图区在窄栏里**永不塌缩**。
 */
export function axisLayout(ticks, w) {
  const cap = Math.max(40, Math.round(w * 0.45));
  const needed = labels => Math.max(...labels.map(labelWidth), 0) + 10;
  const full = ticks.map(v => fmt(v));
  if (needed(full) <= cap) return { labels: full, padLeft: Math.max(40, Math.round(needed(full))) };
  // 紧凑回落：默认 0 位小数，只有在能消歧时才给 1 位。
  const zero = ticks.map(v => axisNumber(v, 0));
  const labels = new Set(zero).size === zero.length ? zero : ticks.map(v => axisNumber(v, 1));
  return { labels, padLeft: Math.max(40, Math.min(cap, Math.round(needed(labels)))) };
}

/**
 * 把一串采样算成可直接喂给 SVG 的几何。
 *
 * 返回：
 * - `ready`：有效点 ≥ 2，真的能画出一条线；
 * - `valid`：参与绘制的有效采样（失败采样被排除，但它们的**时间**仍计入 x 域）；
 * - `domain` / `ticks` / `tickLabels` / `layout` / `scale`：坐标域与映射
 *   （`scale.xOf` / `scale.yOf` 同时接受「点对象」与「裸数字」，方便刻度复用）；
 * - `runs` / `lines` / `curves`：连续段、其中的可画段、以及每段的 polyline+area
 *   坐标串。**契约：`runs` 至多一段**，因为它不再按空缺切分；
 * - `segments`：用于加粗高亮的**真实相邻**区间（空缺区间只用细线跨越，不加粗 ——
 *   它不是可估算的连续消耗）；
 * - `breaks`：**恒为 `[]`**。空缺与失败采样都不再产生虚线断点。
 *
 * 退化输入（空数组、单点、缺 `total`）一律返回完整结构且**不抛错**。
 */
export function buildTrend(points, { width, height } = {}) {
  const list = Array.isArray(points) ? points : [];
  const valid = list.filter(isValidSample);
  const w = Math.max(MIN_WIDTH, Math.round(width) || 320);
  const h = Math.max(0, Math.round(Number(height) || 0));

  const atOf = point => (Number.isFinite(point?.at) ? point.at : 0);
  // x 域跨越**查询窗口内的每一个采样**（含失败采样），否则窗口边缘的空缺会被画到
  // 画布之外。y 域只用有效余额：失败采样没有 `total`。
  const minAt = list.length ? atOf(list[0]) : 0;
  const lastAt = list.length ? atOf(list[list.length - 1]) : 0;
  const maxAt = Math.max(minAt + MIN_SPAN_MS, lastAt);

  const totals = valid.map(p => p.total);
  const min = totals.length ? Math.min(...totals) : 0;
  const max = totals.length ? Math.max(...totals) : 0;
  // 按**观测跨度**的固定比例留白，而不是按余额绝对值：一个稳定在 1,286 积分、波动
  // 仅 4 积分的账号，否则会被上下各留 ~13 积分、画成一条死直线。绝对量级由轴标签
  // 给出，因此填满高度是诚实的。
  const range = max - min;
  const cushion = range > 0 ? range * 0.15 : Math.max(1, max * 0.002);
  const low = Math.max(0, min - cushion), high = max + cushion;

  // ⚠️ 轴刻度的粒度下限取**数据自己的粒度**：余额全是整数时不允许画出小数刻度。
  // 若不限制，恒定余额（range=0）会让定义域塌成 [0,1]，4 等分后得到步长 0.5，
  // 用户看到「0 / 0.5 / 1」——积分是整数计数的，半个积分不存在。
  // 反之，余额本就带小数（真实数据里有 2191.54）时**不能**强制取整，
  // 否则相邻刻度会挤成同一个标签。
  const granularity = totals.every(Number.isInteger) ? 1 : 0;
  const ticks = niceTicks(low, high, 4, granularity);
  const { labels: tickLabels, padLeft } = axisLayout(ticks, w);
  const innerW = Math.max(MIN_INNER, w - padLeft - PAD_RIGHT);
  const innerH = Math.max(MIN_INNER, h - PAD_TOP - PAD_BOTTOM);

  const spanMs = maxAt - minAt || 1;
  const spanValue = high - low || 1;
  const xOf = point => {
    const at = Number.isFinite(point) ? point : atOf(point);
    return padLeft + ((at - minAt) / spanMs) * innerW;
  };
  const yOf = point => {
    const total = Number.isFinite(point) ? point : (Number.isFinite(point?.total) ? point.total : low);
    return PAD_TOP + innerH - ((total - low) / spanValue) * innerH;
  };

  // 连续段：**只有一段**。这里刻意不再遍历 `points` 去找 gap/失败/reset 边界 ——
  // 那正是「空缺被显示为空缺」的来源。时间轴上的稀疏由 x 映射如实体现。
  const runs = valid.length ? [valid.slice()] : [];
  // 只有一个采样点的段是孤立的点、不是线：发一条单顶点 polyline（以及零宽面积）
  // 只会给每个孤立采样留一个空元素。那些点已由逐点圆圈画出。
  const lines = runs.filter(r => r.length >= 2);
  const curves = lines.map(pts => {
    const path = pts.map(p => `${xOf(p).toFixed(1)},${yOf(p).toFixed(1)}`).join(' ');
    const bottom = PAD_TOP + innerH;
    return {
      points: pts,
      polyline: path,
      // 面积同样跨越空缺填充：底边从首点垂到末点，中间不开口。
      area: `${xOf(pts[0]).toFixed(1)},${bottom} ${path} ${xOf(pts[pts.length - 1]).toFixed(1)},${bottom}`,
    };
  });

  const segments = [];
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1], b = valid[i];
    // 空缺区间跳过加粗高亮（曲线本身仍由 curves 连续跨越）。
    if (changeKindOf(b) === 'gap') continue;
    segments.push({ a, b, usage: changeKindOf(b) === 'usage' });
  }

  return {
    ready: valid.length >= 2,
    valid,
    domain: { minAt, lastAt, maxAt, low, high },
    ticks,
    tickLabels,
    layout: { width: w, height: h, padLeft, padTop: PAD_TOP, padRight: PAD_RIGHT, padBottom: PAD_BOTTOM, innerW, innerH },
    scale: { xOf, yOf },
    runs,
    lines,
    curves,
    segments,
    breaks: [],
  };
}
