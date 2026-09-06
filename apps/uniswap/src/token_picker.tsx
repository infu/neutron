import { useEffect, useRef, useState } from "react";
import { evmTokenIcon, evmTokenInitials } from "neutron-tools/src/evm_token_icons.js";
import type { Token } from "./swap.ts";
const keyOf = (token: Token) => token.address?.toLowerCase() ?? "native";

export function TokenIcon({ token }: { token: Token }) {
  const source = evmTokenIcon(token.chainId, token.address);
  return source ? <img className="uni-token-icon" src={source} alt=""/> : <span className="uni-token-icon uni-token-initials" aria-hidden="true">{evmTokenInitials(token.symbol)}</span>;
}

export function TokenPicker({ label, tokens, value, disabled, onChange }: { label: string; tokens: Token[]; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const selected = tokens.find((token) => keyOf(token) === value)!;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const query = search.toLowerCase().trim();
  const matches = tokens.filter((token) => `${token.symbol} ${token.name ?? ""} ${token.address ?? "native ethereum"}`.toLowerCase().includes(query));
  return <div className="uni-token-picker" ref={root}>
    <button ref={trigger} type="button" className="uni-token-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={`Choose ${label.toLowerCase()}`} disabled={disabled} onClick={() => { setSearch(""); setOpen((value) => !value); }}><TokenIcon token={selected}/><span>{selected.symbol}</span><span className="uni-chevron" aria-hidden="true">⌄</span></button>
    {open && <div className="uni-token-menu" role="dialog" aria-label={`Choose ${label.toLowerCase()}`}>
      <div className="uni-picker-header"><strong>Select a token</strong><button className="uni-icon-button" title="Close token list" aria-label="Close token list" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></div>
      <input autoFocus aria-label={`${label} search`} placeholder="Search name or address" value={search} onChange={(event) => setSearch(event.target.value)}/>
      <div className="uni-token-options">{matches.map((token) => <button type="button" key={keyOf(token)} className="uni-token-option" aria-label={`Select ${token.symbol}`} aria-pressed={value === keyOf(token)} title={token.address ?? "Native ETH"} onClick={() => { onChange(keyOf(token)); setOpen(false); trigger.current?.focus(); }}><TokenIcon token={token}/><span><strong>{token.symbol}</strong><small>{token.name ?? (token.address ? `${token.address.slice(0, 6)}…${token.address.slice(-4)}` : "Ethereum")}</small></span>{value === keyOf(token) && <span className="uni-token-check" aria-hidden="true">✓</span>}</button>)}{matches.length === 0 && <p className="uni-muted uni-picker-empty">No matching tokens. Add a contract in swap settings.</p>}</div>
    </div>}
  </div>;
}
