window.__ModuleLoader__.load({id:'dsh-credit-history',factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client-src/index.js
var index_exports = {};
__export(index_exports, {
  CreditHistoryPanel: () => CreditHistoryPanel,
  HistorySettings: () => HistorySettings,
  PROVIDERS: () => PROVIDERS,
  Trend: () => Trend,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React2 = __toESM(require("react"), 1);

// client-src/credit-history-panel.js
var React = __toESM(require("react"), 1);
var h = React.createElement;
var PROVIDERS = {
  codearts: "CodeArts",
  buddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  lobsterai: "LobsterAI",
  qoder: "Qoder 国际版",
  qodercn: "Qoder 中国版",
  trae: "TRAE",
  cline: "Cline",
  loomy: "Loomy",
  raccoon: "Raccoon"
};
var RANGES = [[1, "1 小时"], [24, "24 小时"], [168, "7 天"]];
var fmt = (n) => Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 4 });
var duration = (minutes) => minutes >= 120 ? `${(minutes / 60).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 小时` : `${Number(minutes).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 分钟`;
var stamp = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false });
var clock = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
var dateTime = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
var describe = (change) => {
  if (change?.kind === "usage") return `约 ${duration(change.minutes)}净消耗 ${fmt(change.amount)}`;
  if (change?.kind === "increase") return "余额补充或资源包变动，不计为消耗";
  if (change?.kind === "reset") return "跨日或额度周期变动，不计为消耗";
  return "无连续采样，无法估算";
};
var TOKEN = {
  text: "var(--dsw-alias-label-primary, #1b1f26)",
  sub: "var(--dsw-alias-label-secondary, #6b7280)",
  faint: "var(--dsw-alias-label-tertiary, #9aa1ab)",
  border: "var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
  card: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))",
  glass: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))",
  brand: "var(--dsw-alias-brand-primary, #4f9cf9)",
  warn: "#d99a40",
  error: "var(--dsw-alias-state-error-primary, #df6e63)"
};
function useElementSize() {
  const ref = React.useRef(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return void 0;
    const update = () => setSize({ width: node.clientWidth || 0, height: node.clientHeight || 0 });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
function niceTicks(low, high, count = 4) {
  const span = high - low;
  if (!(span > 0)) return [low];
  const raw = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let v = Math.ceil(low / step) * step; v <= high + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}
var axisLabel = (from, to) => {
  const a = new Date(from), b = new Date(to);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? { start: clock(from), end: clock(to) } : { start: dateTime(from), end: dateTime(to) };
};
var axisNumber = (value, decimals) => {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(decimals)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(decimals)} 万`;
  return fmt(value);
};
var labelWidth = (text) => text.length * 6.4;
function axisLayout(ticks, w) {
  const cap = Math.max(40, Math.round(w * 0.45));
  const needed = (labels2) => Math.max(...labels2.map(labelWidth), 0) + 10;
  const full = ticks.map((v) => fmt(v));
  if (needed(full) <= cap) return { labels: full, padLeft: Math.max(40, Math.round(needed(full))) };
  const zero = ticks.map((v) => axisNumber(v, 0));
  const labels = new Set(zero).size === zero.length ? zero : ticks.map((v) => axisNumber(v, 1));
  return { labels, padLeft: Math.max(40, Math.min(cap, Math.round(needed(labels)))) };
}
function Trend({ points }) {
  const [wrapRef, { width, height: boxHeight }] = useElementSize();
  const [hover, setHover] = React.useState(null);
  const READOUT = 44;
  const height = Math.max(160, Math.min(460, Math.round(boxHeight) - READOUT) || 0);
  const valid = points.filter((p) => p.status === "ok");
  const plot = valid.length ? valid : points;
  if (!valid.length) {
    return h(
      "div",
      { ref: wrapRef, style: { width: "100%" } },
      h("div", {
        style: {
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          border: `1px dashed ${TOKEN.border}`,
          borderRadius: 12,
          padding: 18,
          color: TOKEN.sub,
          fontSize: 12,
          lineHeight: 1.7
        }
      }, "尚无余额记录。后台将在启动后约 30 秒开始采样；至少两个有效采样才能画出走势与消耗估算。")
    );
  }
  const minAt = points[0].at;
  const lastAt = points[points.length - 1].at;
  const maxAt = Math.max(minAt + 6e4, lastAt);
  const totals = valid.map((p) => p.total);
  const min = Math.min(...totals), max = Math.max(...totals);
  const range = max - min;
  const cushion = range > 0 ? range * 0.15 : Math.max(1, max * 2e-3);
  const low = Math.max(0, min - cushion), high = max + cushion;
  const ticks = niceTicks(low, high);
  const w = Math.max(240, Math.round(width) || 320);
  const { labels: tickLabels, padLeft } = axisLayout(ticks, w);
  const padRight = 16, padTop = 14, padBottom = 24;
  const innerW = Math.max(40, w - padLeft - padRight);
  const innerH = Math.max(40, height - padTop - padBottom);
  const x = (p) => padLeft + (p.at - minAt) / (maxAt - minAt) * innerW;
  const y = (p) => padTop + innerH - (p.total - low) / (high - low || 1) * innerH;
  const runs = [];
  let run = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], prev = points[i - 1];
    const broken = i > 0 && (prev.status !== "ok" || p.status !== "ok" || p.change?.kind === "gap");
    if (broken && run.length) {
      runs.push(run);
      run = [];
    }
    if (p.status === "ok") run.push(p);
  }
  if (run.length) runs.push(run);
  const lines = runs.filter((r) => r.length >= 2);
  const seg = (pts) => pts.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const area = (pts) => `${x(pts[0]).toFixed(1)},${padTop + innerH} ${seg(pts)} ${x(pts[pts.length - 1]).toFixed(1)},${padTop + innerH}`;
  const segments = [];
  for (let i = 1; i < plot.length; i++) {
    const a = plot[i - 1], b = plot[i];
    if (a.status !== "ok" || b.status !== "ok" || b.change?.kind === "gap") continue;
    segments.push({ a, b, usage: b.change?.kind === "usage" });
  }
  const breaks = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.status !== "ok") {
      breaks.push({ at: p.at, failure: true });
      continue;
    }
    if (i > 0 && points[i - 1].status === "ok" && p.change?.kind === "gap") {
      breaks.push({ at: (points[i - 1].at + p.at) / 2, failure: false, from: points[i - 1].at, to: p.at });
    }
  }
  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < plot.length; i++) {
      const distance = Math.abs(x(plot[i]) - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    setHover(best);
  };
  const axis = axisLabel(minAt, lastAt);
  const active = hover === null ? null : plot[hover];
  const readout = active && active.status === "ok" ? active : null;
  return h(
    "div",
    { ref: wrapRef, style: { width: "100%", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" } },
    h(
      "div",
      {
        style: {
          minHeight: READOUT,
          marginBottom: 6,
          fontSize: 11,
          lineHeight: 1.6,
          color: TOKEN.sub,
          display: "flex",
          alignItems: "center",
          gap: 8
        }
      },
      readout ? h(
        React.Fragment,
        null,
        h("strong", { style: { color: TOKEN.text, fontSize: 14 } }, `${fmt(readout.total)}`),
        h("span", null, stamp(readout.at)),
        h("span", { style: { color: readout.change?.kind === "usage" ? TOKEN.brand : TOKEN.faint } }, describe(readout.change))
      ) : h("span", { style: { color: TOKEN.faint } }, "悬停查看某一时刻的余额与区间变化")
    ),
    h(
      "svg",
      {
        width: w,
        height,
        viewBox: `0 0 ${w} ${height}`,
        role: "img",
        "aria-label": "积分余额历史走势图",
        style: { display: "block", flex: "none", color: TOKEN.text, touchAction: "pan-y", cursor: "crosshair" },
        onMouseMove: onMove,
        onMouseLeave: () => setHover(null)
      },
      h("defs", null, h(
        "linearGradient",
        { id: "ch-area", x1: 0, y1: 0, x2: 0, y2: 1 },
        h("stop", { offset: "0%", stopColor: TOKEN.brand, stopOpacity: 0.28 }),
        h("stop", { offset: "100%", stopColor: TOKEN.brand, stopOpacity: 0.02 })
      )),
      ticks.map((value, i) => {
        const gy = y({ total: value });
        return h(
          "g",
          { key: `tick-${i}` },
          h("line", { x1: padLeft, x2: padLeft + innerW, y1: gy, y2: gy, stroke: "currentColor", strokeOpacity: 0.12 }),
          h("text", { x: padLeft - 8, y: gy + 3.5, textAnchor: "end", fill: "currentColor", fontSize: 10, opacity: 0.55 }, tickLabels[i])
        );
      }),
      lines.map((pts, i) => h("polygon", { key: `area-${i}`, points: area(pts), fill: "url(#ch-area)" })),
      lines.map((pts, i) => h("polyline", {
        key: `line-${i}`,
        points: seg(pts),
        fill: "none",
        stroke: TOKEN.brand,
        strokeWidth: 1.5,
        strokeOpacity: 0.55,
        strokeLinejoin: "round",
        strokeLinecap: "round"
      })),
      segments.map(({ a, b, usage }, i) => h("line", {
        key: `seg-${i}`,
        x1: x(a),
        y1: y(a),
        x2: x(b),
        y2: y(b),
        stroke: usage ? TOKEN.brand : TOKEN.warn,
        strokeWidth: 2,
        strokeLinecap: "round"
      })),
      // Intervals that are NOT continuity: dashed vertical break, so the line and
      // the area visibly stop instead of bridging a long absence of samples.
      breaks.map((b, i) => h(
        "g",
        { key: `brk-${i}` },
        h("line", {
          x1: x(b),
          x2: x(b),
          y1: padTop + 2,
          y2: padTop + innerH,
          stroke: b.failure ? TOKEN.error : TOKEN.warn,
          strokeOpacity: b.failure ? 0.4 : 0.5,
          strokeDasharray: b.failure ? "2 4" : "3 3"
        }),
        h("title", null, b.failure ? `${stamp(b.at)}
查询失败，历史保留缺口` : `${stamp(b.from)} → ${stamp(b.to)}
两次采样间隔过长，其中的消耗无法估算`),
        b.failure ? h("circle", { cx: x(b), cy: padTop + 6, r: 3, fill: TOKEN.error, fillOpacity: 0.75 }) : null
      )),
      active ? h(
        "g",
        null,
        h("line", { x1: x(active), x2: x(active), y1: padTop, y2: padTop + innerH, stroke: "currentColor", strokeOpacity: 0.28, strokeDasharray: "3 3" }),
        active.status === "ok" ? h("circle", { cx: x(active), cy: y(active), r: 4.5, fill: TOKEN.brand, stroke: TOKEN.text, strokeWidth: 1.5 }) : null
      ) : null,
      valid.map((p, i) => h("circle", {
        key: `pt-${i}`,
        cx: x(p),
        cy: y(p),
        r: hover === plot.indexOf(p) ? 0 : 2.6,
        fill: TOKEN.brand,
        stroke: TOKEN.text,
        strokeWidth: 1,
        strokeOpacity: 0.5,
        fillOpacity: 0.9
      })),
      h("text", { x: padLeft, y: height - 7, fill: "currentColor", fontSize: 10, opacity: 0.55 }, axis.start),
      h("text", { x: padLeft + innerW, y: height - 7, textAnchor: "end", fill: "currentColor", fontSize: 10, opacity: 0.55 }, axis.end)
    )
  );
}
function Segmented({ value, onChange, options }) {
  return h("div", {
    style: { display: "inline-flex", border: `1px solid ${TOKEN.border}`, borderRadius: 8, overflow: "hidden" }
  }, options.map(([id, label]) => h("button", {
    key: id,
    type: "button",
    onClick: () => onChange(id),
    style: {
      border: 0,
      padding: "4px 9px",
      fontSize: 11,
      cursor: "pointer",
      background: value === id ? TOKEN.glass : "transparent",
      color: value === id ? TOKEN.text : TOKEN.sub,
      fontWeight: value === id ? 600 : 400
    }
  }, label)));
}
var selectStyle = {
  border: `1px solid ${TOKEN.border}`,
  borderRadius: 8,
  padding: "5px 8px",
  background: "transparent",
  color: "inherit",
  fontSize: 12,
  maxWidth: "100%"
};
function CreditHistoryPanel({ rpcCall, visible = true }) {
  const [provider, setProvider] = React.useState("qodercn");
  const [hours, setHours] = React.useState(24);
  const [accountId, setAccountId] = React.useState("");
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [available, setAvailable] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    const probe = async () => {
      const found = [];
      await Promise.all(Object.keys(PROVIDERS).map(async (id) => {
        try {
          const result = await rpcCall("history.read", { provider: id, hours: 1 });
          if (result?.accounts?.length) found.push(id);
        } catch {
        }
      }));
      if (!alive) return;
      const ordered = Object.keys(PROVIDERS).filter((id) => found.includes(id));
      setAvailable(ordered);
      setProvider((current) => ordered.includes(current) ? current : ordered[0] || current);
    };
    void probe();
    return () => {
      alive = false;
    };
  }, [rpcCall, nonce]);
  React.useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const result = await rpcCall("history.read", { provider, hours });
        if (!alive) return;
        setData(result);
        setError("");
      } catch (e) {
        if (alive) setError(e?.message || "无法读取历史");
      }
    };
    void read();
    if (!visible) return () => {
      alive = false;
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void read();
    }, 3e4);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [provider, hours, rpcCall, visible]);
  const refresh = async () => {
    setBusy(true);
    try {
      const result = await rpcCall("history.read", { provider, hours });
      setData(result);
      setError("");
      setNonce((n) => n + 1);
    } catch (e) {
      setError(e?.message || "无法读取历史");
    } finally {
      setBusy(false);
    }
  };
  const accounts = data?.accounts || [];
  const row = accounts.find((a) => a.accountId === accountId) || accounts[0];
  const points = row?.points || [];
  const last = points[points.length - 1];
  const latestValid = points.filter((p) => p.status === "ok")[points.filter((p) => p.status === "ok").length - 1];
  const units = [...new Set((latestValid?.packages || []).filter((p) => p.active).map((p) => p.unit))];
  const unit = units.length === 1 ? units[0] : "额度";
  const recent = points.filter((p) => p.change?.kind === "usage");
  const estimate = recent.reduce((sum, p) => sum + p.change.amount, 0);
  const span = recent.reduce((sum, p) => sum + p.change.minutes, 0);
  const sourceList = available?.length ? available : Object.keys(PROVIDERS);
  const hasAccounts = accounts.length > 0;
  return h(
    "div",
    {
      style: { height: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", padding: "10px 12px 20px", fontSize: 12, color: TOKEN.text, display: "flex", flexDirection: "column" }
    },
    // ---- controls -------------------------------------------------------
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
      h("select", {
        "aria-label": "API 来源",
        value: provider,
        style: { ...selectStyle, flex: "1 1 110px" },
        onChange: (e) => {
          setProvider(e.target.value);
          setAccountId("");
        }
      }, sourceList.map((id) => h("option", { key: id, value: id }, PROVIDERS[id] || id))),
      h("button", {
        type: "button",
        onClick: () => void refresh(),
        disabled: busy,
        title: "重新读取本机历史",
        style: { ...selectStyle, cursor: "pointer", opacity: busy ? 0.55 : 1 }
      }, busy ? "读取中…" : "刷新")
    ),
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 } },
      accounts.length > 1 ? h("select", {
        "aria-label": "历史账号",
        value: row?.accountId || "",
        style: { ...selectStyle, flex: "1 1 120px" },
        onChange: (e) => setAccountId(e.target.value)
      }, accounts.map((a) => h("option", { key: a.accountId, value: a.accountId }, a.nickname || a.accountId))) : row ? h("span", { style: { color: TOKEN.sub, flex: "1 1 auto" } }, row.nickname || row.accountId) : null,
      h(Segmented, { value: hours, onChange: setHours, options: RANGES })
    ),
    error ? h("p", { role: "alert", style: { color: TOKEN.error, margin: "10px 0 0" } }, error) : null,
    // ---- hero numbers ---------------------------------------------------
    h(
      "div",
      { style: { marginTop: 14, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" } },
      h(
        "span",
        { style: { fontSize: 26, fontWeight: 650, letterSpacing: "-0.02em" } },
        last?.status === "ok" ? fmt(last.total) : "—"
      ),
      h("span", { style: { fontSize: 11, color: TOKEN.sub } }, hasAccounts ? unit : "暂无账号")
    ),
    h(
      "div",
      { style: { marginTop: 4, fontSize: 11, color: TOKEN.sub, lineHeight: 1.6 } },
      recent.length ? `区间净消耗 ${fmt(estimate)} ${unit} · 覆盖约 ${duration(span)} · ${recent.length} 段` : "本区间暂无可估算的连续消耗"
    ),
    // ---- the chart ------------------------------------------------------
    // `flex: 1 1 auto` lets the hero chart absorb the tab's leftover height, so
    // a tall sidebar gets a big chart instead of dead space under a fixed one.
    h(
      "div",
      { style: { marginTop: 10, flex: "1 1 auto", minHeight: 200, display: "flex", flexDirection: "column" } },
      h(Trend, { points })
    ),
    // ---- status ---------------------------------------------------------
    h(
      "p",
      { style: { fontSize: 11, color: TOKEN.faint, margin: "8px 0 0", lineHeight: 1.65 } },
      last ? `${stamp(last.at)} · ${last.status === "ok" ? describe(last.change) : "查询失败，历史保留缺口"}` : "正在等待第一次采样。"
    ),
    // ---- details --------------------------------------------------------
    points.length > 1 ? h(
      "details",
      { style: { marginTop: 12 } },
      h("summary", { style: { cursor: "pointer", fontSize: 11, color: TOKEN.sub } }, `最近 ${Math.min(12, points.length)} 次采样明细`),
      h(
        "div",
        { style: { overflowX: "auto", marginTop: 8 } },
        h(
          "table",
          { style: { width: "100%", fontSize: 11, borderCollapse: "collapse" } },
          h("thead", null, h("tr", null, ["时间", "余额", "期间变化"].map((label) => h("th", {
            key: label,
            style: { textAlign: "left", padding: "4px 6px", color: TOKEN.faint, fontWeight: 500, whiteSpace: "nowrap" }
          }, label)))),
          // Key by position too: the host's `view()` does not deduplicate, so two
          // samples can share one timestamp (clock adjustment, manual repair).
          h("tbody", null, points.slice(-12).reverse().map((p, i) => h(
            "tr",
            { key: `${p.at}-${p.status}-${i}` },
            h("td", { style: { padding: "4px 6px", whiteSpace: "nowrap", color: TOKEN.sub } }, stamp(p.at)),
            h("td", { style: { padding: "4px 6px", whiteSpace: "nowrap" } }, p.status === "ok" ? fmt(p.total) : "查询失败"),
            h("td", { style: { padding: "4px 6px", color: TOKEN.faint } }, describe(p.change))
          )))
        )
      )
    ) : null,
    // ---- caveats --------------------------------------------------------
    h(
      "p",
      { style: { fontSize: 10.5, color: TOKEN.faint, margin: "12px 0 0", lineHeight: 1.7 } },
      "用量是相邻余额的净下降估算，包含此账号在其他客户端的消费；积分补充、到期或周期重置可能遮蔽实际消耗，跨日、资源包变化与断点均不计入。历史保留 30 天，退出 dsh 后暂停采样。"
    )
  );
}
function HistorySettings({ rpcCall }) {
  const first = Object.keys(PROVIDERS)[0];
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    rpcCall("history.read", { provider: first, hours: 1 }).then((result) => {
      if (alive) setData(result);
    }).catch((e) => {
      if (alive) setError(e?.message || "无法读取采样设置");
    });
    return () => {
      alive = false;
    };
  }, [rpcCall, first]);
  const configure = async (payload) => {
    setBusy(true);
    try {
      const result = await rpcCall("history.configure", payload);
      setData((prev) => ({ ...prev, ...result }));
      setError("");
    } catch (e) {
      setError(e?.message || "设置保存失败");
    } finally {
      setBusy(false);
    }
  };
  const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "7px 0" };
  return h(
    "div",
    { style: { fontSize: 12, padding: "2px 0" } },
    h(
      "div",
      { style: rowStyle },
      h("span", null, "后台记录"),
      h("input", {
        type: "checkbox",
        checked: data?.enabled ?? true,
        disabled: busy || !data,
        onChange: (e) => void configure({ enabled: e.target.checked })
      })
    ),
    h(
      "div",
      { style: rowStyle },
      h("span", null, "采样间隔"),
      h("select", {
        style: selectStyle,
        value: data?.intervalMinutes || 15,
        disabled: busy || !data,
        onChange: (e) => void configure({ intervalMinutes: Number(e.target.value) })
      }, h("option", { value: 15 }, "15 分钟"), h("option", { value: 5 }, "5 分钟"))
    ),
    error ? h("p", { role: "alert", style: { color: TOKEN.error, margin: "6px 0 0" } }, error) : null,
    h(
      "p",
      { style: { fontSize: 10.5, color: TOKEN.faint, margin: "8px 0 0", lineHeight: 1.7 } },
      "自动采样设置对全部 API 源生效，后台按来源与账号串行执行。仅自动采样失败时延长间隔，最多 60 分钟。关闭本面板仍会采样，退出 dsh 才暂停。Jet Hub 的手动查询保持原有行为。"
    )
  );
}

// client-src/index.js
var h2 = React2.createElement;
var name = "credit-history-client";
var inject = ["connection", "betterSidebar"];
var TAB_ID = "credit-history";
function apply(ctx) {
  const rpcCall = async (method, payload) => {
    const result = await ctx.connection.rpc.call("/api", "credit-history", { method, payload });
    if (!result?.ok) throw new Error(result?.error?.message || "无法读取积分历史");
    return result.value;
  };
  ctx.inject(["betterSidebar"], (scope) => {
    scope.effect(() => scope.betterSidebar.registerTab({
      id: TAB_ID,
      title: "积分历史",
      description: "各 API 源的积分余额走势与消耗估算",
      order: 30,
      single: true,
      settings: {
        // The gear renders the plugin's OWN panel rather than declarative
        // rows: these controls write the backend's sampler state, and a
        // declarative `pluginToggles` row would keep a second, divergent
        // copy of the same value in the sidebar's prefs document.
        render: () => h2(HistorySettings, { rpcCall })
      },
      component: (props) => h2(CreditHistoryPanel, {
        rpcCall,
        visible: props.visible !== false
      })
    }), "credit-history: sidebar tab");
  });
}

return module.exports;}});
