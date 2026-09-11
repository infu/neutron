// Only Kernel/backend calls and public ledger facts are fixtures. The funding
// parser, presentation controller, and React dialog all come from Wallet.
export * from '../../../../packages/neutron-tools/src/app_entry.ts';

const owner = 'togwv-zqaaa-aaaal-qr7aa-cai';
const requestId = '00112233445566778899aabbccddeeff';
const command = {
  caller_app_id: 'swap',
  request_id: Uint8Array.from({ length: 16 }, (_, index) => index * 17),
};
export const request = {
  requestId,
  ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai',
  amountAtoms: '123456789',
  validUntilNs: '1800000000000000000',
  route: { kind: 'allowance', spender: owner, expiresAtNs: '1800000300000000000' },
};
const review = {
  command_id: command,
  kind: { allowance: null },
  ledger: request.ledger,
  token_name: 'Internet Computer',
  token_symbol: 'ICP',
  decimals: '8',
  amount_atoms: request.amountAtoms,
  transfer_fee_atoms: '10',
  approval_fee_atoms: '10',
  allowance_atoms: '123456799',
  current_allowance_atoms: '0',
  total_debit_atoms: '123456809',
  spender: { icrc: { owner } },
  valid_until_ns: request.validUntilNs,
  expires_at_ns: request.route.expiresAtNs,
};
const scenario = new URLSearchParams(location.search).get('scenario');
export const state = window.__funding = {
  queries: [],
  updates: [],
  invalidations: 0,
  factsReads: 0,
  result: null,
  failure: null,
  settled: false,
  releaseLookup: null,
};

export async function querySelf(method, args) {
  state.queries.push({ method, args });
  if (method === 'wallet_read_v1') {
    if ('snapshot' in args[0]) return { snapshot: { owner, configured: true, ledgers: [] } };
    if ('catalog' in args[0]) return { catalog: [] };
    if ('funding_preview' in args[0]) {
      if (!args[0].funding_preview.lookup_only) {
        return { funding_preview: { ok: {
          durable: false,
          preparation: { prepared: { command_id: command, review } },
        } } };
      }
      await new Promise(resolve => { state.releaseLookup = resolve; });
      // An absent Candid option is omitted in actual Kernel self-call replies.
      return { funding_preview: { ok: scenario === 'explicit-null'
        ? { durable: false, preparation: null }
        : { durable: false } } };
    }
  }
  if (method === 'wallet_transfers_pending_v2') return [];
  throw new Error(`Unexpected Wallet query: ${method}`);
}

export async function updateSelf(method, args) {
  state.updates.push({ method, args });
  throw new Error(`Cancellation must not update or pay: ${method}`);
}

export async function publishAppStateChange() {
  state.invalidations += 1;
}

export async function readFacts() {
  state.factsReads += 1;
  return { owner, metadata: [], fee: '10', allowance: null };
}

export const context = {
  audience: 'foreground_tile',
  caller: { endpoint: 'app:swap:tile', appId: 'swap', role: 'tile', sessionId: 'swap-session' },
  agentMode: false,
  reportProgress: () => undefined,
  kernel: { querySelf, updateSelf },
};
