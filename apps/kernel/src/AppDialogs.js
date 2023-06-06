import { appApprove, appReject } from "./reducer/apps";
import { useDispatch, useSelector } from "react-redux";
import { IoCheckmarkSharp } from "react-icons/io5";

export function AppDialogs() {
  return (
    <>
      <AppRequest />
      <AppInstall />
    </>
  );
}

export function AppInstall() {
  const inst = useSelector((state) => state.apps.installing);
  const dispatch = useDispatch();

  if (!inst) return null;
  const step = inst.step;

  let steps = [];
  if (inst.step == 1) steps.push();
  if (inst.step == 2)
    steps.push(
      <>
        <div className="loader" />
        <div>Uploading files</div>
      </>
    );

  return (
    <>
      <div className="backdrop"></div>
      <div className="dialog">
        <div className="title">Installing</div>
        <div className="install-progress">
          {step >= 1 && (
            <>
              {step === 1 ? <div className="loader" /> : <IoCheckmarkSharp />}
              <div>Uploading files</div>
            </>
          )}
          {step >= 2 && (
            <>
              {step === 2 ? <div className="loader" /> : <IoCheckmarkSharp />}
              <div>Installing wasm</div>
            </>
          )}
          {step >= 3 && (
            <>
              <IoCheckmarkSharp />
              <div className="success">Installation complete</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function AppRequest() {
  const rq = useSelector((state) => state.apps.request);
  const compiled = useSelector((state) => state.apps.compiled);

  const dispatch = useDispatch();
  if (!rq) return null;
  return (
    <>
      <div className="backdrop" onClick={() => dispatch(appReject())}></div>
      <div className="dialog">
        <div className="title">Install application</div>

        <div className="call">
          <div>
            App id: <b>{rq.id}</b>
          </div>
          <div style={{ paddingBottom: "16px" }}>
            Package size: <b>{rq.size} kb</b>
          </div>
          {rq.permissions.length ? (
            <div>
              <div style={{ paddingBottom: "4px" }}>
                This application is requesting access to:
              </div>
              {rq.permissions.map((p, idx) => (
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
          {compiled ? (
            <div className="compile-done">
              Successfully compiled. Wasm size: {compiled.size} kb
            </div>
          ) : (
            <div className="compile-loading">
              <div className="loader" />
              <div>Compiling...</div>
            </div>
          )}
          <div className="btn-actions">
            <div
              className={"btn " + (compiled ? "" : "disabled")}
              onClick={() => dispatch(appApprove())}
            >
              Accept
            </div>
            <div className="btn btn-sec" onClick={() => dispatch(appReject())}>
              Reject
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
