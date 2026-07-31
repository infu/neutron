import { expect, test } from "bun:test";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import { planAppDependencies } from "../src/app_dependencies.ts";

function app(
  id: string,
  options: Partial<PackagedNeutronManifest> = {},
): PackagedNeutronManifest {
  return {
    format: 3,
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    version: 100,
    entry: id,
    ...options,
  };
}

function provider(id = "contacts", version = 102): PackagedNeutronManifest {
  return app(id, {
    version,
    func: {
      list_contacts: {
        type: "internal",
        async: "async*",
        expose: "apps",
      },
      upsert_contact: {
        type: "internal",
        async: "async*",
        expose: "apps",
      },
    },
  });
}

function consumer(
  id: string,
  providerId = "contacts",
  minVersion = 102,
): PackagedNeutronManifest {
  return app(id, {
    dependencies: {
      people: {
        app: providerId,
        min_version: minVersion,
        functions: ["list_contacts"],
      },
    },
  });
}

test("dependency planner resolves one provider for many consumers", () => {
  const plan = planAppDependencies({
    kernel: app("kernel"),
    contacts: provider(),
    calendar: consumer("calendar"),
    mailer: consumer("mailer"),
  });

  expect(plan.order).toEqual(["kernel", "contacts", "calendar", "mailer"]);
  expect(plan.dependenciesByConsumer.calendar).toEqual([
    {
      alias: "people",
      consumer: "calendar",
      provider: "contacts",
      minVersion: 102,
      providerVersion: 102,
      functions: ["list_contacts"],
    },
  ]);
  expect(plan.dependentsByProvider.contacts).toEqual([
    {
      consumer: "calendar",
      alias: "people",
      minVersion: 102,
      functions: ["list_contacts"],
    },
    {
      consumer: "mailer",
      alias: "people",
      minVersion: 102,
      functions: ["list_contacts"],
    },
  ]);
});

test("dependency planner uses Motoko-compatible canonical text ordering", () => {
  const plan = planAppDependencies({
    z_app: app("z_app"),
    aa_app: app("aa_app"),
  });
  expect(plan.order).toEqual(["aa_app", "z_app"]);
});

test("dependency planner accepts minimum and higher provider versions", () => {
  for (const version of [102, 103, 119]) {
    expect(() =>
      planAppDependencies({
        contacts: provider("contacts", version),
        calendar: consumer("calendar"),
      }),
    ).not.toThrow();
  }
});

test("dependency planner reports missing and old providers", () => {
  expect(() => planAppDependencies({ calendar: consumer("calendar") })).toThrow(
    "Calendar requires Contacts v0.1.2 or newer; Contacts is not installed.",
  );
  expect(() =>
    planAppDependencies({
      contacts: provider("contacts", 101),
      calendar: consumer("calendar"),
    }),
  ).toThrow(
    "Calendar requires Contacts v0.1.2 or newer; v0.1.1 is installed.",
  );
});

test("dependency planner reports missing, public, and unexposed functions", () => {
  const contacts = provider();
  delete contacts.func!.list_contacts;
  expect(() =>
    planAppDependencies({ contacts, calendar: consumer("calendar") }),
  ).toThrow(
    "Contacts v0.1.2 violates Calendar's dependency: list_contacts is missing.",
  );

  contacts.func!.list_contacts = { type: "query" };
  expect(() =>
    planAppDependencies({ contacts, calendar: consumer("calendar") }),
  ).toThrow("Contacts.list_contacts required by Calendar is not internal.");

  contacts.func!.list_contacts = { type: "internal" };
  expect(() =>
    planAppDependencies({ contacts, calendar: consumer("calendar") }),
  ).toThrow("Contacts.list_contacts is internal but is not exposed to apps.");
});

test("dependency planner orders nested providers before consumers", () => {
  const search = provider("search", 100);
  search.dependencies = {
    files: {
      app: "files",
      min_version: 100,
      functions: ["list_contacts"],
    },
  };
  const editor = consumer("editor", "search", 100);

  const plan = planAppDependencies({
    editor,
    search,
    files: provider("files", 100),
  });
  expect(plan.order).toEqual(["files", "search", "editor"]);
});

test("dependency planner returns the deterministic cycle path", () => {
  const alpha = provider("alpha", 100);
  const beta = provider("beta", 100);
  const files = provider("files", 100);
  for (const [consumerApp, providerId] of [
    [alpha, "beta"],
    [beta, "files"],
    [files, "alpha"],
  ] as const) {
    consumerApp.dependencies = {
      next: {
        app: providerId,
        min_version: 100,
        functions: ["list_contacts"],
      },
    };
  }

  expect(() => planAppDependencies({ alpha, beta, files })).toThrow(
    "Dependency cycle: alpha -> beta -> files -> alpha.",
  );
});

test("dependency declarations directly derive the backend app_calls group", () => {
  const calendar = consumer("calendar");
  const plan = planAppDependencies({ contacts: provider(), calendar });
  expect(plan.dependenciesByConsumer.calendar).toHaveLength(1);
  expect(plan.dependenciesByConsumer.contacts).toEqual([]);
});

test("dependency planner rejects mismatched config keys", () => {
  expect(() => planAppDependencies({ wrong: app("right_app") })).toThrow(
    "Config key wrong does not match app id right_app",
  );
});
