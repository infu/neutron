import { toState } from "@infu/icblast";
import { callApprove, callReject } from "./reducer/request";
import { useDispatch, useSelector } from "react-redux";

export function Requests() {
  const calls = useSelector((state) => state.request.calls);
  const dispatch = useDispatch();
  const empty = Object.keys(calls).length === 0;
  if (empty) return null;
  return (
    <div className="backdrop">
      <div className="requests">
        {Object.keys(calls).map((cid) => (
          <div key={cid} className="call">
            <div> {calls[cid].canister}</div>
            <div>{calls[cid].method}</div>
            <div>{JSON.stringify(toState(calls[cid].args))}</div>
            <div className="btn" onClick={() => dispatch(callApprove({ cid }))}>
              Approve
            </div>{" "}
            <div className="btn" onClick={() => dispatch(callReject({ cid }))}>
              Reject
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
