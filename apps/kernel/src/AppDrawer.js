import React, { useState } from "react";
import { useSelector, useDispatch } from "react-redux";
import { IoMdApps } from "react-icons/io";
import { getApps } from "./reducer/apps.js";

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
        <IoMdApps />
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
                  <img src={x.icon} />
                  <div>{x.name}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}
