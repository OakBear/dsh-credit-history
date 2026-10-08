/**
 * DSH home 解析（本插件**自带**，不依赖任何宿主插件）。
 *
 * 优先级与宿主侧 `resolveJetHubHome`（dsh-codearts-auth）保持一致：
 * `DSH_JET_HUB_STATE_DIR` → `profileContext.home` → `DSH_HOME` → `~/.dsh`。
 *
 * ⚠️ 第一级沿用 `DSH_JET_HUB_STATE_DIR` 这个名字：单测隔离统一走它，
 * 且与整合期写下的状态目录判定完全同序，避免「同一台机器两套解析结果」。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
/** 从 ctx 上安全读一个服务（ctx.get 可能不存在 —— 最小测试桩）。 */
function readService(ctx, key) {
    const get = ctx?.get;
    if (typeof get !== 'function')
        return undefined;
    return get.call(ctx, key);
}
export function resolveDshHome(ctx) {
    const override = process.env.DSH_JET_HUB_STATE_DIR;
    if (override !== undefined && override.trim().length > 0)
        return override.trim();
    const profileHome = readService(ctx, 'profileContext')?.home;
    if (typeof profileHome === 'string' && profileHome.length > 0)
        return profileHome;
    const envHome = process.env.DSH_HOME;
    if (envHome !== undefined && envHome.trim().length > 0)
        return envHome.trim();
    return join(homedir(), '.dsh');
}
