import { createSlice } from "@reduxjs/toolkit";
import icblast, { InternetIdentity } from "@infu/icblast";
import { neutron_id } from "../config.js";

const initialState = {
  value: 0,
  logged: false,
  principal: "2vxsx-fae",
  loading: true,
};

export const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    setAuth: (state, action) => {
      const { logged, principal } = action.payload;
      state.logged = logged;
      state.principal = principal;
      state.loading = false;
    },
  },
});

// Action creators are generated for each case reducer function
export const { setAuth } = authSlice.actions;

// anon
const ICARG = process.env.LOCAL
  ? { local: true, local_host: "http://localhost:8080" }
  : {};

let ic = icblast(ICARG);

InternetIdentity.create();

// authenticated
export const login =
  ({ openAuth = true } = {}) =>
  async (dispatch, getState) => {
    if (
      !InternetIdentity.isAuthenticated() ||
      InternetIdentity.getPrincipal().toText() === "2vxsx-fae"
    ) {
      if (openAuth) {
        console.log("not authenticated");
        await InternetIdentity.login({
          ...(ICARG.local
            ? {
                identityProvider:
                  "http://qhbym-qaaaa-aaaaa-aaafq-cai.localhost:8080/",
              }
            : {}),
        });
      }
    } else {
      console.log("authenticated", InternetIdentity.getPrincipal().toText());
    }
    // await delay(1000);
    let identity = InternetIdentity.getIdentity();

    let logged = !(
      !InternetIdentity.isAuthenticated() ||
      InternetIdentity.getPrincipal().toText() === "2vxsx-fae"
    );

    ic = icblast({
      ...ICARG,
      // local: true,
      // local_host: 'http://localhost:8080',
      identity,
    });

    dispatch(setAuth({ logged, principal: identity.getPrincipal().toText() }));

    // Check if authorized
    if (!logged) return;
    let neutron = await getNeutronCan();

    let authorized = await neutron.kernel_check_authorized(null); //TODO: maybe create another function for this
    if (!authorized) {
      // unauthorized
      window.location.href =
        "https://widm7-oiaaa-aaaam-abpba-cai.icp0.io/?authorize=" +
        identity.getPrincipal().toText();
    }
  };

// const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const logout = () => (dispatch, getState) => {
  ic = icblast(ICARG);
  dispatch(setAuth({ logged: false, principal: "2vxsx-fae" }));
  InternetIdentity.logout();
};

export const getIC = () => {
  return ic;
};

let neutron_can = null;
export const getNeutronCan = async () => {
  if (neutron_can) return neutron_can;
  const candid = await fetch("/pkg/neutron.did").then((x) => x.text());

  // const { id } = await fetch("/pkg/id.json").then((x) => x.json());
  // Icblast doesn't support relative URLs right now
  neutron_can = await ic(neutron_id, candid);

  // window.neutron = neutron_can;

  console.log(neutron_can);
  return neutron_can;
};
export default authSlice.reducer;
