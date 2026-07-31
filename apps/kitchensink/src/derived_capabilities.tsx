import { querySelf, type JsonValue } from "neutron-tools/app";
import {
  CapabilityFrame,
  EvidenceList,
  OperationResult,
  useOperation,
} from "./lab_ui.tsx";

export const DERIVED_CAPABILITY_IDS = ["composition"] as const;
export type DerivedCapabilityId = (typeof DERIVED_CAPABILITY_IDS)[number];

const DECLARATION = `"dependencies": {
  "contacts": {
    "app": "contacts",
    "min_version": 101,
    "functions": ["contacts_neutron_revision_v2"]
  }
},
"func": {
  "function_resource_snapshot": {
    "type": "query",
    "arg": [
      "caller",
      "canister_principal",
      "memory_kitchensink"
    ]
  }
}`;

export function DerivedCapabilityPage({
  id,
}: {
  id: DerivedCapabilityId;
}) {
  if (id !== "composition") return null;
  return <CompositionPage />;
}

function CompositionPage() {
  const operation = useOperation();

  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Live derived plan"
      purpose="Prove that app composition stays narrow: Kitchen Sink receives one typed Contacts function, while generated wrappers inject only each method's ordered resources."
      boundary="Apps cannot construct or widen app_calls handles, caller identities, canister identities, or stable-memory references. The compiler derives those leaves from the reviewed manifests, the kernel fingerprints the exact order, and the browser supplies only the methods' ordinary unit input."
      declaration={DECLARATION}
      evidence={(
        <EvidenceList items={[
          {
            label: "app_calls leaf",
            value: <code>contacts.contacts_neutron_revision_v2</code>,
          },
          {
            label: "app_exports source",
            value: <code>contacts@0.1.1 · exact internal export</code>,
          },
          {
            label: "Injected order",
            value: <code>caller → canister_principal → memory_kitchensink</code>,
          },
          {
            label: "Memory authority",
            value: "Only this app's kitchensink namespace",
          },
        ]} />
      )}
    >
      <p>
        One click runs two read-only backend queries: the first calls the exact
        Contacts export and returns its live book revision; the second returns
        the real wrapper caller, this Neutron canister, and the counter read
        through the injected Kitchen Sink memory resource.
      </p>
      <button
        className="nt-button nt-button--primary"
        disabled={operation.busy !== null}
        onClick={() => {
          void operation.run("derived capability proof", async () => {
            const [typedDependency, injectedResources] = await Promise.all([
              querySelf<JsonValue>("dependency_status", [null], 20),
              querySelf<JsonValue>("function_resource_snapshot", [null], 20),
            ]);
            return {
              app_calls_and_contacts_export: typedDependency,
              function_resources: injectedResources,
            };
          });
        }}
        type="button"
      >
        Run composition proof
      </button>
      <OperationResult
        busy={operation.busy}
        error={operation.error}
        result={operation.result}
        idle="Run the proof to inspect the live Contacts revision and injected resource values."
        testId="kitchen-composition-result"
      />
    </CapabilityFrame>
  );
}
