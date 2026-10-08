/**
 * 「积分历史」设置面板的两个纯判据。
 *
 * ## 为什么要单独一个文件
 *
 * 本仓库的测试环境是 `node`、**react 不在依赖里**，所以
 * `credit-history-panel.js`（顶部 `import * as React from 'react'`）无法被
 * import，组件也渲染不了。凡是**判据**都必须挪到这样的纯模块里才能真跑覆盖 ——
 * 与 `trend-geometry.js` / `new-account.js` / `credits-format.js` 同一做法。
 *
 * ## 这里锁的是什么缺陷
 *
 * 采样默认值从 15 分钟改成 5 分钟之后，面板里那两处**没跟着改**就会漂移：
 *
 * - 兜底值仍写 15 ⇒ 数据还没到时下拉框先显示「15 分钟」、随后跳成「5 分钟」，
 *   用户会以为自己选的 15 被改回去了；
 * - 选项顺序仍把 15 排第一 ⇒ 手滑点开下拉框的人容易选中一个**非默认**值，
 *   而「默认」在 UI 上应当是可恢复的。
 *
 * 这类「改了一处默认值、另一处还留着旧值」的缺陷不会报错、只会静默不一致，
 * 所以用纯函数把它钉死，而不是靠注释提醒。
 */

/**
 * 采样间隔的可选项，**默认值必须排第一**。
 *
 * ⚠️ 必须与宿主侧引擎的 `ALLOWED_INTERVAL_MINUTES`（`src/credit-history.ts`）
 * 保持一致：多一个选项会让用户选中一个后端**拒绝**的值，
 * 表现为「保存后弹红字、值又跳回去」。
 */
export const SAMPLING_MINUTES = [5, 15];

/** 宿主侧默认采样间隔（与 `DEFAULT_INTERVAL_MINUTES` 同值）。 */
export const DEFAULT_SAMPLING_MINUTES = SAMPLING_MINUTES[0];

/**
 * 设置面板里 `<select>` 应当显示的值。
 *
 * @param {{ intervalMinutes?: number | string | null } | undefined | null} data `history.read` /
 *   `history.configure` 的响应体；尚未取到时为 `undefined`。
 * @returns {number} 已在 `SAMPLING_MINUTES` 内的值，否则回落到默认值。
 *
 * ⚠️ **只认选项表里有的值**：若把后端来的任意数字直接喂给 `value`，
 * 浏览器会因为找不到对应 `<option>` 而**显示成空白**，用户看到的是一个
 * 没有选中项的下拉框 —— 比显示默认值更糟，因为它看起来像"没设置过"，
 * 而实际上后端是有值的。
 */
export function samplingSelectValue(data) {
  const value = /** @type {unknown} */ (data?.intervalMinutes);
  return SAMPLING_MINUTES.includes(value) ? value : DEFAULT_SAMPLING_MINUTES;
}
