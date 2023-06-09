The Neutron Kernel is an app like any other except its dist/web mounts to / so when you open your Neutron in a browser, you open the Kernel web frontend.

The kernel is including all other apps in iframes.

It handles app installation.

It assembles all Motoko files and compiles them.

It opens dialogs in which users can allow or deny certain things like an app frontend requesting a call to be signed and allowed.

Stores all assets and serves them thru http

## Install

Note: This installation process may not work, because things constantly change.

You should first go to /app/hello and run `npm run package` the scripts that follow are trying to install its binary

Upgrades need to go thru another canister. It will handle a few tasks such as recovery, upgrades, verification, starting and stopping. The canister is located at support/upgrader and once deployed its id needs to be placed inside backend/main.mo

```
npm install
dfx deploy
npm run build:boot
```

You may need to let the canister know who is its owner. Instructions are printed by boot.js.

Open in browser (replace with your canister id)

http://r7inp-6aaaa-aaaaa-aaabq-cai.localhost:8080/

Check what your principal is after logging in and add it

```
dfx canister call neutron kernel_authorized_add '(principal "52xrw-gaued-e2icl-3r63y-bpl3w-nt4xm-jhfmr-who5g-p2jju-j4243-sqe")'
```

Make neutron controller of itself (it should be the only controller)

```
dfx canister update-settings --add-controller q4eej-kyaaa-aaaaa-aaaha-cai neutron
```
