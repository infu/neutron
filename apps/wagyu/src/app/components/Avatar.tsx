import { useEffect, useState } from "react";
import { IoCopyOutline } from "react-icons/io5";
import { copyToClipboard } from "neutron-tools/app";
import {
  avatarHue,
  generatedAvatarText,
  shortenNodeId,
} from "../presentation.ts";

export function Avatar({
  nodeId,
  imageUrl,
  size = "md",
  label,
}: {
  nodeId: string;
  imageUrl: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  const fallback = generatedAvatarText(nodeId);
  return (
    <span
      aria-label={label ?? `Generated avatar for ${shortenNodeId(nodeId)}`}
      className={`wg-avatar wg-avatar--${size}`}
      style={{ "--wg-avatar-hue": avatarHue(nodeId) } as React.CSSProperties}
    >
      {imageUrl && !failed ? (
        <img
          alt=""
          decoding="async"
          onError={() => setFailed(true)}
          src={imageUrl}
        />
      ) : (
        <span aria-hidden="true">{fallback}</span>
      )}
    </span>
  );
}

export function NodeIdentity({
  nodeId,
  displayName,
  avatarUrl,
  size = "md",
  secondary,
  idPrefix,
  showAvatar = true,
  copyable = true,
  onOpenProfile,
}: {
  nodeId: string;
  displayName: string | null;
  avatarUrl: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  secondary?: React.ReactNode;
  idPrefix?: string;
  showAvatar?: boolean;
  copyable?: boolean;
  onOpenProfile?: (() => void) | undefined;
}) {
  const identityContent = (
    <>
      {showAvatar ? (
        <Avatar
          imageUrl={avatarUrl}
          nodeId={nodeId}
          size={size}
          {...(displayName ? { label: `${displayName}'s avatar` } : {})}
        />
      ) : null}
      <div className="wg-identity__copy">
        {displayName ? <strong>{displayName}</strong> : null}
        <span className="wg-node-id" title={nodeId}>
          {idPrefix ? `${idPrefix} ` : ""}
          {shortenNodeId(nodeId)}
        </span>
        {secondary ? <span className="wg-identity__secondary">{secondary}</span> : null}
      </div>
    </>
  );
  return (
    <div className="wg-identity">
      {onOpenProfile ? (
        <button
          aria-label={`Open profile for ${displayName || shortenNodeId(nodeId)}`}
          className={`wg-identity__profile${showAvatar ? "" : " is-avatarless"}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenProfile();
          }}
          type="button"
        >
          {identityContent}
        </button>
      ) : identityContent}
      {copyable ? <CopyIdButton nodeId={nodeId} /> : null}
    </div>
  );
}

export function CopyIdButton({
  nodeId,
  className = "wg-copy-button",
}: {
  nodeId: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyToClipboard(nodeId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <button
      aria-label={`Copy user ID ${nodeId}`}
      className={className}
      onClick={() => void copy()}
      title={copied ? "Copied" : "Copy user ID"}
      type="button"
    >
      <IoCopyOutline aria-hidden="true" />
      <span aria-live="polite" className="wg-copy-button__label">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
