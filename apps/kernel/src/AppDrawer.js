import React, { useState } from "react";
import { useSelector } from "react-redux";
import { IoMdApps } from "react-icons/io";

export function AppDrawer({ apps }) {
  let { logged, loading } = useSelector((state) => state.auth);

  const [open, setOpen] = useState(false);

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
            {apps.map((x, idx) => (
              <div
                key={idx}
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
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
