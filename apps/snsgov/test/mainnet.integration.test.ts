/**
 * Live mainnet integration test.
 *
 * Opt-in: set SNSGOV_MAINNET=1. It is excluded from the default suite because
 * it needs network access and asserts against live governance state, but it is
 * the only test that proves the whole read path actually works.
 *
 *   SNSGOV_MAINNET=1 bun test test/mainnet.integration.test.ts
 */
import { describe, expect, test } from "bun:test";
import { findSns, listDeployedSnses, probeAll } from "../src/data/discovery";
import {
  getProposal,
  listNervousSystemFunctions,
  listNeurons,
  listProposals,
  maxVotingPeriodExtensionSeconds,
  readMetadata,
  readMode,
  readParameters,
  uncategorizedFunctions,
} from "../src/data/governance";
import { readTokenInfo, readTreasuries } from "../src/data/ledger";
import { formatDuration, formatPercent, formatRewardRate, formatTokenAmount } from "../src/data/format";

const ENABLED = process.env.SNSGOV_MAINNET === "1";
const options = { host: "https://icp-api.io" };
const NEUTRINITE_ROOT = "extk7-gaaaa-aaaaq-aacda-cai";

describe.if(ENABLED)("mainnet read path", () => {
  test("SNS-W lists every deployed SNS in one query", async () => {
    const all = await listDeployedSnses(options);
    expect(all.length).toBeGreaterThanOrEqual(50);
    expect(all.every((entry) => entry.root && entry.governance && entry.ledger)).toBe(true);
  }, 60_000);

  test("liveness is per-canister and most SNSes are dead-free", async () => {
    const all = await listDeployedSnses(options);
    const liveness = await probeAll(all, { ...options, concurrency: 8 });
    const governanceLive = [...liveness.values()].filter((entry) => entry.governance).length;
    // 38 of 54 at time of writing. Assert the shape, not the exact count.
    expect(governanceLive).toBeGreaterThan(20);
    expect(governanceLive).toBeLessThan(all.length);
    // Some SNSes have a dead governance canister but a live ledger.
    expect([...liveness.values()].some((entry) => !entry.governance && entry.ledger)).toBe(true);
  }, 180_000);

  test("the Neutrinite dashboard block reproduces exactly", async () => {
    const sns = await findSns(NEUTRINITE_ROOT, options);
    const [meta, mode, params, token, treasury] = await Promise.all([
      readMetadata(sns.governance, options),
      readMode(sns.governance, options),
      readParameters(sns.governance, options),
      readTokenInfo(sns.ledger, options),
      readTreasuries(
        { governanceCanisterId: sns.governance, ledgerCanisterId: sns.ledger },
        options,
      ),
    ]);
    const decimals = token.decimals;

    expect(token.name).toBe("Neutrinite");
    expect(token.symbol).toBe("NTN");
    expect(decimals).toBe(8);
    expect(formatTokenAmount(token.fee, decimals, { group: false })).toBe("0.0001");
    expect(formatDuration(params.initialVotingPeriodSeconds!)).toBe("4 days");
    // The dashboard shows TWICE the raw wait-for-quiet parameter.
    expect(formatDuration(maxVotingPeriodExtensionSeconds(params)!)).toBe("2 days");
    expect(formatTokenAmount(params.rejectCostE8s!, decimals, { group: false })).toBe("5");
    expect(formatTokenAmount(params.neuronMinimumStakeE8s!, decimals, { group: false })).toBe("0.1");
    expect(formatDuration(params.neuronMinimumDissolveDelayToVoteSeconds!)).toBe("30 days");
    expect(formatDuration(params.maxDissolveDelaySeconds!)).toBe("182 days");
    expect(formatPercent(params.maxDissolveDelayBonusPercentage!)).toBe("0%");
    expect(formatDuration(params.maxNeuronAgeForAgeBonusSeconds!)).toBe("1 year");
    expect(formatPercent(params.maxAgeBonusPercentage!)).toBe("25%");
    expect(formatRewardRate(params.rewards ?? {})).toBe("2% to 2% over 12 years");
    expect(params.maxNumberOfPrincipalsPerNeuron).toBe(5n);
    expect(meta.name).toBe("Neutrinite");
    expect(mode).toBe(1);
    expect(treasury.icpE8s).toBeGreaterThan(0n);
    expect(treasury.tokenE8s).toBeGreaterThan(0n);
  }, 120_000);

  test("ballots come from get_proposal, not list_proposals", async () => {
    const sns = await findSns(NEUTRINITE_ROOT, options);
    const page = await listProposals(sns.governance, { limit: 3 }, options);
    expect(page.proposals.length).toBe(3);

    const first = page.proposals[0]!;
    const detail = await getProposal(sns.governance, first.id, options);
    // list_proposals scopes ballots to the caller; anonymously that is none.
    // get_proposal returns the complete map.
    expect(detail?.ballots.length ?? 0).toBeGreaterThan(100);
  }, 120_000);

  test("of_principal matches any permission holder, and truncation is reported", async () => {
    const sns = await findSns(NEUTRINITE_ROOT, options);
    const { neurons, truncated } = await listNeurons(sns.governance, { limit: 100 }, options);
    expect(neurons.length).toBeGreaterThan(0);
    expect(truncated).toBe(false); // unfiltered form reports no truncation

    // A real production hotkey holds exactly [SubmitProposal, Vote].
    const hotkeyed = neurons.find((neuron) =>
      neuron.permissions.some(
        (entry) => entry.permissions.length === 2 && entry.permissions.includes(3) && entry.permissions.includes(4),
      ),
    );
    if (hotkeyed) {
      const holder = hotkeyed.permissions.find((entry) => entry.permissions.length === 2)!;
      const found = await listNeurons(
        sns.governance,
        { ofPrincipal: holder.principal!, limit: 100 },
        options,
      );
      expect(found.neurons.some((neuron) => neuron.id === hotkeyed.id)).toBe(true);
    }
  }, 120_000);

  test("uncategorized custom functions are detected", async () => {
    const sns = await findSns(NEUTRINITE_ROOT, options);
    const functions = await listNervousSystemFunctions(sns.governance, options);
    expect(functions.length).toBeGreaterThan(20);
    const generic = functions.filter((fn) => fn.kind === "generic");
    expect(generic.length).toBeGreaterThan(0);
    // Neutrinite has 10 untopicked custom functions that cannot be proposed.
    expect(uncategorizedFunctions(functions).length).toBeGreaterThan(0);
    // Generic functions carry a target we can introspect.
    expect(generic.some((fn) => fn.targetCanisterId && fn.targetMethodName)).toBe(true);
  }, 120_000);
});

describe.if(ENABLED)("custom proposal pipeline", () => {
  test("a real custom proposal payload builds and passes its DAO validator", async () => {
    const { discoverInterface, methodArgumentType, encodePayload, validatePayload, isIcrcAccountType, parseAccountInput } =
      await import("../src/data/custom_proposal");
    const { listNervousSystemFunctions } = await import("../src/data/governance");

    const sns = await findSns(NEUTRINITE_ROOT, options);
    const functions = await listNervousSystemFunctions(sns.governance, options);
    // #5000 "Transfer SNS Treasury ckBTC" targets icrc1_transfer, so it is the
    // ICRC-account case in production form.
    const fn = functions.find((candidate) => candidate.id === 5000n);
    expect(fn?.targetMethodName).toBe("icrc1_transfer");
    expect(fn?.topic).toBeDefined();

    const did = await discoverInterface(fn!.targetCanisterId!, options);
    expect(did).not.toBeNull();

    const argType = await methodArgumentType(did!, fn!.targetMethodName!);
    expect(argType).not.toBeNull();

    // Accounts are detected structurally, not by the field's name in its parent.
    const fields = (argType as unknown as { _fields: [string, unknown][] })._fields;
    const accountFields = fields.filter(([, type]) => isIcrcAccountType(type as never));
    expect(accountFields.length).toBeGreaterThan(0);

    const payload = encodePayload(argType!, {
      to: parseAccountInput("eqsml-lyaaa-aaaaq-aacdq-cai"),
      amount: 100_000n,
      fee: [],
      memo: [],
      from_subaccount: [],
      created_at_time: [],
    });
    expect(payload.length).toBeGreaterThan(50);

    const validation = await validatePayload(
      {
        validatorCanisterId: fn!.validatorCanisterId!,
        validatorMethodName: fn!.validatorMethodName!,
        payload,
      },
      options,
    );
    expect(validation.ok).toBe(true);
    // The validator's own rendering is what voters see for the payload.
    expect(validation.rendering).toContain("100_000");
  }, 120_000);

  test("an untopicked custom function is refused before any encoding", async () => {
    const { buildAndValidate } = await import("../src/data/custom_proposal");
    const { listNervousSystemFunctions, uncategorizedFunctions } = await import(
      "../src/data/governance"
    );
    const sns = await findSns(NEUTRINITE_ROOT, options);
    const blocked = uncategorizedFunctions(await listNervousSystemFunctions(sns.governance, options));
    expect(blocked.length).toBeGreaterThan(0);

    const fn = blocked[0]!;
    await expect(
      buildAndValidate(
        {
          functionId: fn.id,
          targetCanisterId: fn.targetCanisterId ?? "aaaaa-aa",
          targetMethodName: fn.targetMethodName ?? "noop",
        },
        {},
        options,
      ),
    ).rejects.toThrow(/no topic assigned/i);
  }, 120_000);
});
