import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import icblast, { InternetIdentity } from "@infu/icblast";
import { AccountIdentifier, SubAccount } from "@dfinity/nns";
import { Principal } from "@dfinity/principal";

const dispenser_id = "wbahd-yaaaa-aaaam-abpaq-cai";

import "./style.scss";

const container = document.getElementById("root");
const root = createRoot(container);

const App = ({ authorize }) => {
  let [account, setAccount] = useState(null);
  let [neutron_id, setNeutronId] = useState(null);
  let [working, setWorking] = useState(authorize ? "Authorizing" : false);
  let [error, setError] = useState(false);
  let [authenticated, setAuthenticated] = useState(false);

  const refreshAccount = async () => {
    let account = AccountIdentifier.fromPrincipal({
      principal: Principal.fromText(dispenser_id),
      subAccount: SubAccount.fromPrincipal(InternetIdentity.getPrincipal()),
    }).toHex();

    let ic = icblast({ identity: InternetIdentity.getIdentity() });
    let dispenser = await ic(dispenser_id);
    let canister_id = await dispenser.find();
    if (canister_id) {
      setNeutronId(canister_id.toText());
      if (authorize) {
        try {
          await dispenser.authorize(authorize);
          window.location.href = "https://" + canister_id + ".icp0.io/";
        } catch (e) {
          setWorking(false);
          setError(e.message);
        }
      }
    } else {
      setAccount(account);
    }
  };

  const login = async () => {
    if (!(await InternetIdentity.isAuthenticated()))
      await InternetIdentity.login();
    setAuthenticated(true);
    refreshAccount();
  };
  const logout = async () => {
    await InternetIdentity.logout();

    setNeutronId(null);
    setAccount(null);
    setAuthenticated(false);
    setWorking(false);
    setError(false);
    window.location.reload();
  };

  useEffect(() => {
    InternetIdentity.create().then(async () => {
      setAuthenticated(await InternetIdentity.isAuthenticated());
      refreshAccount();
    });
  }, []);

  return (
    <div className="app">
      <div className="heading">Neutron Dispenser</div>
      {neutron_id ? (
        <div className="info">
          Your neutron:{" "}
          <a
            rel="noreferrer"
            target="_blank"
            href={"https://" + neutron_id + ".icp0.io/"}
          >
            {neutron_id}
          </a>
        </div>
      ) : null}
      {!authenticated ? (
        <div className="btn" onClick={login}>
          Sign In
        </div>
      ) : (
        <>
          {!neutron_id ? (
            <div className="info">
              Send at least 0.2 ICP to this account: {account} <br />
              Everything you send is converted to cycles and sent to your
              Neutron canister
            </div>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
          {working ? <div className="info">{working}...</div> : null}

          {!working ? (
            <>
              {!neutron_id ? (
                <div
                  className="btn"
                  onClick={async () => {
                    let ic = icblast({
                      identity: InternetIdentity.getIdentity(),
                    });
                    let dispenser = await ic(dispenser_id);
                    setWorking("Installing");
                    setError(false);
                    try {
                      let canister_id = await dispenser.create();

                      await dispenser.install({ install: null });

                      await refreshAccount();
                    } catch (e) {
                      setError(e.message);
                    }
                    setWorking(false);
                  }}
                >
                  Create Your Neutron
                </div>
              ) : (
                <div
                  className="btn"
                  onClick={async () => {
                    let ic = icblast({
                      identity: InternetIdentity.getIdentity(),
                    });
                    let dispenser = await ic(dispenser_id);
                    setWorking("Reinstalling");
                    setError(false);
                    try {
                      await dispenser.install({ reinstall: null });
                    } catch (e) {
                      setError(e.message);
                    }
                    setWorking(false);
                  }}
                >
                  Reinstall Your Neutron
                </div>
              )}
            </>
          ) : null}
          {!working ? (
            <>
              <br />
              <div className="btn-inline" onClick={logout}>
                Sign Out
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
};

const urlParams = new URLSearchParams(window.location.search);
const authorize = urlParams.get("authorize");

root.render(<App authorize={authorize} />);
