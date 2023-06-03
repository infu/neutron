import { appApprove, appReject } from "./reducer/apps";
import { useDispatch, useSelector } from "react-redux";

export function AppRequest() {
  const rq = useSelector((state) => state.apps.requests);
  const dispatch = useDispatch();
  const empty = Object.keys(rq).length === 0;
  const cid = Object.keys(rq)[0];
  if (empty) return null;
  return (
    <>
      <div
        className="backdrop"
        onClick={() => dispatch(appReject({ cid }))}
      ></div>
      <div className="dialog">
        <div className="title">Install application</div>
        {
          <div key={cid} className="call">
            <div>
              App id: <b>{rq[cid].id}</b>
            </div>
            <div style={{ paddingBottom: "16px" }}>
              Uncompressed size: <b>{rq[cid].uploaded_size} kb</b>
            </div>
            {rq[cid].permissions.length ? (
              <div>
                <div style={{ paddingBottom: "4px" }}>
                  This application is requesting access to:
                </div>
                {rq[cid].permissions.map((p, idx) => (
                  <div key={idx} className={"perm-level-" + p.level}>
                    {p.text}
                  </div>
                ))}
              </div>
            ) : (
              <div className="perm-green">
                This application does not need any exceptional permissions.
              </div>
            )}
            <div className="btn-actions">
              <div
                className="btn"
                onClick={() => dispatch(appApprove({ cid }))}
              >
                Accept
              </div>
              <div className="btn" onClick={() => dispatch(appReject({ cid }))}>
                Reject
              </div>
            </div>
          </div>
        }
      </div>
    </>
  );
}
