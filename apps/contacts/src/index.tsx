import { createRoot } from "react-dom/client";
import {
  IoAdd,
  IoArrowBack,
  IoCheckmark,
  IoChevronForward,
  IoClose,
  IoCopyOutline,
  IoCreateOutline,
  IoPeopleOutline,
  IoPersonOutline,
  IoRefreshOutline,
  IoSearchOutline,
  IoStar,
  IoStarOutline,
  IoTrashOutline,
  IoWarningOutline,
} from "react-icons/io5";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import {
  copyToClipboard,
  loadTileContext,
  onAppStateChange,
  onTileViewRequest,
  type JsonObject,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import {
  normalizeAddressLabel,
  normalizeContactName,
  normalizeDestination,
  validateNotes,
} from "./address.ts";
import { ContactsClient } from "./client.ts";
import {
  contactPrefillBroker,
  type ContactPrefill,
} from "./contact_prefill.ts";
import { destinationText, normalizeDraftAddresses } from "./contacts.ts";
import { settleListRequestBusy } from "./request_state.ts";
import {
  NETWORKS,
  NETWORK_LABELS,
  type Contact,
  type ContactAddressDraft,
  type ContactKind,
  type ContactSummary,
  type Network,
  type SearchPage,
} from "./model.ts";
import "./style.scss";

const POLL_INTERVAL_MS = 15_000;
const STATE_TOPIC = "contacts";
const REVISION_RETRY_MS = [0, 80, 200, 500, 1_000] as const;

type Draft = {
  id: string | null;
  expectedRevision: string | null;
  kind: ContactKind;
  name: string;
  notes: string;
  addresses: ContactAddressDraft[];
};

type DraftErrors = {
  name?: string;
  notes?: string;
  general?: string;
  addresses: Record<number, string>;
};

export function App() {
  const context = useMemo(() => loadTileContext(), []);
  const client = useMemo(
    () =>
      new ContactsClient(
        `app:${context.app ?? "contacts"}:background` as MsgBusEndpointId,
      ),
    [context.app],
  );
  const [page, setPage] = useState<SearchPage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({ addresses: {} });
  const [query, setQuery] = useState("");
  const [networkFilter, setNetworkFilter] = useState<Network | "">("");
  const [busy, setBusy] = useState<string | null>("initial");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [addNetwork, setAddNetwork] = useState<Network>("internet_computer");
  const editingRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const pageRevisionRef = useRef(0n);
  const pendingRevisionRef = useRef<bigint | null>(null);
  const changeRefreshRunningRef = useRef(false);

  useEffect(() => {
    editingRef.current = draft !== null;
  }, [draft]);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const loadList = useCallback(
    async (foreground = false) => {
      const request = ++requestRef.current;
      if (foreground) setBusy("list");
      try {
        const next = await client.search({
          query,
          ...(networkFilter ? { network: networkFilter } : {}),
          limit: 50,
        });
        if (request === requestRef.current) {
          pageRevisionRef.current = BigInt(next.revision);
          setPage(next);
          setError(null);
        }
        return next;
      } catch (reason) {
        if (request === requestRef.current) setError(errorMessage(reason));
        return null;
      } finally {
        setBusy((current) =>
          settleListRequestBusy(request, requestRef.current, current),
        );
      }
    },
    [client, networkFilter, query],
  );

  const loadContact = useCallback(
    async (id: string, foreground = false) => {
      if (foreground) setBusy("contact");
      try {
        const next = await client.get(id, true);
        if (selectedRef.current === id && !editingRef.current) {
          setContact(next);
          if (!next) setSelectedId(null);
        }
        setError(null);
        return next;
      } catch (reason) {
        setError(errorMessage(reason));
        return null;
      } finally {
        if (foreground) setBusy(null);
      }
    },
    [client],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(true), 160);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  const refreshVisible = useCallback(async () => {
    if (document.hidden) return;
    await loadList(false);
    const id = selectedRef.current;
    if (id && !editingRef.current) await loadContact(id, false);
  }, [loadContact, loadList]);

  const refreshChangedState = useCallback(async () => {
    if (changeRefreshRunningRef.current) return;
    changeRefreshRunningRef.current = true;
    try {
      for (const delayMs of REVISION_RETRY_MS) {
        const target = pendingRevisionRef.current;
        if (target === null || pageRevisionRef.current >= target) break;
        if (delayMs > 0) await wait(delayMs);
        await loadList(false);
      }
      const target = pendingRevisionRef.current;
      if (target !== null && pageRevisionRef.current >= target) {
        pendingRevisionRef.current = null;
      }
      const id = selectedRef.current;
      if (id && id !== "new" && !editingRef.current) {
        await loadContact(id, false);
      }
    } finally {
      changeRefreshRunningRef.current = false;
    }
  }, [loadContact, loadList]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void refreshVisible();
    };
    const onFocus = () => void refreshVisible();
    const interval = window.setInterval(() => void refreshVisible(), POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshVisible]);

  useEffect(
    () =>
      onAppStateChange(STATE_TOPIC, ({ revision }) => {
        const next = BigInt(revision);
        if (next <= pageRevisionRef.current) return;
        if (
          pendingRevisionRef.current === null ||
          next > pendingRevisionRef.current
        ) {
          pendingRevisionRef.current = next;
        }
        void refreshChangedState();
      }),
    [refreshChangedState],
  );

  async function selectContact(id: string) {
    setSelectedId(id);
    selectedRef.current = id;
    setDraft(null);
    setDeleteArmed(false);
    setNotice(null);
    setContact(null);
    await loadContact(id, true);
  }

  const startCreate = useCallback((prefill?: ContactPrefill) => {
    editingRef.current = true;
    setSelectedId("new");
    selectedRef.current = "new";
    setContact(null);
    setNotice(
      prefill
        ? "Prefilled by another app. Review the unverified name and address before saving."
        : null,
    );
    setDeleteArmed(false);
    setDraft(
      prefill
        ? {
            ...blankDraft(),
            name: prefill.name,
            addresses: [
              {
                id: null,
                label: null,
                preferred: false,
                destination: {
                  network: "neutron",
                  principal: prefill.principal,
                },
              },
            ],
          }
        : blankDraft(),
    );
    setDraftErrors({ addresses: {} });
  }, []);

  useEffect(
    () =>
      contactPrefillBroker.subscribe((prefill) => {
        if (editingRef.current) {
          setNotice("Finish or cancel the current edit before adding this sender");
          return "busy";
        }
        startCreate(prefill);
        return "ready";
      }),
    [startCreate],
  );

  useEffect(
    () =>
      onTileViewRequest((view) => {
        if (view !== "create") return;
        if (editingRef.current) {
          setNotice("Finish or cancel the current edit before creating a contact");
          return;
        }
        startCreate();
      }),
    [startCreate],
  );

  function startEdit() {
    if (!contact) return;
    setDeleteArmed(false);
    setNotice(null);
    setDraft(toDraft(contact));
    setDraftErrors({ addresses: {} });
  }

  function closeDetail() {
    setSelectedId(null);
    selectedRef.current = null;
    setContact(null);
    setDraft(null);
    setDeleteArmed(false);
    setNotice(null);
    setError(null);
  }

  function cancelEdit() {
    if (contact) {
      setDraft(null);
      setDraftErrors({ addresses: {} });
    } else {
      closeDetail();
    }
  }

  function updateDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateAddress(index: number, patch: Partial<ContactAddressDraft>) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        addresses: current.addresses.map((address, candidate) =>
          candidate === index ? { ...address, ...patch } : address,
        ),
      };
    });
    setDraftErrors((current) => {
      const addresses = { ...current.addresses };
      delete addresses[index];
      return { ...current, addresses };
    });
  }

  function changeAddressNetwork(index: number, network: Network) {
    updateAddress(index, {
      destination: blankDestination(network),
      preferred: false,
    });
  }

  function addAddress() {
    setDraft((current) =>
      current && current.addresses.length < 20
        ? {
            ...current,
            addresses: [
              ...current.addresses,
              {
                id: null,
                label: null,
                preferred: false,
                destination: blankDestination(addNetwork),
              },
            ],
          }
        : current,
    );
  }

  function removeAddress(index: number) {
    setDraft((current) =>
      current
        ? {
            ...current,
            addresses: current.addresses.filter((_, candidate) => candidate !== index),
          }
        : current,
    );
    setDraftErrors({ addresses: {} });
  }

  async function submitDraft() {
    if (!draft) return;
    const checked = validateDraft(draft);
    setDraftErrors(checked.errors);
    if (!checked.value) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const result = await client.save(checked.value);
      setContact(result.contact);
      setSelectedId(result.contact.id);
      selectedRef.current = result.contact.id;
      setDraft(null);
      setNotice(
        result.duplicateContactIds.length > 0
          ? `Also used by ${result.duplicateContactIds.length} contact${result.duplicateContactIds.length === 1 ? "" : "s"}`
          : null,
      );
      await loadList(false);
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      if (/changed elsewhere|current revision|conflict|neutron address|another contact|duplicate/i.test(message)) {
        setDraftErrors((current) => ({ ...current, general: message }));
      }
    } finally {
      setBusy(null);
    }
  }

  async function deleteContact() {
    if (!contact) return;
    setBusy("delete");
    setError(null);
    try {
      await client.remove(contact.id, contact.revision);
      closeDetail();
      await loadList(false);
    } catch (reason) {
      setError(errorMessage(reason));
      setDeleteArmed(false);
    } finally {
      setBusy(null);
    }
  }

  async function reloadDraft() {
    if (!draft?.id) return;
    const latest = await client.get(draft.id, true);
    if (!latest) {
      closeDetail();
      return;
    }
    setContact(latest);
    setDraft(toDraft(latest));
    setDraftErrors({ addresses: {} });
    setError(null);
  }

  const summaries = page?.contacts ?? [];
  const detailOpen = selectedId !== null;

  return (
    <main className="nt-app contacts-app">
      <div className={`contacts-shell${detailOpen ? " is-detail" : ""}`}>
        <section className="contacts-list-pane" aria-label="Contacts">
          <header className="contacts-list-toolbar">
            <label className="contacts-search">
              <IoSearchOutline aria-hidden="true" />
              <input
                aria-label="Search contacts"
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                type="search"
                value={query}
              />
            </label>
            <IconButton label="Add contact" onClick={() => startCreate()}>
              <IoAdd />
            </IconButton>
          </header>
          <div className="contacts-filters">
            <select
              aria-label="Filter destination network"
              onChange={(event) => setNetworkFilter(event.target.value as Network | "")}
              value={networkFilter}
            >
              <option value="">All networks</option>
              {NETWORKS.map((network) => (
                <option key={network} value={network}>
                  {NETWORK_LABELS[network]}
                </option>
              ))}
            </select>
          </div>
          {error && !detailOpen ? <Notice message={error} /> : null}
          <div className="contacts-list" aria-busy={busy === "list" || busy === "initial"}>
            {busy === "initial" && !page ? (
              <Loading />
            ) : summaries.length === 0 ? (
              <div className="contacts-empty">
                <IoPeopleOutline aria-hidden="true" />
                <span>{query || networkFilter ? "No matches" : "No contacts"}</span>
              </div>
            ) : (
              summaries.map((summary) => (
                <ContactRow
                  active={selectedId === summary.id}
                  key={summary.id}
                  onClick={() => void selectContact(summary.id)}
                  summary={summary}
                />
              ))
            )}
          </div>
          <footer className="contacts-list-status">
            <span>{page?.total ?? "0"}</span>
            <IconButton
              active={busy === "list"}
              label="Refresh contacts"
              onClick={() => void loadList(true)}
            >
              <IoRefreshOutline />
            </IconButton>
          </footer>
        </section>

        <section className="contacts-detail-pane" aria-label="Contact details">
          {!detailOpen ? (
            <div className="contacts-detail-empty">
              <IoPersonOutline aria-hidden="true" />
            </div>
          ) : (
            <>
              <header className="contacts-detail-toolbar">
                <IconButton className="contacts-back" label="Back to contacts" onClick={closeDetail}>
                  <IoArrowBack />
                </IconButton>
                <span className="contacts-detail-heading">
                  {draft?.id === null ? "New contact" : draft?.name || contact?.name || "Contact"}
                </span>
                <span className="contacts-spacer" />
                {!draft && contact ? (
                  <>
                    <IconButton label="Edit contact" onClick={startEdit}>
                      <IoCreateOutline />
                    </IconButton>
                    <IconButton
                      className={deleteArmed ? "is-danger" : ""}
                      label={deleteArmed ? "Confirm remove contact" : "Remove contact"}
                      onClick={() =>
                        deleteArmed ? void deleteContact() : setDeleteArmed(true)
                      }
                    >
                      <IoTrashOutline />
                    </IconButton>
                    {deleteArmed ? (
                      <IconButton label="Cancel removal" onClick={() => setDeleteArmed(false)}>
                        <IoClose />
                      </IconButton>
                    ) : null}
                  </>
                ) : null}
              </header>
              {error ? <Notice message={error} /> : null}
              {notice ? <Notice message={notice} quiet /> : null}
              {busy === "contact" && !contact && !draft ? (
                <Loading />
              ) : draft ? (
                <ContactEditor
                  addNetwork={addNetwork}
                  busy={busy !== null}
                  draft={draft}
                  errors={draftErrors}
                  onAddAddress={addAddress}
                  onAddNetwork={setAddNetwork}
                  onCancel={cancelEdit}
                  onChange={updateDraft}
                  onChangeAddress={updateAddress}
                  onChangeAddressNetwork={changeAddressNetwork}
                  onReload={() => void reloadDraft()}
                  onRemoveAddress={removeAddress}
                  onSave={() => void submitDraft()}
                />
              ) : contact ? (
                <ContactView contact={contact} />
              ) : (
                <div className="contacts-detail-empty">
                  <IoWarningOutline aria-hidden="true" />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function ContactRow({
  active,
  onClick,
  summary,
}: {
  active: boolean;
  onClick: () => void;
  summary: ContactSummary;
}) {
  return (
    <button
      className={`contact-row${active ? " is-active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <Initials name={summary.name} />
      <span className="contact-row-copy">
        <span>
          <strong>{summary.name}</strong>
        </span>
        <span className="contact-networks">
          {summary.networks.map((network) => (
            <NetworkMark key={network} network={network} />
          ))}
          {summary.networks.length === 0 ? <small>No destinations</small> : null}
        </span>
      </span>
      <IoChevronForward aria-hidden="true" />
    </button>
  );
}

function ContactView({ contact }: { contact: Contact }) {
  return (
    <div className="contact-view">
      <div className="contact-identity">
        <Initials name={contact.name} large />
        <div>
          <h2>{contact.name}</h2>
          <span>
            {contact.addresses.length} destination
            {contact.addresses.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      {contact.addresses.length > 0 ? (
        <section className="contact-address-groups">
          {NETWORKS.map((network) => {
            const addresses = contact.addresses.filter(
              (address) => address.destination.network === network,
            );
            if (addresses.length === 0) return null;
            return (
              <div className="contact-address-group" key={network}>
                <h3>
                  <NetworkMark network={network} />
                  {NETWORK_LABELS[network]}
                </h3>
                {addresses.map((address) => {
                  const text = destinationText(address.destination);
                  return (
                    <div className="contact-address-view" key={address.id}>
                      <span className="contact-address-copy">
                        <span>
                          {address.label ?? NETWORK_LABELS[network]}
                          {address.preferred ? <IoStar aria-label="Preferred" /> : null}
                        </span>
                        <bdi dir="ltr">
                          <code title={text}>{compactAddress(text)}</code>
                        </bdi>
                      </span>
                      <IconButton
                        label={`Copy ${NETWORK_LABELS[network]} destination`}
                        onClick={() =>
                          void copyToClipboard(text).catch(() => undefined)
                        }
                      >
                        <IoCopyOutline />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>
      ) : (
        <div className="contact-section-empty">No destinations</div>
      )}
      {contact.notes ? (
        <section className="contact-notes">
          <h3>Notes</h3>
          <p>{contact.notes}</p>
        </section>
      ) : null}
      <time className="contact-updated" dateTime={timeIso(contact.updatedAt)}>
        Updated {formatTime(contact.updatedAt)}
      </time>
    </div>
  );
}

function ContactEditor({
  addNetwork,
  busy,
  draft,
  errors,
  onAddAddress,
  onAddNetwork,
  onCancel,
  onChange,
  onChangeAddress,
  onChangeAddressNetwork,
  onReload,
  onRemoveAddress,
  onSave,
}: {
  addNetwork: Network;
  busy: boolean;
  draft: Draft;
  errors: DraftErrors;
  onAddAddress: () => void;
  onAddNetwork: (network: Network) => void;
  onCancel: () => void;
  onChange: (patch: Partial<Draft>) => void;
  onChangeAddress: (index: number, patch: Partial<ContactAddressDraft>) => void;
  onChangeAddressNetwork: (index: number, network: Network) => void;
  onReload: () => void;
  onRemoveAddress: (index: number) => void;
  onSave: () => void;
}) {
  const hasNeutronAddress = draft.addresses.some(
    (address) => address.destination.network === "neutron",
  );
  const addDisabled =
    draft.addresses.length >= 20 || (addNetwork === "neutron" && hasNeutronAddress);
  return (
    <div className="contact-editor">
      <div className="contact-editor-scroll">
        {errors.general ? (
          <div className="contact-conflict" role="alert">
            <IoWarningOutline aria-hidden="true" />
            <span>{errors.general}</span>
            {draft.id ? (
              <button className="nt-button nt-button--secondary nt-button--sm" onClick={onReload} type="button">
                <IoRefreshOutline aria-hidden="true" />
                Reload
              </button>
            ) : null}
          </div>
        ) : null}
        <label className="contact-field">
          <span>Name</span>
          <input
            aria-invalid={Boolean(errors.name)}
            autoFocus={draft.id === null}
            maxLength={120}
            onChange={(event) => onChange({ name: event.target.value })}
            value={draft.name}
          />
          {errors.name ? <small role="alert">{errors.name}</small> : null}
        </label>
        <div className="contact-address-editor">
          <div className="contact-section-heading">
            <span>Destinations</span>
            <span>{draft.addresses.length}/20</span>
          </div>
          {draft.addresses.map((address, index) => (
            <AddressEditor
              address={address}
              error={errors.addresses[index]}
              index={index}
              key={address.id ?? `new-${index}`}
              onChange={onChangeAddress}
              onChangeNetwork={onChangeAddressNetwork}
              onRemove={onRemoveAddress}
              neutronUsedByOther={draft.addresses.some(
                (candidate, candidateIndex) =>
                  candidateIndex !== index && candidate.destination.network === "neutron",
              )}
            />
          ))}
          <div className="contact-add-address">
            <select
              aria-label="New destination network"
              disabled={draft.addresses.length >= 20}
              onChange={(event) => onAddNetwork(event.target.value as Network)}
              value={addNetwork}
            >
              {NETWORKS.map((network) => (
                <option
                  disabled={network === "neutron" && hasNeutronAddress}
                  key={network}
                  value={network}
                >
                  {NETWORK_LABELS[network]}
                </option>
              ))}
            </select>
            <IconButton
              disabled={addDisabled}
              label={
                addNetwork === "neutron" && hasNeutronAddress
                  ? "Only one Neutron address is allowed"
                  : "Add destination"
              }
              onClick={onAddAddress}
            >
              <IoAdd />
            </IconButton>
          </div>
        </div>
        <label className="contact-field">
          <span>Notes</span>
          <AutoTextarea
            aria-invalid={Boolean(errors.notes)}
            maxLength={8192}
            onChange={(event) => onChange({ notes: event.target.value })}
            placeholder="Optional notes"
            rows={2}
            value={draft.notes}
          />
          {errors.notes ? <small role="alert">{errors.notes}</small> : null}
        </label>
      </div>
      <footer className="contact-editor-actions">
        <div className="contact-editor-actions-inner">
          <button className="nt-button nt-button--secondary nt-button--sm" disabled={busy} onClick={onCancel} type="button">
            <IoClose aria-hidden="true" />
            Cancel
          </button>
          <button className="nt-button nt-button--sm" disabled={busy} onClick={onSave} type="button">
            {busy ? <span className="contacts-spinner" /> : <IoCheckmark aria-hidden="true" />}
            Save
          </button>
        </div>
      </footer>
    </div>
  );
}

function AddressEditor({
  address,
  error,
  index,
  onChange,
  onChangeNetwork,
  onRemove,
  neutronUsedByOther,
}: {
  address: ContactAddressDraft;
  error: string | undefined;
  index: number;
  onChange: (index: number, patch: Partial<ContactAddressDraft>) => void;
  onChangeNetwork: (index: number, network: Network) => void;
  onRemove: (index: number) => void;
  neutronUsedByOther: boolean;
}) {
  const destination = address.destination;
  return (
    <div className="contact-address-edit">
      <div className="contact-address-edit-toolbar">
        <select
          aria-label={`Destination ${index + 1} network`}
          onChange={(event) => onChangeNetwork(index, event.target.value as Network)}
          value={destination.network}
        >
          {NETWORKS.map((network) => (
            <option
              disabled={network === "neutron" && neutronUsedByOther}
              key={network}
              value={network}
            >
              {NETWORK_LABELS[network]}
            </option>
          ))}
        </select>
        {destination.network === "neutron" ? (
          <span aria-hidden="true" className="contact-preferred-spacer" />
        ) : (
          <label className="contact-preferred" title="Preferred for this network">
            <input
              checked={address.preferred}
              onChange={(event) => onChange(index, { preferred: event.target.checked })}
              type="checkbox"
            />
            {address.preferred ? <IoStar /> : <IoStarOutline />}
            <span className="nt-sr-only">Preferred</span>
          </label>
        )}
        <IconButton label="Remove destination" onClick={() => onRemove(index)}>
          <IoTrashOutline />
        </IconButton>
      </div>
      <input
        aria-label={`Destination ${index + 1} label`}
        maxLength={64}
        onChange={(event) => onChange(index, { label: event.target.value })}
        placeholder="Label"
        value={address.label ?? ""}
      />
      {destination.network === "neutron" ? (
        <>
          <input
            aria-describedby={`contact-neutron-help-${index}`}
            aria-invalid={Boolean(error)}
            aria-label={`Destination ${index + 1} Neutron address`}
            onChange={(event) =>
              onChange(index, {
                destination: { ...destination, principal: event.target.value },
              })
            }
            placeholder="Canister principal"
            spellCheck={false}
            value={destination.principal}
          />
          <small className="contact-address-help" id={`contact-neutron-help-${index}`}>
            The principal of this person&apos;s Neutron canister.
          </small>
        </>
      ) : destination.network === "internet_computer" ? (
        <input
          aria-invalid={Boolean(error)}
          aria-label={`Destination ${index + 1} ICRC account`}
          onChange={(event) =>
            onChange(index, {
              destination: { ...destination, account: event.target.value },
            })
          }
          placeholder="ICRC account"
          spellCheck={false}
          value={destination.account}
        />
      ) : (
        <input
          aria-invalid={Boolean(error)}
          aria-label={`Destination ${index + 1} address`}
          onChange={(event) =>
            onChange(index, {
              destination: { ...destination, address: event.target.value },
            })
          }
          placeholder={`${NETWORK_LABELS[destination.network]} address`}
          spellCheck={false}
          value={destination.address}
        />
      )}
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}

function validateDraft(draft: Draft): {
  value: Draft | null;
  errors: DraftErrors;
} {
  const errors: DraftErrors = { addresses: {} };
  let name = draft.name;
  let notes = draft.notes;
  try {
    name = normalizeContactName(draft.name);
  } catch (reason) {
    errors.name = errorMessage(reason);
  }
  try {
    notes = validateNotes(draft.notes);
  } catch (reason) {
    errors.notes = errorMessage(reason);
  }
  const addresses = draft.addresses.map((address, index) => {
    try {
      return {
        ...address,
        label: normalizeAddressLabel(address.label),
        destination: normalizeDestination(address.destination),
      };
    } catch (reason) {
      errors.addresses[index] = errorMessage(reason);
      return address;
    }
  });
  if (Object.keys(errors.addresses).length === 0) {
    try {
      normalizeDraftAddresses(addresses);
    } catch (reason) {
      errors.general = errorMessage(reason);
    }
  }
  return {
    value:
      errors.name || errors.notes || errors.general || Object.keys(errors.addresses).length
        ? null
        : { ...draft, name, notes, addresses },
    errors,
  };
}

function Notice({ message, quiet = false }: { message: string; quiet?: boolean }) {
  return (
    <div className={`contacts-notice${quiet ? " is-quiet" : ""}`} role={quiet ? "status" : "alert"}>
      <IoWarningOutline aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function Loading() {
  return (
    <div className="contacts-loading" aria-label="Loading">
      <span className="contacts-spinner" />
    </div>
  );
}

function Initials({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("") || "?";
  return <span className={`contact-initials${large ? " is-large" : ""}`}>{initials}</span>;
}

function NetworkMark({ network }: { network: Network }) {
  const labels: Record<Network, string> = {
    neutron: "N",
    internet_computer: "IC",
    bitcoin_mainnet: "BTC",
    dogecoin_mainnet: "DOGE",
    ethereum_mainnet: "ETH",
    solana_mainnet: "SOL",
  };
  return (
    <span className={`contact-network-mark is-${network}`} title={NETWORK_LABELS[network]}>
      {labels[network]}
    </span>
  );
}

function IconButton({
  active = false,
  children,
  className = "",
  type = "button",
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      className={`nt-icon-button ${className}${active ? " is-active" : ""}`}
      title={label}
      type={type}
      {...props}
    >
      {active ? <span className="contacts-spinner" /> : children}
    </button>
  );
}

function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const resize = (target: HTMLTextAreaElement) => {
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 180)}px`;
  };
  return (
    <textarea
      {...props}
      onInput={(event) => {
        resize(event.currentTarget);
        props.onInput?.(event);
      }}
      ref={(node) => {
        if (node) resize(node);
      }}
    />
  );
}

function blankDraft(): Draft {
  return {
    id: null,
    expectedRevision: null,
    kind: "person",
    name: "",
    notes: "",
    addresses: [],
  };
}

function toDraft(contact: Contact): Draft {
  return {
    id: contact.id,
    expectedRevision: contact.revision,
    kind: contact.kind,
    name: contact.name,
    notes: contact.notes,
    addresses: contact.addresses.map((address) => ({ ...address })),
  };
}

function blankDestination(network: Network): ContactAddressDraft["destination"] {
  return network === "neutron"
    ? { network, principal: "" }
    : network === "internet_computer"
    ? { network, account: "" }
    : { network, address: "" };
}

function compactAddress(value: string): string {
  return value.length > 42 ? `${value.slice(0, 22)}...${value.slice(-14)}` : value;
}

function timestampMillis(value: string): number {
  return Number(BigInt(value) / 1_000_000n);
}

function timeIso(value: string): string {
  return new Date(timestampMillis(value)).toISOString();
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestampMillis(value));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");
createRoot(container).render(<App />);
