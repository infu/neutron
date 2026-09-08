/**
 * The one-click path from "my neurons exist" to "this app can vote with them".
 *
 * It lives in the SNS header rather than a separate Setup screen because that
 * is where the owner already is when they think about a DAO. Everything it can
 * do without the owner's signature, it does on one click; everything it cannot,
 * it names precisely and links straight to.
 */

import { useCallback, useEffect, useState } from "react";
import { querySelf, updateSelf } from "neutron-tools/app";
import {
  describeRegistration,
  readRegistration,
  type RegistrationStatus,
} from "../data/registration";
import { encodeAddVotingPermissions } from "../data/manage_neuron";
import { readHotkey, relayManageNeuron, type HotkeyStatus } from "../data/relay";
import { shortenId } from "../data/format";
import { IconButton } from "./IconButton";
import { NeuronIcon } from "./Icons";

export interface RegistrationTarget {
  rootCanisterId: string;
  governanceCanisterId: string;
  label: string;
}

interface Allowlisted {
  votingEnabled: boolean;
  agentVotingEnabled: boolean;
  present: boolean;
}

/** Read this SNS's row out of the owner-approved allowlist. */
async function readAllowlisted(rootCanisterId: string): Promise<Allowlisted> {
  const raw = (await querySelf("snsgov_config", [null])) as unknown as {
    snses: {
      sns: string | { toText(): string };
      voting_enabled?: boolean;
      agent_voting_enabled?: boolean;
    }[];
  };
  const row = raw.snses.find((entry) => {
    const sns = typeof entry.sns === "string" ? entry.sns : entry.sns.toText();
    return sns === rootCanisterId;
  });
  return {
    present: row !== undefined,
    votingEnabled: Boolean(row?.voting_enabled),
    agentVotingEnabled: Boolean(row?.agent_voting_enabled),
  };
}

export function RegistrationButton({
  target,
  onChanged,
}: {
  target: RegistrationTarget;
  onChanged?: () => void;
}) {
  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null);
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [allowlisted, setAllowlisted] = useState<Allowlisted | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const key = await readHotkey();
      setHotkey(key);
      const [registration, allow] = await Promise.all([
        readRegistration(target.governanceCanisterId, key.principal),
        readAllowlisted(target.rootCanisterId),
      ]);
      setStatus(registration);
      setAllowlisted(allow);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setLoading(false);
    }
  }, [target.governanceCanisterId, target.rootCanisterId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Do everything that does not need the owner's own signature: admit the SNS,
   * turn voting on, and finish any grant we are already allowed to finish.
   */
  const register = useCallback(async () => {
    if (!hotkey) return;
    setBusy(true);
    setMessage(null);
    try {
      const allow = await readAllowlisted(target.rootCanisterId);
      if (!allow.present || !allow.votingEnabled) {
        // The Kernel throws the backend's `#err` text, so there is no
        // `{ err }` envelope here — a refusal lands in the catch below.
        await updateSelf("snsgov_sns_upsert", [
          {
            sns: target.rootCanisterId,
            governance: target.governanceCanisterId,
            voting_enabled: true,
            agent_voting_enabled: allow.agentVotingEnabled,
            label_text: target.label.slice(0, 64),
          },
        ]);
      }

      const repairable = status?.repairable ?? [];
      const failures: string[] = [];
      for (const neuron of repairable) {
        const outcome = await relayManageNeuron({
          snsRootCanisterId: target.rootCanisterId,
          args: encodeAddVotingPermissions({
            neuronId: neuron.neuronId,
            principal: hotkey.principal,
          }),
          kind: "grant",
        });
        if (!outcome.ok) {
          failures.push(`${shortenId(neuron.neuronId, 6, 4)}: ${outcome.errorMessage ?? "rejected"}`);
        }
      }
      await load();
      if (failures.length > 0) {
        setMessage((refreshError) =>
          [`Could not finish: ${failures.join("; ")}`, refreshError].filter(Boolean).join("\n"),
        );
      }
      onChanged?.();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [hotkey, status, target, load, onChanged]);

  const enabled = allowlisted?.votingEnabled ?? false;
  const found = status?.found.length ?? 0;
  const label = status === null && !loading
    ? "Retry checking your neurons"
    : describeRegistration(status, enabled);
  // Nothing left to do only when this SNS is admitted and every neuron is ready.
  const settled = enabled && status !== null && status.repairable.length === 0 && found > 0;

  return (
    // The panel must not be a flex child of the header's action cluster: it
    // gets squeezed into an icon-width column and wraps one character per
    // line. Anchor it and float it beneath the button instead.
    <span className="snsgov-anchor">
      <IconButton
        disabled={busy || loading}
        label={label}
        onClick={() => {
          if (status === null) {
            void load();
          } else if (settled || found === 0) {
            setOpen((value) => !value);
            if (!open) void load();
          } else {
            void register();
          }
        }}
        pressed={settled}
      >
        <span className="snsgov-count">
          <NeuronIcon />
          <span className="snsgov-count-text">
            {status === null ? "…" : `${status.ready}/${found}`}
          </span>
        </span>
      </IconButton>

      {(open || message) && (
        <RegistrationPanel
          hotkey={hotkey}
          message={message}
          onClose={() => {
            setOpen(false);
            setMessage(null);
          }}
          status={status}
          target={target}
        />
      )}
    </span>
  );
}

function RegistrationPanel({
  status,
  hotkey,
  target,
  message,
  onClose,
}: {
  status: RegistrationStatus | null;
  hotkey: HotkeyStatus | null;
  target: RegistrationTarget;
  message: string | null;
  onClose: () => void;
}) {
  return (
    <div className="nt-panel snsgov-panel" role="status">
      <div className="snsgov-panel-head">
        <strong className="nt-text">Voting access</strong>
        <button className="nt-button nt-button--ghost" onClick={onClose} type="button">
          Close
        </button>
      </div>
      {message && (
        <p className="nt-alert nt-alert--danger" role="alert">
          {message}
        </p>
      )}
      {status && status.found.length === 0 && hotkey && (
        <p className="nt-text">
          No neuron here names <code className="nt-code">{shortenId(hotkey.principal, 8, 6)}</code>{" "}
          yet. Add it as a hotkey on the neuron in a wallet that controls it, then reopen this.
        </p>
      )}
      {status && status.blocked.length > 0 && (
        <>
          <p className="nt-text">
            These neurons name your principal but withhold voting, and the SNS only lets a holder of{" "}
            <code className="nt-code">ManagePrincipals</code> change that — so this one is yours to
            make:
          </p>
          <ul className="snsgov-principals">
            {status.blocked.map((neuron) => (
              <li key={neuron.neuronId}>
                <a
                  className="nt-link"
                  href={`https://nns.ic0.app/neuron/?u=${target.rootCanisterId}&neuron=${neuron.neuronId}`}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {shortenId(neuron.neuronId, 8, 6)}
                </a>{" "}
                <span className="nt-meta">missing {neuron.missing.join(" and ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {status?.truncated && (
        <p className="nt-meta">
          Only the first 100 neurons are visible for one principal; there may be more.
        </p>
      )}
    </div>
  );
}
