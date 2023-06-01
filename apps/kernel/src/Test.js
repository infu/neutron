import { useSelector, useDispatch } from "react-redux";
import { exec, expose } from "neutron-tools";

export function Test() {
  let dispatch = useDispatch();

  return <></>;
}

expose("test", (payload) => {
  console.log("kernel:test", payload);
  return "test response";
});

expose("testasync", async (payload) => {
  console.log("kernel:test", payload);
  return "test response";
});

expose("testerr", (payload) => {
  throw "fun";
});

expose("testasyncerr", async (payload) => {
  throw "fun";
});
