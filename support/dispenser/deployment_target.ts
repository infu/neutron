import {
  Actor,
  type ActorMethod,
  type HttpAgent,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";

export const PRODUCTION_DISPENSER_TARGET_SUBNET =
  "re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae";

type DispenserTargetActor = {
  dispenser_target_subnet: ActorMethod<[], Principal>;
};

const dispenserTargetIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    dispenser_target_subnet: IDL.Func([], [IDL.Principal], ["query"]),
  });

export function encodeDispenserInstallArgs(
  targetSubnet: string,
): Uint8Array {
  return new Uint8Array(
    IDL.encode([IDL.Principal], [targetSubnetPrincipal(targetSubnet)]),
  );
}

export function dispenserInstallArgsText(targetSubnet: string): string {
  return `(principal "${targetSubnetPrincipal(targetSubnet).toText()}")`;
}

export async function assertDispenserTargetSubnet(input: {
  agent: HttpAgent;
  canisterId: string;
  expectedTargetSubnet: string;
}): Promise<string> {
  const canister = canonicalNonSystemPrincipal(
    input.canisterId,
    "Dispenser canister",
  );
  const expected = targetSubnetPrincipal(input.expectedTargetSubnet).toText();
  const actor = Actor.createActor<DispenserTargetActor>(
    dispenserTargetIdl,
    {
      agent: input.agent,
      canisterId: canister,
    },
  );
  const observed = (
    await actor.dispenser_target_subnet()
  ).toText();
  if (observed !== expected) {
    throw new Error(
      `Dispenser target subnet is ${observed}, expected ${expected}`,
    );
  }
  return observed;
}

function targetSubnetPrincipal(value: string): Principal {
  return canonicalNonSystemPrincipal(value, "Dispenser target subnet");
}

function canonicalNonSystemPrincipal(
  value: string,
  label: string,
): Principal {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (cause) {
    throw new Error(`${label} must be a principal`, { cause });
  }
  const canonical = principal.toText();
  if (
    canonical !== value ||
    principal.isAnonymous() ||
    canonical === Principal.managementCanister().toText()
  ) {
    throw new Error(
      `${label} must be a canonical non-system principal`,
    );
  }
  return principal;
}
