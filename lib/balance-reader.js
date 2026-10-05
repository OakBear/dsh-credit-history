import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只复用原插件的只读余额协议函数，不包装或修改它的 RPC、账号管理及手动刷新。
export async function loadBalanceModules(profileDir) {
  const require = createRequire(join(profileDir, 'package.json'));
  const pluginRoot = dirname(require.resolve('dsh-codearts-auth/package.json'));
  const names = ['credits', 'product', 'codearts-credits', 'lobsterai-credits', 'lobsterai-product',
    'qoder-credits', 'qoder-product', 'trae-credits', 'trae-product', 'cline-credits', 'cline-product',
    'loomy-credits', 'loomy-product', 'raccoon-credits', 'raccoon-product'];
  const modules = {};
  for (const name of names) Object.assign(modules, await import(pathToFileURL(join(pluginRoot, 'lib', `${name}.js`))));
  const credentialModule = createRequire(join(pluginRoot, 'package.json')).resolve('@deepseek-ai/dsh-credentials');
  Object.assign(modules, await import(pathToFileURL(credentialModule)));
  return modules;
}

export function createBalanceReader({ modules: m, accounts, resolve, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  const simple = fn => async credential => ({ balance: await fn(credential) });
  const readers = {
    buddy: simple(c => m.fetchCreditBalance(c, m.CODEBUDDY)),
    workbuddy: simple(c => m.fetchCreditBalance(c, m.WORKBUDDY)),
    lobsterai: simple(c => m.fetchLobsteraiCreditBalance(c, m.LOBSTERAI)),
    qoder: simple(c => m.fetchQoderCreditBalance(c, m.QODER)),
    qodercn: simple(c => m.fetchQoderCreditBalance(c, m.QODER_CN)),
    trae: simple(c => m.fetchTraeCreditBalance(c, m.TRAE)),
    cline: c => m.fetchClineCreditBalance(c, m.CLINE),
    loomy: simple(c => m.fetchLoomyCreditBalance(c, m.LOOMY)),
    raccoon: simple(c => m.fetchRaccoonCreditBalance(m.RACCOON, c)),
    codearts: async c => {
      const result = await m.fetchCodeArtsAccountInfoDetailed(c);
      if (!result.ok) return { balance: null, error: result.message };
      if (!result.info.isCreditPackage) return { balance: null, error: '非积分计费账户，无积分余额' };
      return { balance: result.info.credit || null };
    },
  };
  return async provider => {
    if (!readers[provider]) throw new Error('不支持的积分来源');
    const items = [];
    for (const entry of await accounts(provider)) {
      // 此等待只属于后台采样；原插件的手动查询完全不经过这里。
      await pause(2000);
      let value;
      try {
        const credential = await resolve(m.credentialRef(entry.credentialRef));
        value = credential ? await readers[provider](JSON.parse(credential.value)) : { balance: null, error: '凭据未配置' };
      } catch { value = { balance: null, error: '余额查询失败' }; }
      items.push({ accountId: entry.id, nickname: entry.nickname, ...value });
    }
    return { ok: true, value: { accounts: items } };
  };
}
