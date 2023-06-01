The Neutron Kernel is an app like any other except its dist/web mounts to / so when you open your Neutron in a browser, you open the Kernel web frontend.

The kernel is including all other apps in iframes.

It handles app installation.

It assembles all Motoko files and compiles them.

It opens dialogs in which users can allow or deny certain things like an app frontend requesting a call to be signed and allowed.

## Install

```
npm install
dfx deploy
npm run build:boot
```

You may need to let the canister know who is its owner. Instructions are printed by boot.js.

Open in browser (replace with your canister id)

http://r7inp-6aaaa-aaaaa-aaabq-cai.localhost:8080/
