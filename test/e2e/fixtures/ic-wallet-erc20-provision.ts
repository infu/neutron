import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { Contract, ContractFactory, JsonRpcProvider, getAddress } from "ethers";
import {
  createLocalFixtureClient, encodeLocalIndexInitArgs, encodeLocalLedgerInitArgs, LOCAL_LEDGER_FIXTURES,
  ensureLocalPocketIcFixtures, fundLocalPocketIcFixtures, localFixtureMinterIdentity,
  type EnsureLocalFixturesOptions, type FundLocalFixturesOptions, type LocalFixtureClient,
} from "../../../packages/neutron-provision/src/local_fixtures.ts";
import {
  CKETH_MINTER_CANISTER_ID, createLocalNativeFixtureClient, resolveNativeChainArtifacts,
} from "../../../packages/neutron-provision/src/local_chain_fixtures.ts";
import { createLocalEvmChain } from "./evm-wallet-chain.ts";
import { prepareErc20ContractArtifacts } from "./ic-wallet-erc20-contracts.ts";

// These hooks are passed only to a new, isolated full PocketIC instance. They
// never reinstall a ledger or alter a retained runtime's minting account.
export const ERC20_PROTOCOL_TOKENS = [
  { key: "ckusdc", ledger: "xevnm-gaaaa-aaaar-qafnq-cai", symbol: "ckUSDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { key: "ckusdt", ledger: "cngnf-vqaaa-aaaar-qag4q-cai", symbol: "ckUSDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
] as const;
const isProtocolToken = (key: string) => ERC20_PROTOCOL_TOKENS.some((token) => token.key === key);

/** Install the standard released ledgers with the real minter from first init. */
export async function ensureErc20PocketIcFixtures(options: EnsureLocalFixturesOptions): Promise<Record<string, string>> {
  if (options.profile !== "full_protocol_fixtures") throw new Error("The ERC20 protocol fixture requires an isolated full instance");
  return ensureLocalPocketIcFixtures(options, { createClient: async (connection) => {
    const ordinary = await createLocalFixtureClient(connection);
    const native = await createLocalNativeFixtureClient(connection);
    return {
      verifyInternetIdentity: (id) => ordinary.verifyInternetIdentity(id),
      verifyLedgerPair: (fixture) => isProtocolToken(fixture.key)
        ? native.verifyLedgerPair({ fixture: { ...fixture, key: "cketh" }, expectedMinter: CKETH_MINTER_CANISTER_ID })
        : ordinary.verifyLedgerPair(fixture),
      fundLedger: (fixture, owner, amount) => {
        if (isProtocolToken(fixture.key)) throw new Error("A minter-backed ERC20 ledger must be funded by an actual Ethereum deposit");
        return ordinary.fundLedger(fixture, owner, amount);
      },
      async ensureManagedLedgerPair(fixture, artifacts) {
        if (!isProtocolToken(fixture.key)) return ordinary.ensureManagedLedgerPair(fixture, artifacts);
        await native.ensureCanister(fixture.canisterId);
        await native.ensureCanister(fixture.indexCanisterId);
        await native.ensureInstalled({ label: `${fixture.symbol} official minter-backed ledger`, canisterId: fixture.canisterId, artifact: artifacts.ledger, arg: encodeLocalLedgerInitArgs(fixture, Principal.fromText(CKETH_MINTER_CANISTER_ID)) });
        await native.ensureInstalled({ label: `${fixture.symbol} index`, canisterId: fixture.indexCanisterId, artifact: artifacts.index, arg: encodeLocalIndexInitArgs(fixture.canisterId) });
        await native.verifyLedgerPair({ fixture: { ...fixture, key: "cketh" }, expectedMinter: CKETH_MINTER_CANISTER_ID });
      },
    } satisfies LocalFixtureClient;
  } });
}

/** Keep normal fixture funding, explicitly leave ckERC20 funding to its helper. */
export async function fundErc20PocketIcFixtures(options: FundLocalFixturesOptions): Promise<Record<string, bigint>> {
  return fundLocalPocketIcFixtures(options, { createClient: async (connection) => {
    const ordinary = await createLocalFixtureClient(connection);
    const agent = await HttpAgent.create({ host: connection.gatewayUrl, identity: connection.identity, verifyQuerySignatures: false });
    if (Buffer.from(await agent.fetchRootKey()).toString("base64") !== connection.expectedRootKeyBase64) throw new Error("ERC20 funding root key mismatch");
    return {
      verifyInternetIdentity: (id) => ordinary.verifyInternetIdentity(id),
      verifyLedgerPair: (fixture) => ordinary.verifyLedgerPair(fixture),
      ensureManagedLedgerPair: (fixture, artifacts) => ordinary.ensureManagedLedgerPair(fixture, artifacts),
      async fundLedger(fixture, owner, amount) {
        if (!isProtocolToken(fixture.key)) return ordinary.fundLedger(fixture, owner, amount);
        const ledger = Actor.createActor<{ icrc1_balance_of: ActorMethod<[{ owner: Principal; subaccount: [] }], bigint> }>(({ IDL }) => IDL.Service({ icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ["query"]) }), { agent, canisterId: fixture.canisterId });
        options.logger?.log(`Leaving ${fixture.symbol} funding to the real ERC20 helper/minter flow`);
        return ledger.icrc1_balance_of({ owner, subaccount: [] });
      },
    };
  } });
}

type SupportedToken = { ckerc20_token_symbol: string; erc20_contract_address: string; ledger_canister_id: Principal };
type MinterInfo = { minter_address: [] | [string]; erc20_helper_contract_address: [] | [string]; supported_ckerc20_tokens: [] | [SupportedToken[]] };
type Minter = {
  get_minter_info: ActorMethod<[], MinterInfo>;
  add_ckerc20_token: ActorMethod<[{ chain_id: bigint; address: string; ckerc20_token_symbol: string; ckerc20_ledger_id: Principal }], undefined>;
};

/** Run only in the fixture owner's reserved Ethereum financial window. */
export async function configureFreshErc20Protocol(options: {
  gatewayUrl: string; expectedRootKeyBase64: string; cacheDirectory: string;
}): Promise<{ minterAddress: string; helperAddress: string; tokens: typeof ERC20_PROTOCOL_TOKENS; helperSourceSha256: string }> {
  const chain = await createLocalEvmChain();
  const node = await chain.rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  if (node.forkConfig?.forkUrl != null || node.forkConfig?.forkBlockNumber != null) throw new Error("ERC20 fixture must use unforked local Anvil");
  const identity = localFixtureMinterIdentity();
  const connection = { ...options, identity };
  const native = await createLocalNativeFixtureClient(connection);
  for (const token of ERC20_PROTOCOL_TOKENS) {
    const fixture = LOCAL_LEDGER_FIXTURES.find((entry) => entry.key === token.key)!;
    await native.verifyLedgerPair({ fixture: { ...fixture, key: "cketh" }, expectedMinter: CKETH_MINTER_CANISTER_ID });
  }
  const agent = await HttpAgent.create({ host: options.gatewayUrl, identity, verifyQuerySignatures: false });
  if (Buffer.from(await agent.fetchRootKey()).toString("base64") !== options.expectedRootKeyBase64) throw new Error("ERC20 protocol root key mismatch");
  const minter = Actor.createActor<Minter>(minterIdl, { agent, canisterId: CKETH_MINTER_CANISTER_ID });
  const info = await minter.get_minter_info();
  const minterAddress = getAddress(info.minter_address[0] ?? "");
  const contracts = await prepareErc20ContractArtifacts();
  const provider = new JsonRpcProvider("http://127.0.0.1:8545", 1, { staticNetwork: true, cacheTimeout: -1 });
  try {
    const signer = await provider.getSigner(0);
    const owner = await signer.getAddress();
    for (const token of ERC20_PROTOCOL_TOKENS) {
      const code = await chain.rpc<string>("eth_getCode", [token.address, "latest"]);
      if (code !== "0x" && code.toLowerCase() !== contracts.token.runtimeBytecode.toLowerCase()) throw new Error(`Existing code at ${token.address} is not this local token fixture; it will not be overwritten`);
      if (code === "0x") await chain.rpc("anvil_setCode", [token.address, contracts.token.runtimeBytecode]);
      const contract = new Contract(token.address, contracts.token.abi, signer);
      const currentOwner = String(await contract.getFunction("owner")());
      if (currentOwner === `0x${"0".repeat(40)}`) await (await contract.getFunction("init")(owner)).wait();
      else if (getAddress(currentOwner) !== owner) throw new Error("Existing ERC20 fixture has a different owner");
    }
    let helperAddress = info.erc20_helper_contract_address[0];
    if (!helperAddress) {
      const helper = await new ContractFactory(contracts.helper.abi, contracts.helper.bytecode, signer).deploy(minterAddress);
      await helper.waitForDeployment();
      helperAddress = await helper.getAddress();
      const deployment = await helper.deploymentTransaction()?.wait();
      if (!deployment || deployment.status !== 1) throw new Error("ERC20 helper deployment receipt is unavailable");
      const artifacts = await resolveNativeChainArtifacts({ cacheDirectory: options.cacheDirectory });
      // A fresh IC instance shares Anvil's history: synchronize only this new
      // minter's initial nonce before its first ERC20 withdrawal. Never reset
      // an existing configured protocol's nonce on subsequent invocations.
      const nonce = BigInt(await chain.rpc<string>("eth_getTransactionCount", [minterAddress, "pending"]));
      // This helper cannot have emitted any deposit before its deployment.
      // Preserve all its history without scanning the retained chain's earlier
      // unrelated blocks when configuring this fresh minter instance.
      const lastScraped = BigInt(deployment.blockNumber) - 1n;
      await native.installWasm({ canisterId: CKETH_MINTER_CANISTER_ID, artifact: artifacts.ckethMinter, arg: minterUpgrade(helperAddress, identity.getPrincipal(), nonce, lastScraped), mode: "upgrade" });
    }
    const helper = new Contract(helperAddress, contracts.helper.abi, provider);
    if (getAddress(String(await helper.getFunction("getMinterAddress")())) !== minterAddress) throw new Error("ERC20 helper minter identity mismatch");
    let supported = (await minter.get_minter_info()).supported_ckerc20_tokens[0] ?? [];
    for (const token of ERC20_PROTOCOL_TOKENS) {
      const existing = supported.find((entry) => entry.ledger_canister_id.toText() === token.ledger);
      if (existing) {
        if (getAddress(existing.erc20_contract_address) !== getAddress(token.address) || existing.ckerc20_token_symbol !== token.symbol) throw new Error("Minter has a different existing ERC20 mapping");
      } else await minter.add_ckerc20_token({ chain_id: 1n, address: token.address, ckerc20_token_symbol: token.symbol, ckerc20_ledger_id: Principal.fromText(token.ledger) });
    }
    supported = (await minter.get_minter_info()).supported_ckerc20_tokens[0] ?? [];
    for (const token of ERC20_PROTOCOL_TOKENS) if (!supported.some((entry) => entry.ledger_canister_id.toText() === token.ledger && getAddress(entry.erc20_contract_address) === getAddress(token.address))) throw new Error("Official minter did not retain the ERC20 mapping");
    return { minterAddress, helperAddress: getAddress(helperAddress), tokens: ERC20_PROTOCOL_TOKENS, helperSourceSha256: contracts.helper.sourceSha256 };
  } finally { provider.destroy(); }
}

function minterUpgrade(helper: string, orchestrator: Principal, nonce: bigint, lastScraped: bigint): Uint8Array {
  const optText = IDL.Opt(IDL.Text), optNat = IDL.Opt(IDL.Nat);
  const upgrade = IDL.Record({ deposit_with_subaccount_helper_contract_address: optText, next_transaction_nonce: optNat, evm_rpc_id: IDL.Opt(IDL.Principal), ledger_suite_orchestrator_id: IDL.Opt(IDL.Principal), erc20_helper_contract_address: optText, last_erc20_scraped_block_number: optNat, ethereum_contract_address: optText, minimum_withdrawal_amount: optNat, last_deposit_with_subaccount_scraped_block_number: optNat, ethereum_block_height: IDL.Opt(IDL.Variant({ Safe: IDL.Null, Finalized: IDL.Null, Latest: IDL.Null })) });
  return new Uint8Array(IDL.encode([IDL.Variant({ UpgradeArg: upgrade })], [{ UpgradeArg: {
    deposit_with_subaccount_helper_contract_address: [], next_transaction_nonce: [nonce], evm_rpc_id: [], ledger_suite_orchestrator_id: [orchestrator], erc20_helper_contract_address: [helper], last_erc20_scraped_block_number: [lastScraped], ethereum_contract_address: [], minimum_withdrawal_amount: [], last_deposit_with_subaccount_scraped_block_number: [], ethereum_block_height: [],
  } }]));
}
function minterIdl(): IDL.ServiceClass {
  const token = IDL.Record({ ckerc20_token_symbol: IDL.Text, erc20_contract_address: IDL.Text, ledger_canister_id: IDL.Principal });
  return IDL.Service({
    get_minter_info: IDL.Func([], [IDL.Record({ minter_address: IDL.Opt(IDL.Text), erc20_helper_contract_address: IDL.Opt(IDL.Text), supported_ckerc20_tokens: IDL.Opt(IDL.Vec(token)) })], ["query"]),
    add_ckerc20_token: IDL.Func([IDL.Record({ chain_id: IDL.Nat, address: IDL.Text, ckerc20_token_symbol: IDL.Text, ckerc20_ledger_id: IDL.Principal })], [], []),
  });
}
