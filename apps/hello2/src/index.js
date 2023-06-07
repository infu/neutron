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
      <h1>This is a Neutron application Hello 2</h1>
      <div>
        <button
          onClick={() => {
            exec("call_dialog", {
              canister: neutron_id,
              method: "use_hello_world",
              args: null,
            })
              .then((x) => setResult(JSON.stringify(toState(x))))
              .catch((err) =>
                setResult(
                  "Error: " + JSON.stringify(toState(err?.toString() || err))
                )
              );
          }}
        >
          Call Use Hello, that uses local function shared by hello
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
