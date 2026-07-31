export type MailInactivityCleanupDependencies = {
  worker: {
    onInactivityLock(listener: () => void): () => void;
  };
  session?: {
    onBindingChange(listener: () => void): () => void;
  };
  privateProjections: readonly { clear(): void }[];
  rotation: { reset(): void };
};

/** Bind the worker's physical deadline event to every resident plaintext cache. */
export function bindMailInactivityCleanup(
  dependencies: MailInactivityCleanupDependencies,
): () => void {
  const cleanup = () => {
    for (const projection of dependencies.privateProjections) projection.clear();
    dependencies.rotation.reset();
  };
  const unbindInactivity = dependencies.worker.onInactivityLock(cleanup);
  const unbindBinding = dependencies.session?.onBindingChange(cleanup) ?? (() => undefined);
  return () => {
    unbindInactivity();
    unbindBinding();
  };
}
