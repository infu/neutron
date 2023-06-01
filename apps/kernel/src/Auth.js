import React, { useEffect, useState } from "react";
import { useSelector, useDispatch } from "react-redux";
import { login, logout } from "./reducer/auth";
import { exec, expose } from "neutron-tools";

export function Auth() {
  let dispatch = useDispatch();
  let { logged, principal, loading } = useSelector((state) => state.auth);

  useEffect(() => {
    const timer = setTimeout(() => {
      dispatch(login({ openAuth: false }));
    }, 500);
    return () => clearTimeout(timer);
  }, []);
  return loading ? (
    <div className="auth-loading">
      <div className="center-box">Loading...</div>
    </div>
  ) : (
    <div className="auth-loaded">
      {!logged ? (
        <div className="center-box">
          <div>Neutron v1.0</div>
          <div className="btn" onClick={() => dispatch(login())}>
            Authenticate
          </div>
        </div>
      ) : (
        <div className="center-box">
          Logged in as
          <div>{principal}</div>
          <div className="btn" onClick={() => dispatch(logout())}>
            Logout
          </div>
        </div>
      )}
    </div>
  );
}
