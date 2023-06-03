import { useState } from "react";
import { useSelector, useDispatch } from "react-redux";
import { TbAtom2Filled } from "react-icons/tb";
import { getApps, install_app } from "./reducer/apps.js";
import { IoIosAddCircle } from "react-icons/io";

export function AppDrawer() {
  const dispatch = useDispatch();
  const apps = useSelector((state) => state.apps.list);
  let { logged, loading } = useSelector((state) => state.auth);

  const [open, setOpen] = useState(false);

  useState(() => {
    dispatch(getApps());
  }, []);
  if (!logged || loading) return null;

  return (
    <>
      <div className="appdrawer-opener" onClick={() => setOpen(true)}>
        <TbAtom2Filled />
      </div>

      {open ? (
        <div
          className="backdrop"
          onClick={() => {
            setOpen(false);
          }}
        >
          <div className="appdrawer">
            {Object.keys(apps).map((key) => {
              let x = apps[key];
              return (
                <div
                  key={key}
                  onClick={() => {
                    window.location.href = "/#" + x.link;
                    setOpen(false);
                  }}
                  className="item"
                  style={{}}
                >
                  <img className="ico" src={x.icon} />
                  <div>{x.name}</div>
                </div>
              );
            })}
            <div
              onClick={() => {
                setOpen(false);
                dispatch(install_app());
              }}
              className="item"
              style={{}}
            >
              <div className="ico add">
                <IoIosAddCircle />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
