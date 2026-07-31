declare module "icblast" {
  import type { Identity } from "@dfinity/agent";
  import type { Principal } from "@dfinity/principal";

  export const InternetIdentity: {
    create(options?: Record<string, unknown>): Promise<typeof InternetIdentity>;
    getIdentity(): Identity;
    getPrincipal(): Principal;
    isAuthenticated(): Promise<boolean>;
    login(options?: Record<string, unknown>): Promise<void>;
    logout(options?: Record<string, unknown>): Promise<void>;
  };

  export function explainMethodSchema(
    source: unknown,
    method: string
  ): unknown;
  export function toState(value: unknown): unknown;
  export function validateMethodInput(
    source: unknown,
    method: string,
    args: unknown[]
  ): { ok: boolean; errors?: unknown[] };
}
