import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { parseDecoderPack, type DecoderPack } from "./descriptor.ts";
import {
  installDecoderPack,
  readDecoderPacks,
  removeDecoderPack,
  setDecoderPackEnabled,
  subscribeDecoderPacks,
  type StoredDecoderPack,
} from "./store.ts";
import "./settings.scss";

type Preview = { documentJson: string; pack: DecoderPack };

const exampleDocument = {
  format: 1,
  id: "example-vault",
  version: "1",
  name: "Example vault",
  description: "Authoring example. Replace the illustrative contract and token addresses before use.",
  source: "Local authoring example; source not verified",
  deployments: [{ chainId: "11155111", address: "0x1111111111111111111111111111111111111111" }],
  functions: [{
    signature: "deposit(uint256 amount,address receiver)",
    title: "Deposit into vault",
    description: "Deposit tokens and request vault shares for the receiver.",
    value: "zero",
    fields: [
      { path: "args.0", label: "Deposit amount", format: "tokenAmount", tokenAddress: "0x2222222222222222222222222222222222222222", role: "amount" },
      { path: "args.1", label: "Share recipient", format: "address", role: "party" },
    ],
  }],
};
const exampleJson = `${JSON.stringify(exampleDocument, null, 2)}\n`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quantity(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function NetworkName({ chainId }: { chainId: string }) {
  // Names are convenience labels; the exact chain ID is always visible.
  const names: Record<string, string> = {
    "1": "Ethereum", "10": "Optimism", "56": "BNB Chain", "100": "Gnosis",
    "137": "Polygon", "8453": "Base", "42161": "Arbitrum", "43114": "Avalanche",
    "11155111": "Sepolia",
  };
  return <>{names[chainId] ? `${names[chainId]} · ` : ""}Chain {chainId}</>;
}

function PackContents({ pack }: { pack: DecoderPack }) {
  return <div className="evm-decoder-contents">
    <div>
      <h4>Networks and contracts</h4>
      <ul className="evm-decoder-targets">
        {pack.deployments.map((target) => <li key={`${target.chainId}:${target.address}`}>
          <span><NetworkName chainId={target.chainId} /></span>
          <code>{target.address}</code>
        </li>)}
      </ul>
    </div>
    <div>
      <h4>Function explanations</h4>
      <ul className="evm-decoder-functions">
        {pack.functions.map((fn) => <li key={fn.signature}>
          <strong>{fn.title}</strong>
          <code>{fn.signature}</code>
          {fn.description && <p>{fn.description}</p>}
          <p>{fn.value === "zero" ? "Applies when native value is zero." : "Accepts calls with native value."} Fields: {fn.fields.map((field) => field.label).join(", ") || "None"}.</p>
        </li>)}
      </ul>
    </div>
  </div>;
}

/** Owner-managed definitions only. Importing never calls a protocol or fetches a source URL. */
export function DecoderSettings() {
  const id = useId();
  const [records, setRecords] = useState<StoredDecoderPack[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [documentJson, setDocumentJson] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [copyingExample, setCopyingExample] = useState(false);
  const [exampleNotice, setExampleNotice] = useState<string | null>(null);
  const alive = useRef(false);
  const refreshGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const importButton = useRef<HTMLButtonElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoadError(null);
    try {
      const rows = await readDecoderPacks();
      if (!alive.current || generation !== refreshGeneration.current) return;
      setRecords(rows);
      setLoadError(null);
    } catch (error) {
      if (!alive.current || generation !== refreshGeneration.current) return;
      setLoadError(message(error));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeDecoderPacks(() => { void refresh(); });
    void refresh();
    return () => {
      alive.current = false;
      ++refreshGeneration.current;
      ++fileGeneration.current;
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  const resetImport = () => {
    ++fileGeneration.current;
    setImportOpen(false);
    setReadingFile(false);
    setDocumentJson("");
    setPreview(null);
    setImportError(null);
    importButton.current?.focus();
  };

  const reviewDocument = (raw: string) => {
    setPreview(null);
    setImportError(null);
    try {
      const pack = parseDecoderPack(JSON.parse(raw));
      setPreview({ documentJson: raw, pack });
    } catch (error) {
      setImportError(message(error));
    }
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const generation = ++fileGeneration.current;
    setReadingFile(true);
    setPreview(null);
    setImportError(null);
    try {
      const raw = await file.text();
      if (!alive.current || generation !== fileGeneration.current) return;
      setDocumentJson(raw);
      reviewDocument(raw);
    } catch (error) {
      if (alive.current && generation === fileGeneration.current) setImportError(`Could not read this file. ${message(error)}`);
    } finally {
      if (alive.current && generation === fileGeneration.current) setReadingFile(false);
    }
  };

  const mutate = async (key: string, task: () => Promise<string>) => {
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      const result = await task();
      if (!alive.current) return;
      setNotice(result);
      await refresh();
    } catch (error) {
      if (alive.current) setActionError(message(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const install = () => {
    if (!preview || busy !== null) return;
    const reviewed = preview;
    void mutate("import", async () => {
      const saved = await installDecoderPack(reviewed.documentJson);
      if (alive.current) resetImport();
      return `${saved.name} version ${saved.version} saved${saved.enabled ? " and enabled" : ""}.`;
    });
  };

  const existing = records?.find((record) => record.id === preview?.pack.id);
  const pending = busy !== null;
  const sameDocument = !!existing && existing.documentJson === preview?.documentJson;
  const savedVersion = existing && /^[1-9][0-9]*$/.test(existing.version) ? BigInt(existing.version) : null;
  const versionConflict = existing && preview && !sameDocument
    ? savedVersion === null
      ? "The saved version is unavailable. Remove this unavailable pack before importing it again."
      : BigInt(preview.pack.version) <= savedVersion
        ? `Version ${existing.version} is already saved with different JSON content. Use a higher version to replace its definitions.`
        : null
    : null;
  const alreadyEnabled = sameDocument && existing.enabled;

  const copyExample = async () => {
    setCopyingExample(true);
    setExampleNotice(null);
    try {
      await copyToClipboard(exampleJson);
      if (alive.current) setExampleNotice("Example JSON copied.");
    } catch (error) {
      if (alive.current) setExampleNotice(`Could not copy. Select the example text to copy it manually. ${message(error)}`);
    } finally {
      if (alive.current) setCopyingExample(false);
    }
  };

  return <section className="evm-decoder-settings" aria-labelledby={`${id}-title`}>
    <div className="evm-decoder-heading">
      <div>
        <h2 id={`${id}-title`}>Transaction explanations</h2>
        <p>Add decoder packs for more protocols. Wallet uses them in transaction reviews and Activity.</p>
      </div>
      <button ref={importButton} type="button" className="nt-button nt-button--secondary"
        aria-expanded={importOpen} aria-controls={`${id}-import`} disabled={pending}
        onClick={() => { if (importOpen) resetImport(); else { setImportOpen(true); setActionError(null); setNotice(null); } }}>
        {importOpen ? "Close import" : "Import decoder pack"}
      </button>
    </div>

    <p className="evm-decoder-help">Built-in explanations are included with Wallet. Imported definitions add labels; they do not verify a contract’s behavior. Wallet always keeps the destination, network, native value and raw transaction available.</p>

    {importOpen && <div className="evm-decoder-import" id={`${id}-import`}>
      <div className="evm-decoder-inputs">
        <label className="evm-decoder-file">
          <span>Choose a JSON decoder pack</span>
          <input type="file" accept=".json,application/json" disabled={pending || readingFile} onChange={(event) => { void readFile(event); }} />
        </label>
        <label className="evm-decoder-json" htmlFor={`${id}-json`}>
          Or paste its JSON
          <textarea id={`${id}-json`} className="nt-textarea" rows={5} spellCheck={false}
            value={documentJson} disabled={pending || readingFile} aria-invalid={!!importError}
            aria-describedby={importError ? `${id}-import-error` : `${id}-import-help`}
            placeholder={'{ "format": 1, "id": "my-protocol", … }'}
            onChange={(event) => {
              ++fileGeneration.current;
              setDocumentJson(event.target.value);
              setPreview(null);
              setImportError(null);
            }} />
        </label>
        <p id={`${id}-import-help`} className="evm-decoder-help">Preview the definitions before saving. A pack contains JSON data only; its source label is not fetched or verified.</p>
        {readingFile && <div className="evm-decoder-progress" role="status"><span className="nt-spinner" aria-hidden="true" />Reading decoder pack…</div>}
        {importError && <p id={`${id}-import-error`} className="evm-decoder-error" role="alert">{importError}</p>}
        <div className="evm-decoder-actions">
          <button type="button" className="nt-button nt-button--secondary" disabled={pending || readingFile || !documentJson.trim()}
            onClick={() => reviewDocument(documentJson)}>Preview pack</button>
          <button type="button" className="nt-button nt-button--ghost" disabled={pending} onClick={resetImport}>Cancel import</button>
        </div>
        <details className="evm-decoder-details">
          <summary>Author a decoder pack</summary>
          <p className="evm-decoder-help">Start with a vault deposit example, then enter the exact chain, contract, function signature and field labels for your protocol. Example addresses are illustrative. Save the edited JSON as a file to share it.</p>
          <label className="evm-decoder-json" htmlFor={`${id}-example`}>Example JSON
            <textarea id={`${id}-example`} className="nt-textarea" readOnly rows={5} value={exampleJson} spellCheck={false} />
          </label>
          <button type="button" className="nt-button nt-button--secondary" disabled={copyingExample} aria-busy={copyingExample} onClick={() => { void copyExample(); }}>
            {copyingExample && <span className="nt-spinner" aria-hidden="true" />}{copyingExample ? "Copying…" : "Copy example JSON"}
          </button>
          {exampleNotice && <p className="evm-decoder-help" role="status">{exampleNotice}</p>}
        </details>
      </div>

      {preview && <section className="evm-decoder-preview" aria-labelledby={`${id}-preview-title`}>
        <div>
          <p className="evm-decoder-eyebrow">Review import</p>
          <h3 ref={previewHeading} tabIndex={-1} id={`${id}-preview-title`}>{preview.pack.name}</h3>
          <p className="evm-decoder-help">Version {preview.pack.version} · {quantity(preview.pack.functions.length, "function")} · {quantity(preview.pack.deployments.length, "contract")}</p>
        </div>
        <p>{preview.pack.description}</p>
        <dl className="evm-decoder-metadata">
          <div><dt>Pack ID</dt><dd><code>{preview.pack.id}</code></dd></div>
          <div><dt>Source label · unverified</dt><dd>{preview.pack.source || "Not provided"}</dd></div>
        </dl>
        <PackContents pack={preview.pack} />
        {existing && !sameDocument && !versionConflict && <p className="evm-decoder-help">This replaces the saved definitions for {existing.name} version {existing.version}. Transaction history is retained.</p>}
        {sameDocument && <p className="evm-decoder-help">These exact definitions are already saved{existing.enabled ? " and enabled" : ". You can enable them again below"}.</p>}
        {versionConflict && <p className="evm-decoder-error" role="alert">{versionConflict}</p>}
        <p className="evm-decoder-caution">Names and explanations come from this imported pack. They describe how to read transaction inputs and do not establish that the contract will behave as described.</p>
        <div className="evm-decoder-actions">
          <button type="button" className="nt-button" disabled={pending || records === null || !!versionConflict || !!alreadyEnabled} aria-busy={busy === "import"} onClick={install}>
            {busy === "import" && <span className="nt-spinner" aria-hidden="true" />}
            {busy === "import" ? "Saving…" : alreadyEnabled ? "Already installed" : sameDocument ? "Enable saved pack" : existing ? "Replace decoder pack" : "Install decoder pack"}
          </button>
        </div>
      </section>}
    </div>}

    {loadError && <div className="evm-decoder-error" role="alert">
      <p>Could not load decoder packs. {loadError}</p>
      <button type="button" className="nt-button nt-button--secondary" disabled={pending} onClick={() => { void refresh(); }}>Retry</button>
    </div>}
    {records === null && !loadError && <div className="evm-decoder-progress" role="status" aria-label="Loading decoder packs"><span className="nt-spinner" aria-hidden="true" />Loading decoder packs…</div>}
    {actionError && <p className="evm-decoder-error" role="alert">{actionError}</p>}
    {notice && <p className="evm-decoder-notice" role="status">{notice}</p>}

    {records && <div className="evm-decoder-installed" aria-busy={pending}>
      <h3>Imported packs <span>{records.length}</span></h3>
      {records.length === 0 && <p className="evm-decoder-help">No imported packs yet. Built-in explanations remain available.</p>}
      {records.map((record) => <article className="evm-decoder-record" key={record.id}>
        <div className="evm-decoder-record-heading">
          <div>
            <h4>{record.name}</h4>
            <p className="evm-decoder-help">Version {record.version} · Imported definition</p>
          </div>
          <label className="evm-decoder-toggle">
            <input type="checkbox" className="nt-checkbox" checked={record.enabled}
              aria-label={`Enable ${record.name}`} disabled={pending || (!record.pack && !record.enabled)}
              onChange={(event) => {
                const enabled = event.target.checked;
                void mutate(record.id, async () => {
                  await setDecoderPackEnabled(record, enabled);
                  return `${record.name} ${enabled ? "enabled" : "disabled"}.`;
                });
              }} />
            {record.enabled ? "Enabled" : "Disabled"}
          </label>
        </div>
        {record.pack && <p className="evm-decoder-help">{quantity(record.pack.functions.length, "function")} · {quantity(record.pack.deployments.length, "contract")} · {quantity(new Set(record.pack.deployments.map((target) => target.chainId)).size, "network")}</p>}
        {record.error && <p className="evm-decoder-error">These definitions are unavailable: {record.error}</p>}
        <details className="evm-decoder-details">
          <summary>Pack details</summary>
          <dl className="evm-decoder-metadata">
            <div><dt>Pack ID</dt><dd><code>{record.id}</code></dd></div>
            <div><dt>Source label · unverified</dt><dd>{record.pack?.source || "Not provided"}</dd></div>
            <div><dt>Content SHA-256</dt><dd><code>{record.sha256}</code></dd></div>
          </dl>
          {record.pack?.description && <p className="evm-decoder-help">{record.pack.description}</p>}
          {record.pack && <PackContents pack={record.pack} />}
        </details>
        <div className="evm-decoder-record-footer">
          <p className="evm-decoder-help">Removing a pack keeps your transaction history.</p>
          <button type="button" className="nt-button nt-button--ghost" disabled={pending}
            aria-label={`Remove ${record.name}`} onClick={() => {
              void mutate(record.id, async () => {
                await removeDecoderPack(record.id);
                return `${record.name} removed. Transaction history is retained.`;
              });
            }}>Remove</button>
        </div>
      </article>)}
    </div>}
  </section>;
}
