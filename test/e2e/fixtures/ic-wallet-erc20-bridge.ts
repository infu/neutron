import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { Contract, Interface, JsonRpcProvider, Transaction, getAddress } from "ethers";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalNeutronRuntime } from "../../../packages/neutron-provision/src/local_session.ts";
import { localIdentityFromSeed } from "../../../packages/neutron-provision/src/kernel.ts";
import { createLocalEvmChain } from "./evm-wallet-chain.ts";
import { createIcWalletBridgeFixture, ledgerIdl, minterIdl, verifyMintBlock, type IcrcValue } from "./ic-wallet-bridge.ts";

const ledgerId = "xevnm-gaaaa-aaaar-qafnq-cai";
const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const minterId = "sv3dd-oaaaa-aaaar-qacoa-cai";
const tokenAbi = ["function owner() view returns(address)", "function mint(address,uint256)", "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function transfer(address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 amount)"];
const helperAbi = new Interface(["function deposit(address token,uint256 amount,bytes32 principal)", "function getMinterAddress() view returns(address)", "event ReceivedErc20(address indexed erc20_contract_address,address indexed owner,uint256 amount,bytes32 indexed principal)"]);
type Opt<T> = [] | [T];
type Account = { owner: Principal; subaccount: [] };
type Block = { id: bigint; block: IcrcValue };
type Ledger = {
  icrc1_balance_of: ActorMethod<[Account], bigint>;
  icrc1_fee: ActorMethod<[], bigint>;
  icrc1_minting_account: ActorMethod<[], Opt<Account>>;
  icrc2_allowance: ActorMethod<[{ account: Account; spender: Account }], { allowance: bigint }>;
  icrc3_get_blocks: ActorMethod<[[{ start: bigint; length: bigint }]], { blocks: Block[] }>;
};
type Source = { transaction_hash: string; log_index: bigint };
type Deposit = Source & { block_number: bigint; from_address: string; value: bigint; principal: Principal; subaccount: Opt<Uint8Array>; erc20_contract_address: string };
type Withdrawal = { max_transaction_fee: bigint; withdrawal_amount: bigint; erc20_contract_address: string; destination: string; cketh_ledger_burn_index: bigint; ckerc20_ledger_id: Principal; ckerc20_ledger_burn_index: bigint; from: Principal; from_subaccount: Opt<Uint8Array> };
type Payload = { AcceptedErc20Deposit: Deposit } | { MintedCkErc20: { event_source: Source; erc20_contract_address: string; mint_block_index: bigint; ckerc20_token_symbol: string } } | { AcceptedErc20WithdrawalRequest: Withdrawal } | { InvalidDeposit: { event_source: Source; reason: string } } | { QuarantinedDeposit: { event_source: Source } };
type Event = { timestamp: bigint; payload: Opt<Payload>; index: bigint };
type Minter = {
  get_events: ActorMethod<[{ start: bigint; length: bigint }], { events: Omit<Event, "index">[]; total_event_count: bigint }>;
  get_minter_info: ActorMethod<[], { minter_address: Opt<string>; erc20_helper_contract_address: Opt<string>; supported_ckerc20_tokens: Opt<{ ckerc20_token_symbol: string; erc20_contract_address: string; ledger_canister_id: Principal }[]> }>;
};
type Status = { NotFound: null } | { Pending: null } | { TxCreated: null } | { TxSent: { transaction_hash: string } } | { TxFinalized: { Success: { transaction_hash: string; effective_transaction_fee: Opt<bigint> } } | { Reimbursed: unknown } | { PendingReimbursement: unknown } };

/** Real ERC20 helper/minter/ledger evidence on the separate fresh IC runtime. */
export async function createIcWalletErc20Fixture(runtime: LocalNeutronRuntime) {
  if (!runtime.sessionPath.endsWith("evm-wallet-erc20-local.ndeploy.session.json")) throw new Error("ckUSDC qualification requires its separate isolated runtime");
  const base = await createIcWalletBridgeFixture(runtime);
  const chain = await createLocalEvmChain();
  const agent = await HttpAgent.create({ host: runtime.gatewayUrl, identity: localIdentityFromSeed(runtime.developerIdentitySeed), verifyQuerySignatures: false });
  await agent.fetchRootKey();
  const ledger = Actor.createActor<Ledger>(ledgerIdl, { agent, canisterId: ledgerId });
  const gasLedger = Actor.createActor<Ledger>(ledgerIdl, { agent, canisterId: base.ckethLedger });
  const minter = Actor.createActor<Minter>(erc20MinterIdl, { agent, canisterId: minterId });
  const statusMinter = Actor.createActor<{ retrieve_eth_status: ActorMethod<[bigint], Status> }>(minterIdl, { agent, canisterId: minterId });
  const info = await minter.get_minter_info();
  const minterAddress = getAddress(info.minter_address[0] ?? "");
  const helperAddress = getAddress(info.erc20_helper_contract_address[0] ?? "");
  if (!info.supported_ckerc20_tokens[0]?.some((token) => token.ledger_canister_id.toText() === ledgerId && getAddress(token.erc20_contract_address) === getAddress(tokenAddress) && token.ckerc20_token_symbol === "ckUSDC")) throw new Error("The actual minter does not support this ckUSDC ledger/token");
  const minting = await ledger.icrc1_minting_account();
  if (minting[0]?.owner.toText() !== minterId || minting[0]?.subaccount.length !== 0) throw new Error("ckUSDC ledger does not belong to the official minter");
  if (getAddress(helperAbi.decodeFunctionResult("getMinterAddress", await chain.rpc<string>("eth_call", [{ to: helperAddress, data: helperAbi.encodeFunctionData("getMinterAddress") }, "latest"]))[0]) !== minterAddress) throw new Error("ERC20 helper belongs to another minter");
  const tokenInterface = new Interface(tokenAbi);
  const tokenRead = async (name: "balanceOf" | "allowance", args: string[]): Promise<bigint> => BigInt(tokenInterface.decodeFunctionResult(name, await chain.rpc<string>("eth_call", [{ to: tokenAddress, data: tokenInterface.encodeFunctionData(name, args) }, "latest"]))[0]);
  async function events(): Promise<Event[]> {
    const output: Event[] = [];
    let start = 0n;
    do {
      const page = await minter.get_events({ start, length: 100n });
      output.push(...page.events.map((event, i) => ({ ...event, index: start + BigInt(i) })));
      start += BigInt(page.events.length);
      if (start >= page.total_event_count) return output;
      if (!page.events.length) throw new Error("Minter event pagination did not advance");
    } while (true);
  }
  async function mintTokenToEvm(address: string, amount: bigint): Promise<void> {
    if (amount <= 0n) throw new Error("Fixture funding amount must be positive");
    const provider = new JsonRpcProvider("http://127.0.0.1:8545", 1, { staticNetwork: true, cacheTimeout: -1 });
    try {
      const signer = await provider.getSigner(0);
      const token = new Contract(tokenAddress, tokenAbi, signer);
      if (getAddress(String(await token.getFunction("owner")())) !== await signer.getAddress()) throw new Error("Unexpected local token fixture owner");
      const before = await tokenRead("balanceOf", [address]);
      await (await token.getFunction("mint")(address, amount)).wait();
      if (await tokenRead("balanceOf", [address]) !== before + amount) throw new Error("Actual ERC20 fixture mint did not credit the requested amount");
    } finally { provider.destroy(); }
  }
  async function advanceUntilTokenMint(hash: string) {
    const wanted = checkedHash(hash);
    await chain.rpc("anvil_mine", ["0x80"]);
    const deadline = Date.now() + 300_000;
    do {
      const all = await events();
      for (const event of all) {
        const payload = event.payload[0];
        if (payload && "InvalidDeposit" in payload && checkedHash(payload.InvalidDeposit.event_source.transaction_hash) === wanted) throw new Error(`Official minter rejected the token deposit: ${payload.InvalidDeposit.reason}`);
        if (payload && "QuarantinedDeposit" in payload && checkedHash(payload.QuarantinedDeposit.event_source.transaction_hash) === wanted) throw new Error("Official minter quarantined this exact token deposit");
      }
      const acceptedEvent = all.find((event) => event.payload[0] && "AcceptedErc20Deposit" in event.payload[0] && checkedHash(event.payload[0].AcceptedErc20Deposit.transaction_hash) === wanted);
      const accepted = acceptedEvent?.payload[0];
      if (acceptedEvent && accepted && "AcceptedErc20Deposit" in accepted) {
        const deposit = accepted.AcceptedErc20Deposit;
        if (getAddress(deposit.erc20_contract_address) !== getAddress(tokenAddress)) throw new Error("Minter accepted the wrong ERC20 token");
        const mintedEvent = all.find((event) => event.payload[0] && "MintedCkErc20" in event.payload[0] && checkedHash(event.payload[0].MintedCkErc20.event_source.transaction_hash) === wanted && event.payload[0].MintedCkErc20.event_source.log_index === deposit.log_index);
        const minted = mintedEvent?.payload[0];
        if (mintedEvent && minted && "MintedCkErc20" in minted) {
          const mint = minted.MintedCkErc20;
          if (getAddress(mint.erc20_contract_address) !== getAddress(tokenAddress) || mint.ckerc20_token_symbol !== "ckUSDC") throw new Error("Mint event has the wrong asset mapping");
          const block = await exactBlock(ledger, mint.mint_block_index);
          const ledgerBlock = verifyMintBlock(block, deposit);
          const transaction = await chain.evidence(wanted);
          const raw = Transaction.from(transaction.raw);
          if (getAddress(transaction.from) !== getAddress(deposit.from_address) || getAddress(transaction.to) !== helperAddress || BigInt(transaction.valueWei) !== 0n || BigInt(transaction.blockNumber) !== deposit.block_number) throw new Error("ERC20 helper transaction differs from minter acceptance");
          const expectedData = helperAbi.encodeFunctionData("deposit", [tokenAddress, deposit.value, principalWord(deposit.principal)]);
          if (raw.data.toLowerCase() !== expectedData.toLowerCase()) throw new Error("Signed ERC20 deposit calldata does not match exact minter amount/recipient");
          const receipt = await chain.rpc<{ logs: { address: string; data: string; topics: string[]; logIndex: string }[] }>("eth_getTransactionReceipt", [wanted]);
          const log = receipt.logs.find((entry) => BigInt(entry.logIndex) === deposit.log_index && getAddress(entry.address) === helperAddress);
          const decoded = log && helperAbi.parseLog(log);
          if (!decoded || decoded.name !== "ReceivedErc20" || getAddress(decoded.args[0]) !== getAddress(tokenAddress) || getAddress(decoded.args[1]) !== getAddress(deposit.from_address) || BigInt(decoded.args[2]) !== deposit.value || decoded.args[3].toLowerCase() !== principalWord(deposit.principal).toLowerCase()) throw new Error("Exact helper ERC20 log differs from minter acceptance");
          return { accepted: { transactionHash: wanted, logIndex: String(deposit.log_index), blockNumber: String(deposit.block_number), fromAddress: getAddress(deposit.from_address), amount: String(deposit.value), recipient: deposit.principal.toText(), tokenAddress: getAddress(tokenAddress), eventIndex: String(acceptedEvent.index) }, minted: { transactionHash: wanted, logIndex: String(deposit.log_index), ledgerBlockIndex: String(mint.mint_block_index), eventIndex: String(mintedEvent.index) }, ledgerBlock, transaction };
        }
      }
      await delay(2_000);
    } while (Date.now() < deadline);
    throw new Error("Official ckUSDC mint did not appear within five minutes");
  }
  async function advanceUntilTokenWithdrawal(assetBurnIndex: string | bigint, gasBurnIndex: string | bigint, recipient: string) {
    const assetIndex = BigInt(assetBurnIndex), gasIndex = BigInt(gasBurnIndex), target = getAddress(recipient);
    const deadline = Date.now() + 720_000;
    let finalizedHash: string | null = null;
    do {
      const acceptedEvent = (await events()).find((event) => event.payload[0] && "AcceptedErc20WithdrawalRequest" in event.payload[0] && event.payload[0].AcceptedErc20WithdrawalRequest.ckerc20_ledger_id.toText() === ledgerId && event.payload[0].AcceptedErc20WithdrawalRequest.ckerc20_ledger_burn_index === assetIndex);
      const accepted = acceptedEvent?.payload[0];
      if (!accepted || !("AcceptedErc20WithdrawalRequest" in accepted)) { await delay(2_000); continue; }
      const withdrawal = accepted.AcceptedErc20WithdrawalRequest;
      if (withdrawal.cketh_ledger_burn_index !== gasIndex || getAddress(withdrawal.destination) !== target || getAddress(withdrawal.erc20_contract_address) !== getAddress(tokenAddress)) throw new Error("Accepted ERC20 withdrawal differs from the saved asset/gas burns or recipient");
      const assetBurn = verifyBurn(await exactBlock(ledger, assetIndex), withdrawal.withdrawal_amount, withdrawal.from, withdrawal.from_subaccount);
      const gasBurn = verifyBurn(await exactBlock(gasLedger, gasIndex), withdrawal.max_transaction_fee, withdrawal.from, withdrawal.from_subaccount);
      const status = await statusMinter.retrieve_eth_status(gasIndex);
      if ("TxSent" in status && status.TxSent.transaction_hash !== finalizedHash) {
        const receipt = await chain.rpc<{ blockNumber: string | null } | null>("eth_getTransactionReceipt", [status.TxSent.transaction_hash]);
        if (receipt?.blockNumber != null) { await chain.rpc("anvil_mine", ["0x80"]); finalizedHash = status.TxSent.transaction_hash; }
      }
      if ("TxFinalized" in status) {
        if (!("Success" in status.TxFinalized)) throw new Error("Official ERC20 withdrawal did not finalize successfully");
        const success = status.TxFinalized.Success;
        const transaction = await chain.evidence(success.transaction_hash);
        const raw = Transaction.from(transaction.raw);
        if (getAddress(transaction.from) !== minterAddress || getAddress(transaction.to) !== getAddress(tokenAddress) || BigInt(transaction.valueWei) !== 0n || raw.data.toLowerCase() !== tokenInterface.encodeFunctionData("transfer", [target, withdrawal.withdrawal_amount]).toLowerCase()) throw new Error("Finalized ERC20 payout differs from the accepted exact withdrawal");
        const receipt = await chain.rpc<{ logs: { address: string; data: string; topics: string[] }[] }>("eth_getTransactionReceipt", [transaction.hash]);
        const transfers = receipt.logs.filter((log) => getAddress(log.address) === getAddress(tokenAddress)).flatMap((log) => { try { const parsed = tokenInterface.parseLog(log); return parsed?.name === "Transfer" && getAddress(parsed.args[0]) === minterAddress && getAddress(parsed.args[1]) === target ? [BigInt(parsed.args[2])] : []; } catch { return []; } });
        if (transfers.reduce((sum, value) => sum + value, 0n) !== withdrawal.withdrawal_amount) throw new Error("Ethereum receipt has no exact ERC20 payout to the withdrawal recipient");
        const effectiveFee = BigInt(transaction.gasUsed) * BigInt(transaction.effectiveGasPriceWei);
        if (effectiveFee > withdrawal.max_transaction_fee || (success.effective_transaction_fee[0] !== undefined && success.effective_transaction_fee[0] !== effectiveFee)) throw new Error("ERC20 network fee exceeds or disagrees with its saved gas burn");
        return { assetBurn, gasBurn, accepted: { amount: String(withdrawal.withdrawal_amount), assetLedger: ledgerId, assetBurnIndex: String(assetIndex), gasBurnIndex: String(gasIndex), maxGasFeeWei: String(withdrawal.max_transaction_fee), recipient: target }, transaction, minterStatus: "TxFinalized.Success", recipientTokenBalance: String(await tokenRead("balanceOf", [target])), effectiveTransactionFeeWei: String(effectiveFee) };
      }
      await delay(2_000);
    } while (Date.now() < deadline);
    throw new Error("Official ckUSDC withdrawal did not finalize within twelve minutes");
  }
  return { ...base, token: { ledger: ledgerId, address: getAddress(tokenAddress), symbol: "ckUSDC", helperAddress }, tokenBalance: (owner: string | Principal) => ledger.icrc1_balance_of(account(owner)), tokenFee: () => ledger.icrc1_fee(), tokenAllowance: async (owner: string | Principal) => (await ledger.icrc2_allowance({ account: account(owner), spender: account(minterId) })).allowance, evmTokenBalance: (address: string) => tokenRead("balanceOf", [address]), helperAllowance: (address: string) => tokenRead("allowance", [address, helperAddress]), mintTokenToEvm, advanceUntilTokenMint, advanceUntilTokenWithdrawal, walletTransferForBurn: (index: string | bigint) => base.walletTransferForBurn(index, ledgerId) };
}
function account(owner: string | Principal): Account { return { owner: typeof owner === "string" ? Principal.fromText(owner) : owner, subaccount: [] }; }
function checkedHash(hash: string): string { if (!/^0x[0-9a-f]{64}$/iu.test(hash)) throw new Error("Invalid Ethereum hash"); return hash.toLowerCase(); }
function principalWord(principal: Principal): string { const bytes = new Uint8Array(32); bytes[0] = principal.toUint8Array().length; bytes.set(principal.toUint8Array(), 1); return `0x${Buffer.from(bytes).toString("hex")}`; }
async function exactBlock(ledger: Ledger, index: bigint): Promise<Block> { const blocks = (await ledger.icrc3_get_blocks([{ start: index, length: 1n }])).blocks; if (blocks.length !== 1 || blocks[0]!.id !== index) throw new Error("The real ledger did not return the exact minter block"); return blocks[0]!; }
function map(value: IcrcValue): Map<string, IcrcValue> { if (!("Map" in value)) throw new Error("Expected ICRC3 map"); return new Map(value.Map); }
function verifyBurn(block: Block, amount: bigint, owner: Principal, subaccount: Opt<Uint8Array>) {
  const tx = map(map(block.block).get("tx")!); const op = tx.get("op"), value = tx.get("amt"), from = tx.get("from");
  if (!op || !("Text" in op) || op.Text !== "burn" || !value || !("Nat" in value) || value.Nat !== amount || !from || !("Array" in from) || from.Array.length < 1 || from.Array.length > 2 || !("Blob" in from.Array[0]!) || Principal.fromUint8Array(from.Array[0].Blob).toText() !== owner.toText()) throw new Error("Ledger block is not the exact expected minter burn");
  const actual = from.Array[1]; if (actual && !("Blob" in actual)) throw new Error("Invalid burn subaccount");
  const normalized = (bytes?: Uint8Array) => !bytes || bytes.every((value) => value === 0) ? null : Buffer.from(bytes).toString("hex");
  if (normalized(actual?.Blob) !== normalized(subaccount[0])) throw new Error("Minter burn subaccount differs from the accepted withdrawal");
  return { index: String(block.id), kind: "burn", amount: String(amount), owner: owner.toText(), subaccount: normalized(subaccount[0]) };
}
const erc20MinterIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const source = IDL.Record({ transaction_hash: IDL.Text, log_index: IDL.Nat });
  const token = IDL.Record({ ckerc20_token_symbol: IDL.Text, erc20_contract_address: IDL.Text, ledger_canister_id: IDL.Principal });
  const payload = IDL.Variant({
    AcceptedErc20Deposit: IDL.Record({ transaction_hash: IDL.Text, log_index: IDL.Nat, block_number: IDL.Nat, from_address: IDL.Text, value: IDL.Nat, principal: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)), erc20_contract_address: IDL.Text }),
    MintedCkErc20: IDL.Record({ event_source: source, erc20_contract_address: IDL.Text, mint_block_index: IDL.Nat, ckerc20_token_symbol: IDL.Text }),
    AcceptedErc20WithdrawalRequest: IDL.Record({ max_transaction_fee: IDL.Nat, withdrawal_amount: IDL.Nat, erc20_contract_address: IDL.Text, destination: IDL.Text, cketh_ledger_burn_index: IDL.Nat, ckerc20_ledger_id: IDL.Principal, ckerc20_ledger_burn_index: IDL.Nat, from: IDL.Principal, from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) }),
    InvalidDeposit: IDL.Record({ event_source: source, reason: IDL.Text }), QuarantinedDeposit: IDL.Record({ event_source: source }),
  });
  return IDL.Service({ get_minter_info: IDL.Func([], [IDL.Record({ minter_address: IDL.Opt(IDL.Text), erc20_helper_contract_address: IDL.Opt(IDL.Text), supported_ckerc20_tokens: IDL.Opt(IDL.Vec(token)) })], ["query"]), get_events: IDL.Func([IDL.Record({ start: IDL.Nat64, length: IDL.Nat64 })], [IDL.Record({ events: IDL.Vec(IDL.Record({ timestamp: IDL.Nat64, payload: IDL.Opt(payload) })), total_event_count: IDL.Nat64 })], ["query"]) });
};
