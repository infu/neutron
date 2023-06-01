import { createSlice } from "@reduxjs/toolkit";
import icblast, { InternetIdentity } from "@infu/icblast";

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
// const ic = icblast({ local: true, local_host: 'http://localhost:8080' });
let ic = icblast({});

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
          //   identityProvider:
          //     'http://localhost:8080?canisterId=qhbym-qaaaa-aaaaa-aaafq-cai',
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
      // local: true,
      // local_host: 'http://localhost:8080',
      identity,
    });

    dispatch(setAuth({ logged, principal: identity.getPrincipal().toText() }));
  };

// const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const logout = () => (dispatch, getState) => {
  ic = icblast({});
  dispatch(setAuth({ logged: false, principal: "2vxsx-fae" }));
  InternetIdentity.logout();
};

export const getIC = () => {
  return ic;
};

export default authSlice.reducer;
