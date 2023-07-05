import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import icblast, { InternetIdentity } from "@infu/icblast";
import { AccountIdentifier, SubAccount } from "@dfinity/nns";
import { Principal } from "@dfinity/principal";

const dispenser_id = "wbahd-yaaaa-aaaam-abpaq-cai";

import "./style.scss";

const container = document.getElementById("root");
const root = createRoot(container);

const App = () => {
  let [account, setAccount] = useState(null);
  let [neutron_id, setNeutronId] = useState(null);

  let [authenticated, setAuthenticated] = useState(false);

  const refreshAccount = async () => {
    let account = AccountIdentifier.fromPrincipal({
      principal: Principal.fromText(dispenser_id),
      subAccount: SubAccount.fromPrincipal(InternetIdentity.getPrincipal()),
    }).toHex();

    let ic = icblast({ identity: InternetIdentity.getIdentity() });
    let dispenser = await ic(dispenser_id);
    let canister_id = await dispenser.find();
    setNeutronId(canister_id.toText());

    setAccount(account);
  };

  const login = async () => {
    if (!(await InternetIdentity.isAuthenticated()))
      await InternetIdentity.login();

    refreshAccount();
  };
  useEffect(() => {
    InternetIdentity.create().then(async () => {
      setAuthenticated(await InternetIdentity.isAuthenticated());
      refreshAccount();
    });
  }, []);

  return (
    <div className="app">
      <div>Neutron Dispenser</div>
      <div>
        Neutron:{" "}
        <a
          rel="noreferrer"
          target="_blank"
          href={"https://" + neutron_id + ".icp0.io/"}
        >
          {neutron_id}
        </a>
      </div>
      {!authenticated ? (
        <div className="btn" onClick={login}>
          Auth
        </div>
      ) : null}
      <div>{account}</div>
      <div
        className="btn"
        onClick={async () => {
          let ic = icblast({ identity: InternetIdentity.getIdentity() });
          let dispenser = await ic(dispenser_id);

          let canister_id = await dispenser.create();

          await dispenser.install({ install: null });
          setNeutronId(canister_id.toText());
        }}
      >
        Create Your Neutron
      </div>
      <div
        className="btn"
        onClick={async () => {
          let ic = icblast({ identity: InternetIdentity.getIdentity() });
          let dispenser = await ic(dispenser_id);

          await dispenser.install({ reinstall: null });
        }}
      >
        Reinstall Your Neutron
      </div>
    </div>
  );
};

root.render(<App />);
