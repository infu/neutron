// Fixture transport and state for the actual Wallet bridge UI and executor.
export { isJsonObject } from 'neutron-tools/protocol';
export { bridgeComplete, bridgeLabel, executeBridgeDeposit } from '../../src/bridge.ts';

const account = '0x' + '11'.repeat(20), hash = '0x' + 'ab'.repeat(32);
const quote = { chainId: '1', ledger: 'ss2fx-dyaaa-aaaar-qacoq-cai', minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', helperAddress: '0x' + '22'.repeat(20), helperMode: 'subaccount', minterAddress: '0x' + '33'.repeat(20), tokenAddress: null, recipient: 'aaaaa-aa', principalWord: '0x' + '00'.repeat(32), subaccountWord: '0x' + '00'.repeat(32) };
const scenario = new URLSearchParams(location.search).get('scenario');
const saved = { id: '01'.repeat(16), quote, source: 'external', account, amount: '12000000000000000', revision: '0', createdAt: '1788868800000000000', updatedAt: '1788868800000000000', eventCursor: '0', acceptedDeposit: null, mint: null, error: null, steps: ['reset_approval', 'approval', 'deposit'].map(kind => ({kind, state: 'ready', operationId: null, transactionHash: null, error: null})) };
if (scenario === 'refresh' || scenario === 'confirmed') Object.assign(saved.steps[2], { state: scenario === 'refresh' ? 'submitted' : 'confirmed', transactionHash: hash });
if (scenario === 'unknown') saved.steps[2].state = 'unknown';
const h = window.__bridge = { calls: [], records: scenario && scenario !== 'quote' ? [saved] : [], holdQuote: scenario === 'quote', holdRefresh: scenario === 'refresh', quoteError: null, account, sends: 0, refreshes: 0 };
const log = (method, detail = null) => h.calls.push({method, detail});
const read = id => structuredClone(h.records.find(x => x.id === id));
const save = record => { h.records = [structuredClone(record), ...h.records.filter(x => x.id !== record.id)]; return structuredClone(record); };
const client = {
  async list() { log('list'); return structuredClone(h.records); },
  async dismissed() { return []; },
  async quote() {
    log('quote:start');
    if (h.holdQuote) await new Promise(resolve => { h.releaseQuote = () => { h.holdQuote = false; resolve(); }; });
    if (h.quoteError) throw new Error(h.quoteError);
    log('quote:end'); return structuredClone(quote);
  },
  async prepare(input) { log('prepare', input); return save({...structuredClone(saved), ...input}); },
  async status(id) { return read(id); },
  async refresh(id) {
    log('refresh:start', id);
    if (h.holdRefresh) await new Promise(resolve => { h.releaseRefresh = () => { h.holdRefresh = false; resolve(); }; });
    log('refresh:end', id); return read(id);
  },
  async claim(previous, kind, operationId) {
    const current = read(previous.id);
    if (previous.revision !== current.revision) throw new Error('revision conflict');
    const step = current.steps.find(x => x.kind === kind);
    if (step.state !== 'ready') throw new Error('already claimed');
    step.state = 'unknown'; step.operationId = operationId;
    current.revision = String(BigInt(current.revision) + 1n); log('claim', kind); return save(current);
  },
  async record(previous, kind, state, transactionHash, error = null) {
    const current = read(previous.id);
    if (previous.revision !== current.revision) throw new Error('revision conflict');
    Object.assign(current.steps.find(x => x.kind === kind), { state, transactionHash, error });
    current.revision = String(BigInt(current.revision) + 1n); log('record', {kind, state}); return save(current);
  },
  async effectiveHash(id, kind) { return read(id).steps.find(x => x.kind === kind).transactionHash; },
};
export function createBridgeClient() { return client; }
export async function connectEthereumProvider() {
  log('connect', { active: navigator.userActivation.isActive });
  let closed = false;
  return {
    info: { name: 'Browser fixture', rdns: null },
    provider: { async request({method, params}) {
      if (closed) throw new Error('Fixture session already closed');
      log(method, params);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [h.account];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getCode') return '0x6001';
      if (method === 'eth_call') return '0x' + '00'.repeat(12) + '33'.repeat(20);
      if (method === 'eth_sendTransaction') { h.sends++; return hash; }
      if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
      throw new Error('Unexpected Ethereum method: ' + method);
    } },
    async close() { if (closed) throw new Error('Connection closed twice'); closed = true; log('close'); },
  };
}
export function createMsgBusClient() { return {}; }
export function createEvmWalletClient() { return {}; }
export function createEvmRequestId() { return '02'.repeat(16); }
export async function connectEvmBridge() { throw new Error('Unexpected EVM Wallet connection'); }
export async function connectEvmBridgeReads() { throw new Error('Unexpected EVM Wallet reads'); }
export async function attachExternalBridgeTransaction() { throw new Error('Unexpected hash attachment'); }
export async function querySelf() { throw new Error('Unexpected real backend query'); }
export async function updateSelf() { throw new Error('Unexpected real backend update'); }

export async function loadNeutronCanisterId() { return "aaaaa-aa"; }
