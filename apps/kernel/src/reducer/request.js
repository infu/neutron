import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  calls: {},
};

export const requestSlice = createSlice({
  name: "request",
  initialState,
  reducers: {
    addCallRequest: (state, action) => {
      const { canister, method, args, cid } = action.payload;
      state.calls[cid] = { canister, method, args, cid };
    },
    setCallApprove: (state, action) => {
      const { cid } = action.payload;
      delete state.calls[cid];
    },
    setCallReject: (state, action) => {
      const { cid } = action.payload;
      delete state.calls[cid];
    },
  },
});

const { addCallRequest, setCallApprove, setCallReject } = requestSlice.actions;

let callbacks = {};
let cidIncr = 0;

export const callRequest = (req) => (dispatch, getState) => {
  cidIncr++;
  const cid = cidIncr;
  dispatch(addCallRequest({ ...req, cid }));
  return new Promise((resolve, reject) => {
    callbacks[cid] = { resolve, reject };
  });
};

export const callApprove =
  ({ cid }) =>
  (dispatch, getState) => {
    callbacks[cid].resolve();

    delete callbacks[cid];
    dispatch(setCallApprove({ cid }));
  };

export const callReject =
  ({ cid }) =>
  (dispatch, getState) => {
    callbacks[cid].reject(new Error("User rejected"));

    delete callbacks[cid];
    dispatch(setCallReject({ cid }));
  };

export default requestSlice.reducer;
