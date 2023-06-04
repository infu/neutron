import { useState } from "react";
import { createRoot } from "react-dom/client";
import { exec } from "neutron-tools";
import { toState } from "@infu/icblast";

const neutron_id = "NEUTRON_ENV_CANISTER_ID";

const container = document.getElementById("root");
const root = createRoot(container);
export const App = () => {
  const [result, setResult] = useState(null);
  return (
    <div>
      <h1>This is a Neutron application</h1>
      <div>
        <button
          onClick={() => {
            exec("call_dialog", {
              canister: "zfcdd-tqaaa-aaaaq-aaaga-cai",
              method: "icrc1_transfer",
              args: {
                to: {
                  owner: neutron_id,
                },
                amount: 100_0000,
              },
            })
              .then((x) => setResult(JSON.stringify(toState(x))))
              .catch((err) =>
                setResult(
                  "Error: " + JSON.stringify(toState(err?.toString() || err))
                )
              );
          }}
        >
          Call authorized canister method
        </button>
      </div>
      <div>
        <button
          onClick={() => {
            exec("call_dialog", {
              canister: "ryjl3-tyaaa-aaaaa-aaaba-cai",
              method: "account_balance",
              args: {
                account:
                  "a00c26536f73f0add51dddd5ef3220bb1842b2783e8ba1c4dd4a2da172b1727a",
              },
            })
              .then((x) => setResult(JSON.stringify(toState(x))))
              .catch((err) => {
                console.log("ERR", err);
                return setResult(
                  "Error: " + JSON.stringify(toState(err?.toString() || err))
                );
              });
          }}
        >
          Call non-authorized canister method - dialog
        </button>
      </div>
      <div>
        <button
          onClick={() => {
            exec("call_dialog", {
              canister: neutron_id,
              method: "hello_world",
              args: { name: "John" },
            })
              .then((x) => setResult(JSON.stringify(toState(x))))
              .catch((err) => {
                console.log("ERR", err);
                return setResult(
                  "Error: " + JSON.stringify(toState(err?.toString() || err))
                );
              });
          }}
        >
          Test my own function
        </button>
      </div>
      <div> {result ? <code>{JSON.stringify(result)}</code> : null}</div>
    </div>
  );
};
root.render(<App />);

console.log("Registering...");

exec("test", { hello: "world" }).then((res) => {
  console.log("test received response", res);
});

exec("testasync", { hello: "world" }).then((res) => {
  console.log("testasync received response", res);
});

exec("testerr", { hello: "world" })
  .then((res) => {
    console.log("testerr received response", res);
  })
  .catch((err) => {
    console.log("testerr received error", err);
  });

exec("testasyncerr", { hello: "world" })
  .then((res) => {
    console.log("testasyncerr received response", res);
  })
  .catch((err) => {
    console.log("testasyncerr received error", err);
  });
