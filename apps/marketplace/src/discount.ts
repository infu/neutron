import type { Principal } from "@dfinity/principal";
import type { DiscountPreference } from "./view-types.ts";

export type ReferralQuote = { code: string; affiliate: Principal; discountBps: bigint; termsVersion: bigint };
type Access = {
  owner: string;
  read(): Promise<string | null>;
  save(code: string | null): Promise<string | null>;
  validate(code: string): Promise<ReferralQuote>;
  checkCurrent(): void;
};
const inactive = (code: string | null, error: string | null = null): DiscountPreference => ({ code, active: false, discountBps: 0, affiliate: null, error });
export const normalizeDiscountCode = (code: string): string => code.trim().toUpperCase();
/** Omission means preserve an existing purchase's terms, never substitute today's preference. */
export const matchesSavedDiscount = (saved: string, requested: string | undefined): boolean => requested === undefined || normalizeDiscountCode(saved) === normalizeDiscountCode(requested);

/** Cache only durable local state. Eligibility/terms are rechecked by direct query
 * on each refresh or new defaulted checkout; failed validation never clears it. */
export function createDiscountPreferences() {
  let stored: Promise<string | null> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let revision = 0;
  let flight: { revision: number; promise: Promise<DiscountPreference> } | null = null;
  function read(access: Access): Promise<string | null> {
    if (!stored) {
      const pending = access.read().catch(error => { if (stored === pending) stored = null; throw error; });
      stored = pending;
    }
    return stored;
  }
  async function validate(access: Access, code: string): Promise<DiscountPreference> {
    const result = await access.validate(code);
    access.checkCurrent();
    const affiliate = result.affiliate.toText();
    if (!result.code || normalizeDiscountCode(result.code) !== result.code || normalizeDiscountCode(code) !== result.code || result.discountBps < 0n || result.discountBps > 10000n || result.termsVersion < 0n) throw new Error("The marketplace returned invalid discount terms.");
    if (affiliate === access.owner) throw new Error("You cannot use your own affiliate code.");
    return { code: result.code, active: true, discountBps: Number(result.discountBps), affiliate, error: null };
  }
  async function discount(access: Access): Promise<DiscountPreference> {
    await writes.catch(() => undefined);
    access.checkCurrent();
    const current = revision;
    if (!flight || flight.revision !== current) {
      const promise = (async () => {
        const code = await read(access);
        access.checkCurrent();
        let result = inactive(code);
        if (code) try { result = await validate(access, code); }
        catch (error) { access.checkCurrent(); result = inactive(code, error instanceof Error ? error.message : String(error)); }
        return current === revision ? result : discount(access);
      })().finally(() => { if (flight?.promise === promise) flight = null; });
      flight = { revision: current, promise };
    }
    return flight.promise;
  }
  async function set(access: Access, input: string): Promise<DiscountPreference> {
    const requested = normalizeDiscountCode(input);
    const task = writes.catch(() => undefined).then(async () => {
      access.checkCurrent();
      const next = requested ? await validate(access, requested) : inactive(null);
      access.checkCurrent();
      // A lost save reply may still have committed. Discard local cache before
      // dispatch so the next refresh reads the durable preference, not old terms.
      revision++;
      stored = null;
      flight = null;
      const saved = await access.save(next.code);
      access.checkCurrent();
      stored = Promise.resolve(saved);
      if (saved !== next.code) throw new Error("The saved discount code did not match this change. Refresh before buying.");
      return next;
    });
    writes = task;
    return task;
  }
  async function purchaseCode(access: Access, explicit: string | undefined): Promise<string> {
    if (explicit !== undefined) return normalizeDiscountCode(explicit);
    const saved = await discount(access);
    if (saved.code && !saved.active) throw new Error(`The saved discount could not be activated: ${saved.error ?? "validation unavailable"}. Change or clear it before a new purchase.`);
    return saved.active ? saved.code! : "";
  }
  return { discount, set, purchaseCode };
}
