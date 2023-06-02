import { configureStore } from "@reduxjs/toolkit";
import auth from "./reducer/auth";
import request from "./reducer/request";
import apps from "./reducer/apps";

export const store = configureStore({
  reducer: { auth, request, apps },
});
