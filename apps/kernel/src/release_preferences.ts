import { create } from "zustand";

export type ReleasePreferences = Readonly<{
  betaEnabled: boolean;
  revision: string;
}>;

export type ReleasePreferencesWire = {
  beta_enabled: boolean;
  revision: bigint;
};

export type ReleasePreferencesActor = {
  get_release_preferences(request: null): Promise<ReleasePreferencesWire>;
  set_release_preferences(betaEnabled: boolean): Promise<ReleasePreferencesWire>;
};

type ReleasePreferencesState = {
  preferences: ReleasePreferences | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
};

type ReleasePreferencesListener = (
  next: ReleasePreferences,
  previous: ReleasePreferences | null,
) => void;

export function createReleasePreferencesService(
  getActor: () => Promise<ReleasePreferencesActor>,
) {
  const useStore = create<ReleasePreferencesState>(() => ({
    preferences: null,
    loading: false,
    saving: false,
    error: null,
  }));
  let reads = 0;
  let writes = 0;

  function accept(wire: ReleasePreferencesWire): ReleasePreferences {
    if (
      !wire ||
      typeof wire.beta_enabled !== "boolean" ||
      typeof wire.revision !== "bigint" ||
      wire.revision < 0n
    ) {
      throw new Error("Kernel returned invalid release preferences.");
    }
    const previous = useStore.getState().preferences;
    // Concurrent queries can finish after a newer owner update. A read from
    // before that update must not restore the old selection in this browser.
    if (previous && BigInt(previous.revision) > wire.revision) return previous;
    if (previous?.revision === wire.revision.toString()) {
      if (previous.betaEnabled !== wire.beta_enabled) {
        throw new Error("Kernel returned conflicting release preferences.");
      }
      useStore.setState({ error: null });
      return previous;
    }
    const next = Object.freeze({
      betaEnabled: wire.beta_enabled,
      revision: wire.revision.toString(),
    });
    useStore.setState({ preferences: next, error: null });
    return next;
  }

  async function request(betaEnabled?: boolean): Promise<ReleasePreferences> {
    const writing = betaEnabled !== undefined;
    if (writing) writes += 1;
    else reads += 1;
    useStore.setState({ loading: reads > 0, saving: writes > 0, error: null });
    try {
      const actor = await getActor();
      return accept(
        writing
          ? await actor.set_release_preferences(betaEnabled)
          : await actor.get_release_preferences(null),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      useStore.setState({ error: message });
      throw cause;
    } finally {
      if (writing) writes -= 1;
      else reads -= 1;
      useStore.setState({ loading: reads > 0, saving: writes > 0 });
    }
  }

  return {
    useStore,
    // Always ask the Kernel: this setting belongs to the Neutron, and another
    // tab or device can change it. The store is presentation state only.
    getReleasePreferences: () => request(),
    setReleasePreferences: (betaEnabled: boolean) => {
      if (typeof betaEnabled !== "boolean") {
        return Promise.reject(new Error("Beta updates must be enabled or disabled."));
      }
      return request(betaEnabled);
    },
    subscribeReleasePreferences: (listener: ReleasePreferencesListener) =>
      useStore.subscribe((state, previous) => {
        if (state.preferences && state.preferences !== previous.preferences) {
          listener(state.preferences, previous.preferences);
        }
      }),
  };
}

const releasePreferences = createReleasePreferencesService(async () => {
  // Keep Settings renderable without starting an authenticated browser actor.
  const { getNeutronCan } = await import("./reducer/auth.ts");
  return getNeutronCan();
});

export const useReleasePreferencesStore = releasePreferences.useStore;
export const getReleasePreferences = releasePreferences.getReleasePreferences;
export const setReleasePreferences = releasePreferences.setReleasePreferences;
export const subscribeReleasePreferences =
  releasePreferences.subscribeReleasePreferences;
