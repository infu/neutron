// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";
import { Candidate, result } from "./operator-wire.ts";

// A projection of app_detail: ratings and acquisition counters are unrelated to
// a publisher's media edit and may change concurrently without invalidating it.
export const MediaApp = IDL.Record({
  appId: IDL.Text, publisher: IDL.Principal, title: IDL.Text,
  summary: IDL.Text, description: IDL.Text, priceUsdMicros: IDL.Nat,
  revision: IDL.Nat64, version: IDL.Opt(IDL.Nat), visible: IDL.Bool,
  iconUrl: IDL.Opt(IDL.Text), iconArtifact: IDL.Opt(IDL.Nat64),
  screenshots: IDL.Vec(IDL.Text), screenshotArtifacts: IDL.Vec(IDL.Nat64),
});
export const MediaDetail = IDL.Record({ app: MediaApp, candidate: IDL.Opt(Candidate) });
export const MediaDetailReply = result(MediaDetail);
export type MediaAppValue = {
  appId: string; publisher: Principal; title: string; summary: string;
  description: string; priceUsdMicros: bigint; revision: bigint;
  version: [] | [bigint]; visible: boolean; iconUrl: [] | [string];
  iconArtifact: [] | [bigint]; screenshots: string[]; screenshotArtifacts: bigint[];
};
export type MediaDetailValue = { app: MediaAppValue; candidate: [] | [Record<string, unknown>] };
