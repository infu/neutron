import { configureStore } from "@reduxjs/toolkit";
import auth from "./reducer/auth";
import request from "./reducer/request";

export const store = configureStore({
  reducer: { auth, request },
});
