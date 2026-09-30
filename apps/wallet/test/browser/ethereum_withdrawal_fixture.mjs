export { isJsonObject, loadNeutronCanisterId } from '../../../../packages/neutron-tools/src/app.ts';
export const ledger = { id: 1, principal: 'cngnf-vqaaa-aaaar-qag4q-cai', symbol: 'ckUSDT', name: 'Chain-key USDT', decimals: 6, fee: '10000', balance: '100000000', logo: null };
const gasLedger = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const minter = 'sv3dd-oaaaa-aaaar-qacoa-cai';
export const state = window.__withdrawal = { calls: [], prepared: [], burns: 0, resumes: 0 };
export const createMsgBusClient = () => ({});
export async function updateSelf(method, args) {
  state.calls.push(method);
  if (method === 'wallet_withdrawal_quote_v1') return {
    ledger: ledger.principal, minter, observed_at_ns: '1790017850447706173',
    asset_fee: '10000', asset_balance: '100000000',
    gas: { ledger: gasLedger, estimate: '132281730360000', budget: '158738076432000', ledger_fee: '2000000000000',
      allowance: '158738076432000', total_debit: '160738076432000', balance: '2724779577700000', sufficient: true },
    authorization: { asset_fee: '10000', gas: { ledger: gasLedger, minter, budget: '158738076432000', ledger_fee: '2000000000000' } },
  };
  if (method === 'wallet_ethereum_withdraw_prepare_v1') {
    const previous = state.prepared.find(row => row.request_id.toString() === args[0].request_id.toString());
    if (!previous) state.prepared.push({ ...args[0] });
    return operation(args[0], previous?.accepted ? { succeeded: {} } : { pending: null });
  }
  if (method === 'wallet_transfer_resume_v2') {
    state.resumes++;
    const saved = state.prepared.find(row => row.request_id.toString() === args[0].toString());
    const lost = location.search.includes('lost');
    if (state.resumes === 1 && !lost) return operation(saved, { rejected: 'The minter requires more ckETH. No withdrawal burn occurred; approval fees were charged. Refresh costs and review the maximum again.' });
    if (!saved.accepted) state.burns++;
    saved.accepted = true;
    if (lost) throw new Error('Lost minter response');
    return operation(saved, { succeeded: {} });
  }
  throw new Error(`Unexpected call ${method}`);
}
function operation(saved, status) {
  if ('succeeded' in status) status = { succeeded: { block_index: '91', duplicate: false, native: true } };
  return { request_id: saved.request_id, ledger: ledger.principal, amount: saved.amount, destination: saved.address, native: true, status };
}
