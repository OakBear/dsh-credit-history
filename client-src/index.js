import * as React from 'react';
import { CreditHistoryPanel, HistorySettings, Trend, PROVIDERS } from './credit-history-panel.js';
const h = React.createElement;

export const name = 'credit-history-client';

/**
 * Cordis SERVICES this client half needs at runtime.
 * `betterSidebar` is the extension point provided by `dsh-better-sidebar`
 * (registered through `package.json` → `dsh.client.inject`); `connection`
 * carries the plugin's own `/api/credit-history` RPC.
 */
export const inject = ['connection', 'betterSidebar'];

const TAB_ID = 'credit-history';

export function apply(ctx) {
  const rpcCall = async (method, payload) => {
    const result = await ctx.connection.rpc.call('/api', 'credit-history', { method, payload });
    if (!result?.ok) throw new Error(result?.error?.message || '无法读取积分历史');
    return result.value;
  };

  // ---- the sidebar tab -------------------------------------------------
  // Registered on the host's shared sidebar service, so this tab behaves
  // exactly like the built-ins (Editor / Changes / Tasks). It replaces the
  // former `settings.section` entry: there is now ONE surface for the data,
  // and the background-sampling controls moved into this tab's own gear.
  ctx.inject(['betterSidebar'], scope => {
    scope.effect(() => scope.betterSidebar.registerTab({
      id: TAB_ID,
      title: '积分历史',
      description: '各 API 源的积分余额走势与消耗估算',
      order: 30,
      single: true,
      settings: {
        // The gear renders the plugin's OWN panel rather than declarative
        // rows: these controls write the backend's sampler state, and a
        // declarative `pluginToggles` row would keep a second, divergent
        // copy of the same value in the sidebar's prefs document.
        render: () => h(HistorySettings, { rpcCall }),
      },
      component: props => h(CreditHistoryPanel, {
        rpcCall,
        visible: props.visible !== false,
      }),
    }), 'credit-history: sidebar tab');
  });
}

/** Re-exported for tests and for anyone composing the panel elsewhere. */
export { CreditHistoryPanel, HistorySettings, Trend, PROVIDERS };
