import { useEffect } from "react";
import { UnauthorizedSession } from "./UnauthorizedSession.tsx";
import { login, logout, useAuthStore } from "./reducer/auth.ts";

export function Auth() {
  const { logged, authorized, principal, loading, authError } = useAuthStore();

  useEffect(() => {
    const timer = setTimeout(() => {
      void login({ openAuth: false });
    }, 500);
    return () => clearTimeout(timer);
  }, []);
  if (loading) {
    return (
      <div className="auth-loading">
        <div className="center-box">Loading...</div>
      </div>
    );
  }

  if (logged) {
    return (
      <>
        {!authorized ? (
          <UnauthorizedSession
            authError={authError}
            onLogout={() => void logout()}
            principal={principal}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="auth-loaded">
      <div className="center-box">
        <div className="auth-brand">
          <span>Neutron</span>
          <span className="auth-version">
            v{process.env.NEUTRON_VERSION ?? "0.1.0"}
          </span>
        </div>
        <button
          type="button"
          className="btn"
          data-tid="login-button"
          onClick={() => void login()}
        >
          Authenticate
        </button>
      </div>
    </div>
  );
}
