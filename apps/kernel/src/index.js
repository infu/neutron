import { createRoot } from "react-dom/client";

import { AppDrawer } from "./AppDrawer";
import { useHash } from "react-use";

import { store } from "./store";
import { Provider } from "react-redux";
import { Test } from "./Test";
import { Auth } from "./Auth";
import { Requests } from "./Requests";
// import { db } from "./rxdb";
import { config } from "./config.js";

import { install_app } from "./reducer/apps.js";
import "./expose";
import "./style.scss";
import "./registerSw";

const container = document.getElementById("root");
const root = createRoot(container);

const App = () => {
  const [hash, setHash] = useHash();
  const app = hash.length ? hash.replace("#/", "") : false;

  return (
    <Provider store={store}>
      {/* <div onClick={() => login()}>Login</div> */}
      <Test />
      <Auth />
      <Requests />
      <AppDrawer />
      {app ? (
        <iframe
          className="appiframe"
          src={"/" + app + "/index.html"}
          credentialless="true"
        />
      ) : null}
      {/* credentialless=true makes sure apps won't be able to touch our private keys. Never remove it */}
    </Provider>
  );
};

root.render(<App />);

window.install_app = async () => {
  store.dispatch(install_app());
};

console.log("Neutron id:", config.neutron_id);
