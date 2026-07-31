import { CopyButton } from "./settings/CopyButton.tsx";

export function UnauthorizedSession({
  authError,
  onLogout,
  principal,
}: {
  authError: string | null;
  onLogout: () => void;
  principal: string;
}) {
  return (
    <div className="auth-unauthorized">
      <main className="auth-error" data-tid="auth-error">
        <h1 className="auth-error-title">Not authorized</h1>
        <p className="auth-error-message">
          {authError ??
            "This principal is not authorized for this Neutron canister."}
        </p>

        <div className="auth-principal">
          <span className="auth-principal-label">Current principal</span>
          <div className="auth-principal-value">
            <code data-tid="principal" title={principal}>
              {principal}
            </code>
            <CopyButton
              className="auth-principal-copy"
              label="Copy current principal"
              value={principal}
            />
          </div>
        </div>

        <p className="auth-principal-help">
          Copy this principal and add it to this Neutron&apos;s authorized
          principals.
        </p>
        <button
          className="btn btn-sec"
          data-tid="logout-button"
          onClick={onLogout}
          type="button"
        >
          Logout
        </button>
      </main>
    </div>
  );
}
