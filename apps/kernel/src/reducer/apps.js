import { createSlice } from "@reduxjs/toolkit";
import { get_app_details } from "../tools/app.js";
import { pickFile, readFile } from "../tools/file_picker.js";
import { getNeutronCan } from "./auth.js";
import { upload_files } from "../tools/install.js";
import { configPermissions } from "../lib/perm.js";
import { collect } from "../tools/collect_modules.js";
import { compile } from "neutron-compiler/src/compile.js";

const initialState = {
  list: {},
  request: null,
  compiled: null,
  installing: null,
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
      const { id, size, permissions } = action.payload;
      state.compiled = null;
      state.request = { id, size, permissions };
    },
    setCompiled: (state, action) => {
      state.compiled = action.payload;
    },
    setAppApprove: (state) => {
      state.request = null;
    },
    setAppReject: (state) => {
      state.request = null;
    },
    setInstalling: (state, action) => {
      state.installing = action.payload;
    },
    setInstalled: (state) => {
      state.compiled = null;
      state.installing = null;
    },
  },
});

let callbacks = {};

const {
  setApps,
  addAppRequest,
  setAppApprove,
  setAppReject,
  setInstalling,
  setInstalled,
  setCompiled,
} = appSlice.actions;

export const appRequest = (req) => (dispatch) => {
  dispatch(addAppRequest({ ...req }));
  return new Promise((resolve, reject) => {
    callbacks = { resolve, reject };
  });
};

export const appApprove = () => (dispatch) => {
  callbacks.resolve();

  callbacks = {};
  dispatch(setAppApprove());
};

export const appReject = () => (dispatch) => {
  callbacks.reject(new Error("User rejected"));

  callbacks = {};
  dispatch(setAppReject());
};

export const getApps = () => async (dispatch) => {
  // const neutron = await getNeutronCan();
  // let applist = await neutron.kernel_app_list();
  try {
    let apps = await fetch("/system/apps.json").then((x) => x.json());

    dispatch(setApps(apps));
  } catch (e) {
    // no apps installed yet
  }
};

let compile_details = {};

export const compile_app =
  ({ files, neutronConfig }) =>
  async (dispatch, getState) => {
    // collect all mo modules
    let mo_lib = await collect();

    // get all app configs
    const apps = getState().apps.list;

    const configs = Object.assign(
      {},
      ...(await Promise.all(
        ["kernel", ...Object.keys(apps)].map((id) =>
          fetch(
            id === "kernel"
              ? "/pkg/neutron.json"
              : "/app/" + id + "/pkg/neutron.json"
          ).then(async (x) => ({
            [id]: await x.json(),
          }))
        )
      ))
    );
    // Add new config
    configs[neutronConfig.id] = neutronConfig;

    const mofiles = [];
    // Add new files to library
    for (let { path, content } of files) {
      // if path doesn't start with "mo/" then ignore
      if (path.indexOf("mo/") !== 0) continue;

      let contentText = new TextDecoder().decode(content);
      const p = path.replace("mo/", "");
      // mo.write(p, contentText);
      mofiles.push({ path: p, content: contentText });
    }

    console.log(configs);

    // assemble new neutron entrypoint
    // let neutron_mo = assemble(configs);
    // console.log(neutron_mo);
    // mo.write("neutron.mo", neutron_mo);

    // load libraries
    for (let { path, content } of mo_lib) {
      const p = path.replace("/mo/", "");
      mofiles.push({ path: p, content });
      // mo.write(p, content);
    }

    // compile
    // compile_details = mo.wasm("neutron.mo", "ic");
    compile_details = compile({ mofiles, configs });
    // dlFileDebug(compile_details.wasm);
    console.log("WASM", compile_details);

    // check currently installed app
    const danger = compile_details.danger[neutronConfig.id];

    console.log(neutronConfig.id, danger); //TODO: show in UI

    dispatch(
      setCompiled({ size: Math.ceil(compile_details.wasm.length / 1024) })
    );
  };

export const install_app = () => async (dispatch, getState) => {
  const neutron = await getNeutronCan();

  let pkgFile = await pickFile();
  let pkg = new Uint8Array(await readFile(pkgFile));
  let { files, neutronConfig } = await get_app_details(neutron, pkg);

  const size = Math.ceil(pkg.length / 1024);

  let permissions = configPermissions(neutronConfig);
  const id = neutronConfig.id;

  dispatch(compile_app({ files, neutronConfig }));

  await dispatch(appRequest({ id, size, permissions }));
  dispatch(setInstalling({ step: 1 }));
  let apps = getState().apps.list;

  const appconfig = {
    ...apps,
    [id]:
      id === "kernel"
        ? { link: "/", name: neutronConfig.name, icon: "/static/icon.png" }
        : {
            link: "/" + id,
            name: neutronConfig.name,
            icon: "/app/" + id + "/static/icon.png",
          },
  };
  console.log(appconfig);

  await neutron.kernel_static({
    store: {
      key: "/system/apps.json",
      val: {
        content: new TextEncoder().encode(JSON.stringify(appconfig)),
        content_type: "application/json",
        content_encoding: "identity",
      },
    },
  });

  await upload_files(neutron, files);

  await dispatch(getApps());

  // change candid
  await neutron.kernel_static({
    store: {
      key: "/pkg/neutron.did",
      val: {
        content: new TextEncoder().encode(compile_details.candid),
        content_type: "text/plain",
        content_encoding: "identity",
      },
    },
  });
  dispatch(setInstalling({ step: 2 }));
  // install wasm (Note: this will return right away because inside the management canister call is a one-shot call. It can't be otherwise)
  // Note this wasm doesn't have the new metadata with candid inside

  console.log("Installing wasm", compile_details);

  let result = await neutron.kernel_install_code({
    wasm: compile_details.wasm,
    candid: compile_details.candid,
  });

  console.log(result);

  dispatch(setInstalling({ step: 3 }));
  await delay(500);
  dispatch(setInstalled());
  window.location.hash = "#" + appconfig[id].link;
};

// function dlFileDebug(data) {
//   var blob = new Blob([data], { type: "octet/stream" });
//   var url = window.URL.createObjectURL(blob);
//   window.location.assign(url);
// }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default appSlice.reducer;
