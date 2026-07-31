export type ActivationResult =
  | { ready: null }
  | { authorized: null }
  | { already_authorized: null }
  | { already_set: null }
  | { already_activated: null }
  | { invalid: null };

export type ActivationActor = {
  kernel_activation(
    request: { use: Uint8Array },
  ): Promise<ActivationResult>;
  kernel_check_authorized(request: null): Promise<boolean>;
};

export type ActivationAttempt =
  | { authorized: true }
  | { authorized: false; message: string };

/**
 * Submit the bearer once. If the update response is lost, authorization is
 * queried instead of replaying a token whose first use may have committed.
 */
export async function redeemActivation(
  actor: ActivationActor,
  token: Uint8Array,
): Promise<ActivationAttempt> {
  let result: ActivationResult;
  try {
    result = await actor.kernel_activation({ use: token });
  } catch {
    try {
      if (await actor.kernel_check_authorized(null)) {
        return { authorized: true };
      }
    } catch {
      // The original update and confirmation are both ambiguous.
    }
    return {
      authorized: false,
      message:
        "Neutron could not confirm the one-time activation. Reload to check authorization; the code will not be submitted twice.",
    };
  }

  if ("authorized" in result || "already_authorized" in result) {
    return { authorized: true };
  }
  if ("already_activated" in result) {
    return {
      authorized: false,
      message:
        "This Neutron activation code was already used. Sign in with the identity that activated it.",
    };
  }
  return {
    authorized: false,
    message:
      "The Neutron activation code is invalid or belongs to another canister. Return to the original activation link and try again.",
  };
}
