export type ManagedMemoryReleaseFixture = Readonly<{
  appId: string;
  candidateArchive: URL;
  candidateVersion: number;
  lock: URL;
  memoryId: string;
  memoryVersion?: number;
  productionArchive: URL;
  production: Readonly<{
    bytes: number;
    sha256: string;
    version: number;
  }>;
}>;

export declare function assertManagedMemoryCodeOnlyRelease(
  fixture: ManagedMemoryReleaseFixture,
): Promise<void>;
