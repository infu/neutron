import { createSlice } from "@reduxjs/toolkit";
import { get_app_details } from "../tools/app.js";
import { pickFile, readFile } from "../tools/file_picker.js";
import { getNeutronCan } from "./auth.js";
import { upload_files } from "../tools/install.js";
import { config } from "../config.js";

const initialState = {
  list: {},
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
  },
});

const { setApps } = appSlice.actions;

export const getApps = () => async (dispatch, getState) => {
  // const neutron = await getNeutronCan();
  // let applist = await neutron.kernel_app_list();
  let apps = await fetch("/apps.json").then((x) => x.json());

  dispatch(setApps(apps));
};

export const install_app = () => async (dispatch, getState) => {
  const neutron = await getNeutronCan();

  let pkgFile = await pickFile();
  let pkg = new Uint8Array(await readFile(pkgFile));
  let { files, urlName, neutronConfig } = await get_app_details(neutron, pkg);

  let apps = getState().apps.list;

  const appconfig = {
    ...apps,
    [urlName]: {
      link: "/" + urlName,
      name: neutronConfig.name,
      icon: "/" + urlName + "/static/icon.png",
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
