import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_SAMPLING_MINUTES,
  SAMPLING_MINUTES,
  samplingSelectValue,
} from '../../plugin-src/client/history-settings.js'
import { ALLOWED_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES } from '../../src/credit-history.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 「积分历史」设置面板里采样间隔的取值与选项。
 *
 * ## 为什么需要
 *
 * 采样默认值由 15 分钟改为 5 分钟时，**引擎改了、面板没改**：下拉框的兜底值
 * 与选项顺序都还停在 15。这类缺陷不报错、不崩，只是静默不一致 —— 用户看到
 * 「15 分钟」再跳成「5 分钟」，会以为自己设的值被改回去了。故把它钉死。
 *
 * ## 为什么能测
 *
 * 判据抽在 `plugin-src/client/history-settings.js`（纯模块）。面板本体是
 * `import * as React from 'react'` 的组件，而本仓库的测试环境是 `node`、
 * **react 不在依赖里**，渲染不了 —— 所以凡是判据都必须能脱离组件跑。
 */
describe('采样间隔的选项与兜底值', () => {
  it('默认值排在第一位（它就是用户最该看到的值）', () => {
    expect(SAMPLING_MINUTES[0]).toBe(DEFAULT_SAMPLING_MINUTES)
    expect(DEFAULT_SAMPLING_MINUTES).toBe(5)
  })

  it('⚠️ 兜底值必须是 5，不是旧的 15', () => {
    // 数据未到达时（`data` 为 undefined）显示的值。
    expect(samplingSelectValue(undefined)).toBe(5)
    expect(samplingSelectValue(null)).toBe(5)
    expect(samplingSelectValue({})).toBe(5)
  })

  it('后端给了合法值就显示它（15 是用户显式选过的，必须被尊重）', () => {
    expect(samplingSelectValue({ intervalMinutes: 15 })).toBe(15)
    expect(samplingSelectValue({ intervalMinutes: 5 })).toBe(5)
  })

  it('⚠️ 表外的值回落到默认，而不是原样透传', () => {
    // 透传会让浏览器找不到对应 <option> ⇒ 下拉框显示**空白**，
    // 看起来像「从未设置过」，而后端其实是有值的。
    for (const bogus of [0, 7, 30, 60, -5, 1.5, NaN, '15', null]) {
      expect(samplingSelectValue({ intervalMinutes: bogus }), `intervalMinutes=${String(bogus)}`)
        .toBe(DEFAULT_SAMPLING_MINUTES)
    }
  })

  it('⚠️ 选项表必须与引擎的 ALLOWED_INTERVAL_MINUTES 逐值一致', () => {
    // 多一个选项 ⇒ 用户能选中一个后端**拒绝**的值，表现为「保存后弹红字、值又跳回去」。
    // 少一个选项 ⇒ 后端允许的值用户在 UI 上选不到。
    // ⚠️ 直接 import 引擎常量比对，而不是正则解析源码文本 ——
    // 文本解析会被类型标注（`readonly number[]`）之类无关改动弄瞎，
    // 实测第一版就因此误报「找不到字面量」。
    expect([...SAMPLING_MINUTES].sort((a, b) => a - b))
      .toEqual([...ALLOWED_INTERVAL_MINUTES].sort((a, b) => a - b))
  })

  it('⚠️ 默认值必须与引擎的 DEFAULT_INTERVAL_MINUTES 一致', () => {
    expect(DEFAULT_SAMPLING_MINUTES).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(DEFAULT_INTERVAL_MINUTES).toBe(5)
  })

  it('⚠️ 面板必须用这两个纯函数，不得自己写字面量', () => {
    // 反向保护：把面板改回 `data?.intervalMinutes || 15` 内联写法时，
    // 上面几条仍然全绿（它们只测纯模块），缺陷会重新溜回去。
    const panel = readFileSync(resolve(here, '../../plugin-src/client/credit-history-panel.js'), 'utf8')
    expect(panel).toContain('samplingSelectValue(data)')
    expect(panel).toContain('SAMPLING_MINUTES.map(')
    // 面板里不得再出现硬编码的 15 兜底 / 手写 <option>
    expect(panel).not.toMatch(/intervalMinutes\s*\|\|\s*15/)
    expect(panel).not.toMatch(/h\('option',\s*\{\s*value:\s*15\s*\}/)
  })
})
