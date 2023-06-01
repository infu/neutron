let id = 0;
let callbacks = { hi: "there" };

export function exec(action, payload, timeout = 0) {
  id++;
  return new Promise((resolve, reject) => {
    // Timeout after 5 seconds
    let timeoutCallback = timeout
      ? setTimeout(() => {
          delete callbacks[id];
          reject("Timeout after " + timeout + " seconds");
        }, 1000 * timeout)
      : false;

    callbacks[id] = { resolve, reject, timeout: timeoutCallback };
    window.parent.postMessage(
      {
        type: "exec",
        id: id,
        payload: {
          action,
          payload,
        },
      },
      "*"
    );
  });
}

window.addEventListener("message", async (event) => {
  if (event.data.type === "response") {
    if (callbacks[event.data.id]) {
      if (event.data.error) {
        callbacks[event.data.id].reject(event.data.error);
      } else {
        callbacks[event.data.id].resolve(event.data.ok);
      }
      clearTimeout(callbacks[event.data.id].timeout);
      delete callbacks[event.data.id];
    }
  }

  if (event.data.type === "exec") {
    try {
      let ok = await exec_internal(
        event.data.payload.action,
        event.data.payload.payload
      );

      event.source.postMessage(
        {
          type: "response",
          id: event.data.id,
          ok,
        },
        "*"
      );
    } catch (error) {
      event.source.postMessage(
        {
          type: "response",
          id: event.data.id,
          error,
        },
        "*"
      );
    }
  }
});

let actions = {};

export function expose(name, action) {
  console.log("Exposing", name);
  actions[name] = action;
}

function exec_internal(action, payload) {
  console.log("Executing", action, payload);
  return actions[action](payload);
}
