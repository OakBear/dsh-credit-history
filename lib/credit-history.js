import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const PROVIDERS = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon'];
const MINUTE = 60000;
const RETENTION = 30 * 24 * 60 * MINUTE;
const round = n => Math.round(n * 1000000) / 1000000;
const day = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

// 仅保存余额和资源包口径；凭据及服务端错误原文不写入历史。
export function makePoint(item, at) {
  const b = item.balance;
  if (!b || !Number.isFinite(b.total) || b.total < 0) return { at, status: 'failed' };
  const packages = (b.packages || []).map(p => ({
    name: String(p.name || ''), unit: String(p.unit || '积分'), active: p.active !== false,
    remaining: Number.isFinite(p.remaining) ? p.remaining : null,
    total: Number.isFinite(p.total) ? p.total : p.remaining,
    used: Number.isFinite(p.used) ? p.used : 0,
    cycleStartTime: String(p.cycleStartTime || ''), cycleEndTime: String(p.cycleEndTime || ''), expiredTime: String(p.expiredTime || ''),
    cycle: `${p.cycleStartTime || ''}/${p.cycleEndTime || ''}/${p.expiredTime || ''}`,
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { at, status: 'ok', total: b.total, expiredTotal: Number.isFinite(b.expiredTotal) ? b.expiredTotal : 0, packages };
}

export function changeBetween(previous, current, intervalMinutes = 15) {
  if (!previous || previous.status !== 'ok' || current.status !== 'ok') return { kind: 'gap' };
  const minutes = (current.at - previous.at) / MINUTE;
  if (minutes <= 0 || minutes > intervalMinutes * 2.5) return { kind: 'gap', minutes };
  if (day(previous.at) !== day(current.at)) return { kind: 'reset', minutes };
  const identity = p => JSON.stringify(p.packages.map(x => [x.name, x.unit, x.active, x.cycle]));
  if (identity(previous) !== identity(current)) return { kind: 'reset', minutes };
  // 同时有资源包增加和减少时不能把净变化冒充纯消耗。
  const increase = current.total > previous.total + 0.000001 || current.packages.some((p, i) =>
    p.remaining !== null && previous.packages[i]?.remaining !== null && p.remaining > previous.packages[i]?.remaining + 0.000001);
  if (increase) return { kind: 'increase', minutes, amount: round(current.total - previous.total) };
  return { kind: 'usage', minutes, amount: round(Math.max(0, previous.total - current.total)) };
}

export class CreditHistory {
  constructor({ home, query, accounts, warn = () => {}, now = Date.now, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.query = query; this.accounts = accounts; this.warn = warn; this.now = now; this.pause = pause;
    this.path = join(home, 'credit-history', 'history.json');
    this.state = { version: 1, enabled: true, intervalMinutes: 15, series: {}, attempts: {}, failures: {} };
    let migrated = false;
    try {
      let raw;
      try { raw = readFileSync(this.path, 'utf8'); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        raw = readFileSync(join(home, 'jet-hub', 'credit-history.json'), 'utf8');
        migrated = true;
      }
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.series || !parsed.attempts) throw new Error('历史格式不兼容');
      this.state = { ...this.state, ...parsed, intervalMinutes: parsed.intervalMinutes === 5 ? 5 : 15 };
    } catch (e) { if (e.code !== 'ENOENT') throw new Error(`无法读取积分历史，保留原文件：${e.message}`); }
    this.cache = new Map(); this.tail = Promise.resolve(); this.closed = false;
    // 迁移到独立目录，原历史文件保留，卸载新插件不改变 Jet Hub。
    if (migrated) this.save();
  }
  enqueue(fn) {
    const job = this.tail.then(() => { if (this.closed) throw new Error('积分记录已停止'); return fn(); });
    this.tail = job.catch(() => {}); return job;
  }
  save() {
    const cutoff = this.now() - RETENTION;
    for (const [key, row] of Object.entries(this.state.series)) {
      row.points = row.points.filter(p => p.at >= cutoff).slice(-9000);
      if (!row.points.length) delete this.state.series[key];
    }
    mkdirSync(join(this.path, '..'), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
  interval(provider) {
    return Math.min(60, this.state.intervalMinutes * 2 ** Math.min(3, this.state.failures[provider] || 0)) * MINUTE;
  }
  balances(provider) {
    if (!PROVIDERS.includes(provider)) return Promise.resolve({ ok: false, error: { code: 'bad-request', message: '不支持的积分来源' } });
    return this.enqueue(async () => {
      const entries = await this.accounts(provider);
      const signature = entries.map(a => `${a.id}:${a.credentialRef}`).sort().join('|');
      const cached = this.cache.get(provider);
      const last = this.state.attempts[provider] || 0;
      const cooldown = Math.max(5 * MINUTE, this.interval(provider));
      if (this.now() - last < cooldown) {
        if (cached?.signature === signature) return { ...cached.result, value: { ...cached.result.value, cached: true, sampledAt: last, nextQueryAt: last + cooldown } };
        // 重启后可展示已存余额，无需马上重查远端。
        return { ok: true, value: { cached: true, sampledAt: last, nextQueryAt: last + cooldown, accounts: entries.map(a => {
          const row = this.state.series[`${provider}/${a.id}`];
          const p = row?.points.at(-1);
          return { accountId: a.id, nickname: a.nickname, balance: p?.status === 'ok' ? { total: p.total, packages: p.packages, expiredTotal: p.expiredTotal || 0 } : null,
            error: p?.status === 'ok' ? undefined : '等待下次低频采样' };
        }) } };
      }
      await this.pause(2000);
      const at = this.now();
      this.state.attempts[provider] = at;
      // 先落盘查询时间，进程重启也不会反复请求。
      this.save();
      let result;
      try { result = await this.query(provider); }
      catch { result = { ok: true, value: { accounts: entries.map(a => ({ accountId: a.id, nickname: a.nickname, balance: null, error: '余额查询失败，请稍后重试' })) } }; }
      if (this.closed) return result;
      const items = result.ok ? result.value.accounts || [] : [];
      const completedAt = this.now();
      for (const entry of entries) {
        const item = items.find(i => i.accountId === entry.id) || { balance: null };
        const key = `${provider}/${entry.id}`;
        const row = this.state.series[key] ||= { provider, accountId: entry.id, nickname: entry.nickname, points: [] };
        row.nickname = entry.nickname;
        row.points.push({ ...makePoint(item, completedAt), intervalMinutes: this.state.intervalMinutes });
      }
      const success = items.some(i => i.balance && Number.isFinite(i.balance.total));
      this.state.failures[provider] = success || !entries.length ? 0 : (this.state.failures[provider] || 0) + 1;
      this.save();
      if (result.ok) result.value = { ...result.value, sampledAt: completedAt, nextQueryAt: at + this.interval(provider), cached: false };
      this.cache.set(provider, { signature, result });
      return result;
    });
  }
  view(provider, hours = 24) {
    const cutoff = this.now() - Math.max(1, Math.min(168, Number(hours) || 24)) * 60 * MINUTE;
    return { enabled: this.state.enabled, intervalMinutes: this.state.intervalMinutes, retentionDays: 30,
      nextQueryAt: (this.state.attempts[provider] || 0) + this.interval(provider),
      accounts: Object.values(this.state.series).filter(r => r.provider === provider).map(row => {
        const points = row.points.filter(p => p.at >= cutoff);
        return { ...row, points: points.map((p, i) => ({ ...p, change: changeBetween(i ? points[i - 1] : undefined, p, p.intervalMinutes || this.state.intervalMinutes) })) };
      }) };
  }
  configure(payload) {
    return this.enqueue(() => {
      if (payload.intervalMinutes !== undefined && ![5, 15].includes(payload.intervalMinutes)) throw new Error('仅支持 5 或 15 分钟采样');
      if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
      if (payload.intervalMinutes !== undefined) this.state.intervalMinutes = payload.intervalMinutes;
      if (payload.enabled !== undefined) this.state.enabled = payload.enabled;
      this.save(); return { enabled: this.state.enabled, intervalMinutes: this.state.intervalMinutes };
    });
  }
  start() {
    let running = false;
    const tick = async () => {
      if (running || this.closed || !this.state.enabled) return;
      running = true;
      try {
        for (const provider of PROVIDERS) {
          if (this.closed || !this.state.enabled) break;
          if (this.now() - (this.state.attempts[provider] || 0) < this.interval(provider)) continue;
          if (!(await this.accounts(provider)).length) continue;
          await this.balances(provider);
        }
      } catch (e) { this.warn(`积分记录失败：${e.message}`); }
      finally { running = false; }
    };
    this.timer = setInterval(() => void tick(), 30000); this.timer.unref?.();
    return () => { this.closed = true; clearInterval(this.timer); };
  }
}
