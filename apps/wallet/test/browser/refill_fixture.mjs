import { quoteRefill, createRefillRequestId } from '../../src/refill.ts';
export { quoteRefill, createRefillRequestId };
const owner = '3rurp-vyaaa-aaaay-aacua-cai';
const stored = () => JSON.parse(sessionStorage.getItem('wallet-refills-fixture') || '[]');
const save = rows => { sessionStorage.setItem('wallet-refills-fixture', JSON.stringify(rows)); return rows; };
const state = window.__refill = { calls: [], opened: 0, snapshotError: false, scenario: new URLSearchParams(location.search).get('scenario'), operations: stored() };
if (state.scenario === 'pages' && state.operations.length === 0) state.operations = save(Array.from({length:50}, (_, index) => ({
  requestId: (index + 1).toString(16).padStart(32,'0'), kind: 'icp_topup', target: owner, amountAtoms: '10000000',
  icpFeeAtoms: '10000', cyclesFeeAtoms: '0', estimatedCycles: '130000000000',
  createdAtNs: (1789110000000000000n-BigInt(index)).toString(), updatedAtNs: '1789110000000000000', phase: index < 25 ? 'complete' : index === 49 ? 'prepared' : 'notify_pending',
  sourceBlockIndex: index === 49 ? null : String(1000+index), mintBlockIndex: null, forwardBlockIndex: null, refundBlockIndex: null,
  creditedCycles: index < 25 ? '130000000000' : null, mintedCycles: null, duplicate: false, canContinue: index >= 25 && index !== 49, error: null,
})));
const find = id => state.operations.find(row => row.requestId === id);
const put = row => { state.operations = save([row, ...state.operations.filter(item => item.requestId !== row.requestId)]); return structuredClone(row); };
export async function loadRefillSnapshot(requestedOwner) {
  state.calls.push({ method: 'snapshot', owner: requestedOwner });
  if (state.snapshotError) throw Error('Balance service temporarily unavailable');
  return { owner, observedAt: 1789110000000,
    icp: { ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', symbol: 'ICP', decimals: 8, balanceAtoms: '125000000', feeAtoms: '10000', error: null },
    tcycles: { ledger: 'um5iw-rqaaa-aaaaq-qaaba-cai', symbol: 'TCYCLES', decimals: 12, balanceAtoms: '2500000000000', feeAtoms: '100000000', error: null },
    rate: { xdrPermyriadPerIcp: '13000', timestampSeconds: '1789110000' }, errors: [] };
}
export async function listRefillPage(options = {}) {
  state.calls.push({ method: 'history', options });
  const rows = state.operations.filter(row => !options.pendingOnly || !['complete','refunded','stopped'].includes(row.phase));
  const start = options.before ? rows.findIndex(row => row.requestId === options.before.requestId) + 1 : 0;
  const operations = rows.slice(start, start + (options.limit || 20));
  const last = operations.at(-1);
  const nextCursor = start + operations.length < rows.length && last ? { createdAtNs: last.createdAtNs, requestId: last.requestId } : null;
  return structuredClone({ operations, nextCursor });
}
export async function readRefillStatus(id) { state.calls.push({ method: 'status', id }); return structuredClone(find(id) ?? null); }
export async function prepareRefill(quote, id) {
  state.calls.push({ method: 'prepare', id, quote });
  const operation = put({ requestId: id, kind: quote.kind, target: quote.target, amountAtoms: quote.amountAtoms,
    icpFeeAtoms: quote.icpFeeAtoms, cyclesFeeAtoms: quote.cyclesFeeAtoms, estimatedCycles: quote.estimatedCycles,
    createdAtNs: '1789110000000000000', updatedAtNs: '1789110000000000000', phase: 'prepared', sourceBlockIndex: null,
    mintBlockIndex: null, forwardBlockIndex: null, refundBlockIndex: null, creditedCycles: null, mintedCycles: null,
    duplicate: false, canContinue: false, error: null });
  if (state.scenario === "prepare-interrupted") throw Error("The preparation reply was interrupted; no payment was dispatched.");
  return operation;
}
const complete = op => ({ ...op, phase: 'complete', sourceBlockIndex: '1001', creditedCycles: op.kind === 'icp_to_tcycles' ? (BigInt(op.estimatedCycles) - BigInt(op.cyclesFeeAtoms) * (op.target === owner ? 1n : 2n)).toString() : op.estimatedCycles,
  mintedCycles: op.kind === 'icp_to_tcycles' ? op.estimatedCycles : null, canContinue: false, error: null });
export async function executeRefill(id) {
  state.calls.push({ method: 'execute', id });
  if (state.scenario === 'interrupted') {
    put({ ...find(id), sourceBlockIndex: '1001', phase: 'notify_pending', canContinue: true });
    throw Error('The connection was interrupted after payment. Your saved refill can continue.');
  }
  return put(complete(find(id)));
}
export async function continueRefill(id) { state.calls.push({ method: 'continue', id }); return put(complete(find(id))); }
