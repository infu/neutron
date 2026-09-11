import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { CONTRACT, type WireApp } from "../src/protocol.ts";

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
  const [decoded] = IDL.decode(CONTRACT.library_query!.returns, bytes) as [{ ok: { apps: WireApp[] } }];
  expect(decoded.ok.apps[0]!.acquisitionCounts).toEqual([]);
});

test("new lifetime counts preserve exact integers and older clients ignore the additive field", () => {
  const counts = { free: 9_007_199_254_740_993n, paid: 13n };
  const bytes = IDL.encode(CONTRACT.library_query!.returns, [{ ok: { apps: [{ ...listing, acquisitionCounts: [counts] }], nextCursor: [] } }]);
  const [current] = IDL.decode(CONTRACT.library_query!.returns, bytes) as [{ ok: { apps: WireApp[] } }];
  expect(current.ok.apps[0]!.acquisitionCounts).toEqual([counts]);
  const [prior] = IDL.decode([legacyPage], bytes) as [{ ok: { apps: WireApp[] } }];
  expect(prior.ok.apps[0]!.appId).toBe("sample");
  expect(prior.ok.apps[0]!.acquisitionCounts).toBeUndefined();
});
