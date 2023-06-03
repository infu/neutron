import { createSlice } from "@reduxjs/toolkit";
import { get_app_details } from "../tools/app.js";
import { pickFile, readFile } from "../tools/file_picker.js";
import { getNeutronCan } from "./auth.js";
import { upload_files } from "../tools/install.js";
import { configPermissions } from "../lib/perm.js";
const initialState = {
  list: {},
  requests: {},
};

export const appSlice = createSlice({
  name: "app",
  initialState,
  reducers: {
    setApps: (state, action) => {
      for (let app in action.payload) {
        state.list[app] = action.payload[app];
      }
    },
    addAppRequest: (state, action) => {
      const { cid, id, uploaded_size, permissions } = action.payload;
      state.requests[cid] = { id, uploaded_size, permissions };
    },
    setAppApprove: (state, action) => {
      const { cid } = action.payload;
      delete state.requests[cid];
    },
    setAppReject: (state, action) => {
      const { cid } = action.payload;
      delete state.requests[cid];
    },
  },
});

let callbacks = {};
let cidIncr = 0;

const { setApps, addAppRequest, setAppApprove, setAppReject } =
  appSlice.actions;

export const appRequest = (req) => (dispatch) => {
  cidIncr++;
  const cid = cidIncr;
  dispatch(addAppRequest({ ...req, cid }));
  return new Promise((resolve, reject) => {
    callbacks[cid] = { resolve, reject };
  });
};

export const appApprove =
  ({ cid }) =>
  (dispatch) => {
    callbacks[cid].resolve();

    delete callbacks[cid];
    dispatch(setAppApprove({ cid }));
  };

export const appReject =
  ({ cid }) =>
  (dispatch) => {
    callbacks[cid].reject(new Error("User rejected"));

    delete callbacks[cid];
    dispatch(setAppReject({ cid }));
  };

export const getApps = () => async (dispatch) => {
  // const neutron = await getNeutronCan();
  // let applist = await neutron.kernel_app_list();
  let apps = await fetch("/apps.json").then((x) => x.json());

  dispatch(setApps(apps));
};

export const install_app = () => async (dispatch, getState) => {
  const neutron = await getNeutronCan();

  let pkgFile = await pickFile();
  let pkg = new Uint8Array(await readFile(pkgFile));
  let { files, neutronConfig } = await get_app_details(neutron, pkg);

  const uploaded_size = files.reduce(
    (acc, f) => acc + Math.ceil(f.content.length / 1024),
    0
  );

  let permissions = configPermissions(neutronConfig);
  const id = neutronConfig.id;
  await dispatch(appRequest({ id, uploaded_size, permissions }));

  let apps = getState().apps.list;

  const appconfig = {
    ...apps,
    [id]: {
      link: "/" + id,
      name: neutronConfig.name,
      icon: "/" + id + "/static/icon.png",
    },
  };
  console.log(appconfig);

  await neutron.kernel_static({
    store: {
      key: "/apps.json",
      val: {
        content: new TextEncoder().encode(JSON.stringify(appconfig)),
        content_type: "application/json",
        content_encoding: "plain",
      },
    },
  });

  await upload_files(neutron, files);
};

export default appSlice.reducer;
