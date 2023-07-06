import { createRoot } from "react-dom/client";

import { AppDrawer } from "./AppDrawer";
import { useHash } from "react-use";

import { store } from "./store";
import { Provider } from "react-redux";
import { Test } from "./Test";
import { Auth } from "./Auth";
import { Requests } from "./Requests";
import { AppDialogs } from "./AppDialogs";

import { install_app } from "./reducer/apps.js";
import { neutron_id } from "./config.js";

import "./expose";
import "./style.scss";

const container = document.getElementById("root");
const root = createRoot(container);

const App = () => {
  const [hash] = useHash();
  const app = hash.length ? hash.replace("#/", "") : false;

  return (
    <Provider store={store}>
      {/* <div onClick={() => login()}>Login</div> */}
      <Test />
      <Auth />
      <Requests />
      <AppDialogs />

      <AppDrawer />
      {app ? (
        <iframe
          className="appiframe"
          src={
            "https://" + neutron_id + ".raw.icp0.io/app/" + app + "/index.html"
          }
          /* @ts-expect-error */
          credentialless="true" /* eslint-disable-line */
        />
      ) : null}
      {/* credentialless=true makes sure apps won't be able to touch our private keys. Never remove it */}
    </Provider>
  );
};

root.render(<App />);

/* @ts-expect-error */
window.install_app = async () => {
  store.dispatch(install_app());
};
