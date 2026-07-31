import {
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import {
  IoArrowBackOutline,
  IoCameraOutline,
  IoCloseOutline,
  IoCheckmarkCircleOutline,
  IoCreateOutline,
  IoImageOutline,
  IoPersonAddOutline,
  IoSaveOutline,
  IoTimeOutline,
} from "react-icons/io5";
import type {
  ProfileDraft,
  WagyuProfile,
} from "../model.ts";
import { WAGYU_LIMITS } from "../../protocol/constants.ts";
import {
  profileSaveIsDisabled,
  validateUtf8Field,
} from "../profile_validation.ts";
import { Avatar, NodeIdentity } from "./Avatar.tsx";

export function ProfileView({
  profile,
  saving,
  error,
  onSave,
  children,
}: {
  profile: WagyuProfile;
  saving: boolean;
  error: string | null;
  onSave: (draft: ProfileDraft) => Promise<void>;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [description, setDescription] = useState(profile.description);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [clearAvatar, setClearAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const avatarInputId = useId();
  const avatarErrorId = useId();
  const displayNameHelpId = useId();
  const displayNameErrorId = useId();
  const descriptionHelpId = useId();
  const descriptionErrorId = useId();
  const displayNameValidation = validateUtf8Field(
    displayName,
    "Display name",
    WAGYU_LIMITS.profileDisplayNameUtf8Bytes,
  );
  const descriptionValidation = validateUtf8Field(
    description,
    "Description",
    WAGYU_LIMITS.profileDescriptionUtf8Bytes,
  );
  const textError =
    displayNameValidation.error ?? descriptionValidation.error;
  const changed =
    displayName !== profile.displayName ||
    description !== profile.description ||
    avatar !== null ||
    clearAvatar;
  const saveDisabled = profileSaveIsDisabled({
    saving,
    changed,
    textError,
    avatarError,
  });

  useEffect(() => {
    setDisplayName(profile.displayName);
    setDescription(profile.description);
  }, [profile.description, profile.displayName]);

  useEffect(() => {
    if (!avatar) {
      setAvatarPreviewUrl(null);
      return;
    }
    const next = URL.createObjectURL(avatar);
    setAvatarPreviewUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [avatar]);

  const cancel = () => {
    setEditing(false);
    setDisplayName(profile.displayName);
    setDescription(profile.description);
    setAvatar(null);
    setClearAvatar(false);
    setAvatarError(null);
    setEditorError(null);
  };
  const save = () => {
    if (textError || avatarError) {
      setEditorError(
        "Fix the highlighted profile fields before saving.",
      );
      return;
    }
    setEditorError(null);
    void onSave({
        displayName,
        description,
        avatar,
        clearAvatar,
      })
      .then(() => {
        setEditing(false);
        setAvatar(null);
        setClearAvatar(false);
        setEditorError(null);
      })
      .catch(() => {
        // The parent presents the actionable error without discarding the
        // draft that the owner may want to retry.
      });
  };

  return (
    <div className="wg-profile">
      <section className="wg-profile-card">
        <div className="wg-profile-card__hero">
          <div className="wg-profile-card__avatar">
            <Avatar
              imageUrl={
                clearAvatar
                  ? null
                  : avatarPreviewUrl ?? profile.avatarUrl
              }
              nodeId={profile.nodeId}
              size="xl"
            />
            {editing ? (
              <label
                className="wg-avatar-upload"
                htmlFor={avatarInputId}
                title="Choose avatar"
              >
                <IoCameraOutline aria-hidden="true" />
                <span className="nt-sr-only">Choose avatar</span>
              </label>
            ) : null}
          </div>
          {!editing ? (
            <div className="wg-profile-card__identity">
              <div className="wg-profile-card__title">
                <h1>{profile.displayName || "Your profile"}</h1>
              </div>
              <p>{profile.description || "Add a bio."}</p>
              <NodeIdentity
                avatarUrl={null}
                displayName={null}
                nodeId={profile.nodeId}
                secondary={<span>user id</span>}
                showAvatar={false}
              />
            </div>
          ) : (
            <div className="wg-profile-editor">
              <input
                accept="image/jpeg,image/png,image/webp"
                aria-describedby={avatarError ? avatarErrorId : undefined}
                aria-invalid={Boolean(avatarError)}
                className="nt-sr-only"
                id={avatarInputId}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (!file) return;
                  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
                    setAvatarError("Avatar must be JPEG, PNG, or WebP.");
                    event.currentTarget.value = "";
                    return;
                  }
                  if (
                    file.size === 0 ||
                    file.size > WAGYU_LIMITS.profileAvatarBytes
                  ) {
                    setAvatarError("Avatar must be between 1 byte and 256 KiB.");
                    event.currentTarget.value = "";
                    return;
                  }
                  setAvatar(file);
                  setClearAvatar(false);
                  setAvatarError(null);
                  setEditorError(null);
                }}
                type="file"
              />
              <label className="nt-field">
                <span className="nt-label">Display name</span>
                <input
                  aria-describedby={`${displayNameHelpId}${
                    displayNameValidation.error
                      ? ` ${displayNameErrorId}`
                      : ""
                  }`}
                  aria-invalid={Boolean(displayNameValidation.error)}
                  className="nt-input"
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setEditorError(null);
                  }}
                  value={displayName}
                />
                <span className="nt-help" id={displayNameHelpId}>
                  {displayNameValidation.byteLength.toLocaleString()} /{" "}
                  {WAGYU_LIMITS.profileDisplayNameUtf8Bytes.toLocaleString()} UTF-8 bytes
                </span>
                {displayNameValidation.error ? (
                  <span
                    className="nt-error"
                    id={displayNameErrorId}
                    role="alert"
                  >
                    {displayNameValidation.error}
                  </span>
                ) : null}
              </label>
              <label className="nt-field">
                <span className="nt-label">Description</span>
                <textarea
                  aria-describedby={`${descriptionHelpId}${
                    descriptionValidation.error
                      ? ` ${descriptionErrorId}`
                      : ""
                  }`}
                  aria-invalid={Boolean(descriptionValidation.error)}
                  className="nt-textarea"
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setEditorError(null);
                  }}
                  rows={4}
                  value={description}
                />
                <span className="nt-help" id={descriptionHelpId}>
                  {descriptionValidation.byteLength.toLocaleString()} /{" "}
                  {WAGYU_LIMITS.profileDescriptionUtf8Bytes.toLocaleString()} UTF-8 bytes
                </span>
                {descriptionValidation.error ? (
                  <span
                    className="nt-error"
                    id={descriptionErrorId}
                    role="alert"
                  >
                    {descriptionValidation.error}
                  </span>
                ) : null}
              </label>
              <div className="wg-avatar-choice">
                <IoImageOutline aria-hidden="true" />
                <span>
                  {avatar
                    ? `${avatar.name} · ${(avatar.size / 1_024).toFixed(1)} KiB`
                    : profile.avatarUrl && !clearAvatar
                      ? "Keeping current avatar"
                      : "Generated avatar"}
                </span>
                {profile.avatarUrl || avatar ? (
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    onClick={() => {
                      setAvatar(null);
                      setClearAvatar(true);
                      setAvatarError(null);
                      setEditorError(null);
                    }}
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {avatarError ? (
                <span className="nt-error" id={avatarErrorId} role="alert">
                  {avatarError}
                </span>
              ) : null}
              {editorError ? (
                <div className="nt-alert nt-alert--danger" role="alert">
                  {editorError}
                </div>
              ) : null}
            </div>
          )}
          {!editing ? (
            <button
              aria-label="Edit profile"
              className="wg-icon-button wg-profile-card__edit"
              onClick={() => setEditing(true)}
              title="Edit profile"
              type="button"
            >
              <IoCreateOutline aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {editing ? (
          <footer className="wg-profile-card__footer">
            <div>
              <button
                className="nt-button nt-button--ghost"
                disabled={saving}
                onClick={cancel}
                type="button"
              >
                <IoCloseOutline aria-hidden="true" /> Cancel
              </button>
              <button
                className="nt-button wg-primary-button"
                disabled={saveDisabled}
                onClick={save}
                title={
                  textError || avatarError
                    ? "Fix the highlighted profile fields before saving"
                    : changed
                      ? "Save profile"
                      : "Make a change before saving"
                }
                type="button"
              >
                <IoSaveOutline aria-hidden="true" />
                {saving
                  ? "Saving…"
                  : textError || avatarError
                    ? "Fix profile fields to save"
                    : changed
                      ? "Save"
                      : "No changes to save"}
              </button>
            </div>
          </footer>
        ) : null}
      </section>
      {error ? <div className="nt-alert nt-alert--danger" role="alert">{error}</div> : null}
      {children}
    </div>
  );
}

export function UserProfileView({
  profile,
  loading,
  error,
  following,
  followBusy,
  followDisabledReason,
  followError,
  onBack,
  onFollow,
  children,
}: {
  profile: WagyuProfile;
  loading: boolean;
  error: string | null;
  following: boolean;
  followBusy: boolean;
  followDisabledReason: string | null;
  followError: string | null;
  onBack: () => void;
  onFollow: () => void;
  children?: ReactNode;
}) {
  const profileName = profile.displayName || "this user";
  const followLabel = followBusy
    ? `Following ${profileName}…`
    : following
      ? `You follow ${profileName}`
      : `Follow ${profileName}`;

  return (
    <div className="wg-profile wg-user-profile">
      <section
        aria-busy={loading}
        aria-labelledby="wg-user-profile-title"
        className="wg-profile-card"
      >
        <div className="wg-profile-card__hero">
          <div className="wg-profile-card__avatar">
            <Avatar
              imageUrl={profile.avatarUrl}
              nodeId={profile.nodeId}
              size="xl"
            />
          </div>
          <div className="wg-profile-card__identity">
            <div className="wg-profile-card__title">
              <h1 id="wg-user-profile-title">
                {profile.displayName || "Wagyu user"}
              </h1>
            </div>
            <p>
              {loading
                ? "Loading profile…"
                : profile.description || "No bio yet."}
            </p>
            <NodeIdentity
              avatarUrl={null}
              displayName={null}
              nodeId={profile.nodeId}
              secondary={<span>user id</span>}
              showAvatar={false}
            />
          </div>
          <div className="wg-user-profile__actions">
            <button
              aria-label={followLabel}
              className={`wg-icon-button wg-user-profile__follow${
                following ? " is-following" : ""
              }${followBusy ? " is-busy" : ""}`}
              disabled={
                following || followBusy || followDisabledReason !== null
              }
              onClick={onFollow}
              title={followDisabledReason ?? followLabel}
              type="button"
            >
              {followBusy ? (
                <IoTimeOutline aria-hidden="true" />
              ) : following ? (
                <IoCheckmarkCircleOutline aria-hidden="true" />
              ) : (
                <IoPersonAddOutline aria-hidden="true" />
              )}
            </button>
            <button
              aria-label="Back from user profile"
              className="nt-button nt-button--ghost wg-user-profile__back"
              onClick={onBack}
              type="button"
            >
              <IoArrowBackOutline aria-hidden="true" />
              Back
            </button>
          </div>
        </div>
      </section>
      {followError ? (
        <div className="nt-alert nt-alert--danger" role="alert">
          {followError}
        </div>
      ) : null}
      {error ? (
        <div className="nt-alert nt-alert--warning" role="status">
          The latest certified profile could not be loaded. Showing only
          presentation data already verified with local posts.
        </div>
      ) : null}
      {children}
    </div>
  );
}
