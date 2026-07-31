export const LOCAL_ENVIRONMENTS = [
  "minimal",
  "full_protocol_fixtures",
] as const;

export type LocalEnvironment = (typeof LOCAL_ENVIRONMENTS)[number];

export function parseLocalEnvironment(
  value: unknown,
  label = "local environment",
): LocalEnvironment {
  if (
    value !== LOCAL_ENVIRONMENTS[0] &&
    value !== LOCAL_ENVIRONMENTS[1]
  ) {
    throw new Error(
      `${label} must be ${LOCAL_ENVIRONMENTS.join(" or ")}`,
    );
  }
  return value;
}

export function usesFullProtocolFixtures(
  environment: LocalEnvironment,
): boolean {
  return environment === "full_protocol_fixtures";
}
