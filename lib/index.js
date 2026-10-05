import { CreditHistory } from './credit-history.js';
import { loadBalanceModules, createBalanceReader } from './balance-reader.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-credit-history';
export const inject = ['accountPool', 'credentials', 'connection'];

export function registerHistoryRpc(connection, history) {
  return connection.fetch.register({
    path: '/api/credit-history', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return new Response('JSON required', { status: 415 });
      let message;
      try { message = await request.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
      const reply = result => Response.json({ type: 'server-response', rpcId: message.rpcId, result });
      if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== 'credit-history'
          || !message.payload || typeof message.payload.method !== 'string') {
        return reply({ ok: false, error: { code: 'bad-request', message: '无效的历史请求', details: {} } });
      }
      try {
        const { method, payload = {} } = message.payload;
        let value;
        if (method === 'history.read') value = history.view(payload.provider, payload.hours);
        else if (method === 'history.configure') value = await history.configure(payload);
        else throw new Error('历史页面只支持本地读取和设置；手动查询请使用 Jet Hub');
        return reply({ ok: true, value });
      } catch (e) {
        return reply({ ok: false, error: { code: 'credit-history/failed', message: e.message, details: {} } });
      }
    },
  });
}

export async function apply(ctx) {
  // 安装时不与仍在内存中的旧补丁同时采样；下一次进程启动自然解除。
  try {
    const pending = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.pending-restart.json'), 'utf8'));
    if (pending.processId === process.pid) { ctx.logger.info('独立积分历史已安装，等待本次 dsh 重启后启用。'); return; }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const profile = ctx.get('profileContext');
  if (!profile?.dir || !profile.home) throw new Error('积分历史需要 dsh profileContext');
  const pool = ctx.accountPool;
  if (typeof pool?.listAccounts !== 'function') throw new Error('积分历史需要启用 Jet Hub 账号插件');
  const modules = await loadBalanceModules(profile.dir);
  const accounts = provider => pool.listAccounts(provider);
  const query = createBalanceReader({ modules, accounts, resolve: ref => ctx.credentials.resolve(ref) });
  const history = new CreditHistory({ home: profile.home, accounts, query, warn: message => ctx.logger.warn(message) });
  ctx.effect(() => history.start(), 'credit-history: independent background sampler');
  ctx.effect(() => registerHistoryRpc(ctx.connection, history), 'credit-history: own RPC endpoint');
  ctx.logger.info('独立积分历史已启用；自动采样默认 15 分钟，Jet Hub 手动刷新保持原样。');
}
