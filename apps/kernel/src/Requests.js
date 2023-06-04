import { toState } from "@infu/icblast";
import { callApprove, callReject } from "./reducer/request";
import { useDispatch, useSelector } from "react-redux";

// The source & maintenance of this list has to be figured out
const canisters = {
  "zfcdd-tqaaa-aaaaq-aaaga-cai": "SNS-1 Ledger",
  "zqfso-syaaa-aaaaq-aaafq-cai": "SNS-1 Governance",
  "2ouva-viaaa-aaaaq-aaamq-cai": "Open Chat Ledger",
  "2jvtu-yqaaa-aaaaq-aaama-cai": "Open Chat Governance",
  "ryjl3-tyaaa-aaaaa-aaaba-cai": "ICP Ledger",
  "r7inp-6aaaa-aaaaa-aaabq-cai": "ICP Ledger",
  "rrkah-fqaaa-aaaaa-aaaaq-cai": "NNS Governance",
  "utozz-siaaa-aaaam-qaaxq-cai": "WICP",
  "aanaa-xaaaa-aaaah-aaeiq-cai": "XTC",
};

function ToAddress({ address }) {
  const name = canisters[address] || null;
  return (
    <>
      <div className="label">Destination</div>
      {name ? (
        <div className="val name">{name}</div>
      ) : (
        <div className="val principal">{address}</div>
      )}
    </>
  );
}

export function Requests() {
  const calls = useSelector((state) => state.request.calls);
  const dispatch = useDispatch();
  const empty = Object.keys(calls).length === 0;
  const cid = Object.keys(calls)[0];

  if (empty) return null;
  const call_args = toState(calls[cid].args);

  return (
    <>
      <div
        className="backdrop"
        onClick={() => dispatch(callReject({ cid }))}
      ></div>
      <div className="dialog">
        <div className="title">Signature Request</div>

        {
          <div key={cid} className="call">
            <div className="a-infogrid">
              <ToAddress address={calls[cid].canister} />

              <div className="label">Operation</div>
              <div className="val">{calls[cid].method}</div>
            </div>
            <div className="a-args">
              <Args args={call_args} />
            </div>
            <div className="btn-actions">
              <div
                className="btn"
                onClick={() => dispatch(callApprove({ cid }))}
              >
                Approve
              </div>
              <div
                className="btn btn-sec"
                onClick={() => dispatch(callReject({ cid }))}
              >
                Reject
              </div>
            </div>
          </div>
        }
      </div>
    </>
  );
}

function Args({ label = null, args }) {
  if (args === null) return <div>null</div>;
  if (args === undefined) return <div>undefined</div>;

  let nval = null;
  if (typeof args === "object") {
    if (Array.isArray(args)) {
      nval = (
        <div className="a-arr">
          {args.map((arg, idx) => (
            <Args key={idx} args={arg} />
          ))}
        </div>
      );
    } else {
      nval = (
        <div className="a-obj">
          {Object.keys(args).map((key, idx) => (
            <Args key={idx} label={key} args={args[key]} />
          ))}
        </div>
      );
    }
  }

  return label ? (
    <>
      <div className="a-label">{label}</div>
      <div className="a-val">{nval || args}</div>
    </>
  ) : (
    <div className="a-val">{nval || args}</div>
  );
}
