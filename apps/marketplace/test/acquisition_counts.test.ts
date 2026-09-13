import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { CONTRACT, type WireApp, type WireChannelApp, type WireCandidate } from "../src/protocol.ts";

// Independently encode the prior public app record. New browser clients must
// still read an older protocol while the app and canister upgrades roll out.
const legacyApp = IDL.Record({
  appId: IDL.Text, publisher: IDL.Principal, title: IDL.Text, summary: IDL.Text,
  description: IDL.Text, priceUsdMicros: IDL.Nat, revision: IDL.Nat64,
  version: IDL.Opt(IDL.Nat), iconUrl: IDL.Opt(IDL.Text), screenshots: IDL.Vec(IDL.Text),
  iconArtifact: IDL.Opt(IDL.Nat64), screenshotArtifacts: IDL.Vec(IDL.Nat64),
  ratingCount: IDL.Nat, ratingTotal: IDL.Nat, owned: IDL.Bool, visible: IDL.Bool,
});
const legacyPage = IDL.Variant({
  ok: IDL.Record({ apps: IDL.Vec(legacyApp), nextCursor: IDL.Opt(IDL.Nat64) }),
  err: IDL.Record({ code: IDL.Text, message: IDL.Text }),
});
const listing: WireApp = {
  appId: "sample", publisher: Principal.anonymous(), publisherProfile: [], title: "Sample", summary: "",
  description: "", priceUsdMicros: 0n, revision: 1n, version: [100n], iconUrl: [],
  screenshots: [], iconArtifact: [], screenshotArtifacts: [], ratingCount: 0n,
  ratingTotal: 0n, owned: false, visible: true,
};

test("older protocol app responses leave lifetime counts unavailable, not zero", () => {
  const bytes = IDL.encode([legacyPage], [{ ok: { apps: [listing], nextCursor: [] } }]);
  const [decoded] = IDL.decode(CONTRACT.library_query!.returns, bytes) as unknown as [{ ok: { apps: WireApp[] } }];
  expect(decoded.ok.apps[0]!.acquisitionCounts).toEqual([]);
});

test("new lifetime counts preserve exact integers and older clients ignore the additive field", () => {
  const counts = { free: 9_007_199_254_740_993n, paid: 13n };
  const bytes = IDL.encode(CONTRACT.library_query!.returns, [{ ok: { apps: [{ ...listing, acquisitionCounts: [counts] }], nextCursor: [] } }]);
  const [current] = IDL.decode(CONTRACT.library_query!.returns, bytes) as unknown as [{ ok: { apps: WireApp[] } }];
  expect(current.ok.apps[0]!.acquisitionCounts).toEqual([counts]);
  const [prior] = IDL.decode([legacyPage], bytes) as unknown as [{ ok: { apps: WireApp[] } }];
  expect(prior.ok.apps[0]!.appId).toBe("sample");
  expect(prior.ok.apps[0]!.acquisitionCounts).toBeUndefined();
});

test("channel-aware app responses retain app-wide acquisition counts and ownership with both exact releases", () => {
  const counts = { free: 9_007_199_254_740_993n, paid: 13n };
  const stable: WireCandidate = { id: 9_007_199_254_740_994n, appId: listing.appId, version: 100n, publisher: listing.publisher, digest: new Uint8Array(32).fill(1), sourceDigest: [], state: { approved: null }, createdAtNs: 1n };
  const beta: WireCandidate = { ...stable, id: stable.id + 1n, version: 101n, digest: new Uint8Array(32).fill(2) };
  for (const selected of [stable, beta]) {
    const value: WireChannelApp = { app: { ...listing, version: [selected.version], acquisitionCounts: [counts], owned: true }, stableHead: { revision: 3n, candidate: [stable], releaseNotes: "Stable" }, betaHead: { revision: 4n, candidate: [beta], releaseNotes: "Beta" }, selected: [selected], selectedChannel: [selected === stable ? { stable: null } : { beta: null }] };
    const bytes = IDL.encode(CONTRACT.library_query_v2!.returns, [{ ok: { apps: [value], nextCursor: [9_007_199_254_740_993n] } }]);
    const [decoded] = IDL.decode(CONTRACT.library_query_v2!.returns, bytes) as unknown as [{ ok: { apps: WireChannelApp[]; nextCursor: bigint[] } }];
    expect(decoded.ok.apps[0]!.app.acquisitionCounts).toEqual([counts]);
    expect(decoded.ok.apps[0]!.app.owned).toBe(true);
    expect(decoded.ok.apps[0]!.selected[0]!.id).toBe(selected.id);
    expect(decoded.ok.apps[0]!.stableHead.candidate[0]!.digest).toEqual(stable.digest);
    expect(decoded.ok.apps[0]!.betaHead.candidate[0]!.digest).toEqual(beta.digest);
    expect(decoded.ok.nextCursor).toEqual([9_007_199_254_740_993n]);
  }
});
