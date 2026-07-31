import { describe, expect, test } from "bun:test";
import {
  encodeMailCryptoRewrapRequest,
  parseMailCryptoRewrapResult,
  type MailBackendCryptoProgress,
  type MailBackendEncryptedHeader,
  type MailBackendEncryptedInboxItem,
  type MailBackendEncryptedListPage,
  type MailCryptoRewrapRequest,
} from "../src/backend.ts";
import {
  MailRotationError,
  MailRotationResidentWorkflow,
  type MailRotationDependencies,
} from "../src/mail_rotation.ts";
import type { MailCryptoSessionSnapshot } from "../src/mail_crypto_session.ts";

const HOLDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

describe("Mail current/previous local-wrap migration", () => {
  test("encodes a closed wrap-only request and strictly parses counters", () => {
    const encoded = encodeMailCryptoRewrapRequest({
      expectedCurrentEpoch: "8",
      expectedPreviousEpoch: "7",
      targets: [{
        kind: "inbox",
        localId: "4",
        expectedLocalWrappedCek: bytes(4, 1),
        replacementLocalWrappedCek: bytes(4, 9),
      }],
    });
    expect(encoded).toEqual({
      expected_current_epoch: "8",
      expected_previous_epoch: "7",
      targets: [{
        inbox: {
          local_id: "4",
          expected_local_wrapped_cek: bytes(4, 1),
          replacement_local_wrapped_cek: bytes(4, 9),
        },
      }],
    });
    expect(JSON.stringify(encoded)).not.toMatch(/ciphertext|delivery|subject|body/iu);

    expect(parseMailCryptoRewrapResult({
      changed: 1n,
      message_wraps_changed: 1n,
      settings_wrap_changed: false,
      progress: candidProgress(8n, 7n, 0n),
    })).toMatchObject({
      changed: "1",
      messageWrapsChanged: "1",
      settingsWrapChanged: false,
      progress: { readyToRetire: true },
    });
  });

  test("copies the maximum 100 nested Blob leaves in a rewrap commit", () => {
    const request: MailCryptoRewrapRequest = {
      expectedCurrentEpoch: "8",
      expectedPreviousEpoch: "7",
      targets: Array.from({ length: 50 }, (_, index) => ({
        kind: "inbox" as const,
        localId: (index + 1).toString(),
        expectedLocalWrappedCek: bytes(32, index + 1),
        replacementLocalWrappedCek: bytes(32, index + 101),
      })),
    };
    const expectedFirst = request.targets[0]!.expectedLocalWrappedCek.slice();
    const encoded = encodeMailCryptoRewrapRequest(request);
    expect(collectBytes(encoded)).toHaveLength(100);

    request.targets[0]!.expectedLocalWrappedCek.fill(0xff);
    expect(collectBytes(encoded)[0]).toEqual(expectedFirst);
  });

  test("rewraps fifty records per commit and resumes safely after resident restart", async () => {
    const records = Array.from({ length: 51 }, (_, index) => inboxItem(index + 1));
    const immutable = records.map((record) => ({
      id: record.localId,
      deliveryEpoch: record.encryptedHeader.deliveryKeyEpoch,
      deliveryFingerprint: record.encryptedHeader.deliveryKeyFingerprint.slice(),
      messageId: record.encryptedHeader.messageId.slice(),
      headerNonce: record.encryptedHeader.headerNonce.slice(),
      headerCiphertext: record.encryptedHeader.headerCiphertextAndTag.slice(),
    }));
    let progress = cryptoProgress(51);
    const commits: MailCryptoRewrapRequest[] = [];
    const dependencies = migrationDependencies({
      progress: () => progress,
      records,
      commit(request) {
        commits.push(request);
        for (const target of request.targets) {
          if (target.kind !== "inbox") throw new Error("unexpected target");
          const record = records.find((candidate) => candidate.localId === target.localId)!;
          record.encryptedHeader.localWrapEpoch = "8";
          record.encryptedHeader.localWrapFingerprint = bytes(32, 0x88);
          record.encryptedHeader.localWrappedCek = target.replacementLocalWrappedCek.slice();
        }
        const remaining = records.filter((record) =>
          record.encryptedHeader.localWrapEpoch === "7"
        ).length;
        progress = cryptoProgress(remaining, Number(progress.revision) + 1);
        return progress;
      },
    });

    const first = await new MailRotationResidentWorkflow(dependencies).migrateStep();
    expect(first.changed).toBe("50");
    expect(first.scanned).toBe("50");
    expect(first.progress.previousReferences.total).toBe("1");

    // Simulate a resident crash/reload: the optimization cursor disappears,
    // but authoritative wrap epochs and reference counts resume the migration.
    const resumed = await new MailRotationResidentWorkflow(dependencies).migrateStep();
    expect(resumed.changed).toBe("1");
    expect(resumed.progress).toMatchObject({
      previousReferences: { total: "0" },
      readyToRetire: true,
    });
    expect(commits.map((request) => request.targets.length)).toEqual([50, 1]);
    for (const request of commits) {
      expect(Object.keys(request).sort()).toEqual([
        "expectedCurrentEpoch",
        "expectedPreviousEpoch",
        "targets",
      ]);
      expect(JSON.stringify(request)).not.toMatch(/ciphertext|delivery|subject|body/iu);
    }
    records.forEach((record, index) => {
      expect(record.encryptedHeader.deliveryKeyEpoch).toBe(immutable[index]!.deliveryEpoch);
      expect(record.encryptedHeader.deliveryKeyFingerprint).toEqual(
        immutable[index]!.deliveryFingerprint,
      );
      expect(record.encryptedHeader.messageId).toEqual(immutable[index]!.messageId);
      expect(record.encryptedHeader.headerNonce).toEqual(immutable[index]!.headerNonce);
      expect(record.encryptedHeader.headerCiphertextAndTag).toEqual(
        immutable[index]!.headerCiphertext,
      );
    });
  });

  test("requires separately unlocked current and previous generations before scanning", async () => {
    let listed = false;
    const dependencies = migrationDependencies({
      progress: () => cryptoProgress(1),
      records: [inboxItem(1)],
      session: unlockedSession(false),
      commit: () => cryptoProgress(0),
      onList: () => { listed = true; },
    });
    await expect(new MailRotationResidentWorkflow(dependencies).migrateStep())
      .rejects.toMatchObject({ code: "previous_locked" });
    expect(listed).toBe(false);
  });

  test("absorbs one post-rotation binding race without consuming the migration action", async () => {
    const records = Array.from({ length: 51 }, (_, index) => inboxItem(index + 1));
    let progress = cryptoProgress(51);
    let readinessChecks = 0;
    const commits: MailCryptoRewrapRequest[] = [];
    const dependencies = migrationDependencies({
      progress: () => progress,
      records,
      commit(request) {
        commits.push(request);
        progress = cryptoProgress(1, 2);
        return progress;
      },
    });
    dependencies.session = {
      status: async () => {
        readinessChecks += 1;
        // The first gate succeeds. The binding changes while the bounded
        // batch is prepared, then its one internal retry observes both keys.
        if (readinessChecks === 2) throw new Error("binding is still settling");
        return unlockedSession(true);
      },
    };

    const result = await new MailRotationResidentWorkflow(dependencies).migrateStep();

    expect(readinessChecks).toBe(3);
    expect(result.changed).toBe("50");
    expect(result.progress.previousReferences.total).toBe("1");
    expect(commits).toHaveLength(1);
    expect(commits[0]!.targets).toHaveLength(50);
  });
});

function migrationDependencies(input: {
  progress: () => MailBackendCryptoProgress;
  records: MailBackendEncryptedInboxItem[];
  commit: (request: MailCryptoRewrapRequest) => MailBackendCryptoProgress;
  session?: MailCryptoSessionSnapshot;
  onList?: () => void;
}): MailRotationDependencies {
  return {
    status: async () => input.progress(),
    session: { status: async () => input.session ?? unlockedSession(true) },
    settings: async () => null,
    list: async (request) => {
      input.onList?.();
      if (request.folder !== "inbox") return emptyPage();
      const offset = Number(request.offset ?? "0");
      const items = input.records.slice(offset, offset + request.limit);
      const next = offset + items.length;
      return {
        revision: input.progress().revision,
        contactsRevision: "1",
        cleanupEpoch: "0",
        items,
        total: String(input.records.length),
        nextOffset: next < input.records.length ? String(next) : null,
        ciphertextBytes: String(items.length * 2_064),
      };
    },
    worker: {
      rewrap: async (localWrap) => ({
        type: "rewrapped",
        localWrap: {
          epoch: "8",
          fingerprint: bytes(32, 0x88),
          wrappedCek: localWrap.wrappedCek.map((value) => value ^ 0xff),
        },
      }),
    },
    rewrap: async (request) => {
      const next = input.commit(request);
      return {
        changed: String(request.targets.length),
        messageWrapsChanged: String(request.targets.length),
        settingsWrapChanged: false,
        progress: next,
      };
    },
  };
}

function unlockedSession(previousUnlocked: boolean): MailCryptoSessionSnapshot {
  return {
    version: 1,
    lockState: "unlocked",
    currentEpoch: "8",
    previousEpoch: "7",
    currentUnlocked: true,
    previousUnlocked,
    inactivityExpiresAt: "9999999999999",
  };
}

function cryptoProgress(remaining: number, revision = 1): MailBackendCryptoProgress {
  return {
    revision: String(revision),
    keyHolder: HOLDER,
    currentEpoch: "8",
    previousEpoch: "7",
    previousReferences: {
      settings: "0",
      inbox: String(remaining),
      outbox: "0",
      total: String(remaining),
    },
    readyToRetire: remaining === 0,
  };
}

function inboxItem(id: number): MailBackendEncryptedInboxItem {
  return {
    kind: "inbox",
    localId: String(id),
    sender: "un4fu-tqaaa-aaaab-qadjq-cai",
    receivedAtNs: String(id),
    read: false,
    knownAtReceipt: false,
    currentContact: { status: "not_in_contacts" },
    retainedBytes: "4096",
    encryptedHeader: encryptedHeader(id),
  };
}

function encryptedHeader(id: number): MailBackendEncryptedHeader {
  return {
    messageId: bytes(16, id),
    deliveryKeyEpoch: "7",
    deliveryKeyFingerprint: bytes(32, 0x27),
    localWrapEpoch: "7",
    localWrapFingerprint: bytes(32, 0x37),
    localWrappedCek: bytes(168, id),
    headerNonce: bytes(12, 0x47),
    headerCiphertextAndTag: bytes(2_064, 0x57),
  };
}

function emptyPage(): MailBackendEncryptedListPage {
  return {
    revision: "1",
    contactsRevision: "1",
    cleanupEpoch: "0",
    items: [],
    total: "0",
    nextOffset: null,
    ciphertextBytes: "0",
  };
}

function candidProgress(current: bigint, previous: bigint, remaining: bigint) {
  return {
    mail_revision: 1n,
    key_holder: HOLDER,
    current_epoch: current,
    previous_epoch: previous,
    previous_references: {
      settings: 0n,
      inbox: remaining,
      outbox: 0n,
      total: remaining,
    },
    ready_to_retire: remaining === 0n,
  };
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 29) & 0xff);
}

function collectBytes(value: unknown): Uint8Array[] {
  if (value instanceof Uint8Array) return [value];
  if (Array.isArray(value)) return value.flatMap(collectBytes);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectBytes);
  }
  return [];
}
