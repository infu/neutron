The Neutron Kernel is an app like any other except its dist/web mounts to / so when you open your Neutron in a browser, you open the Kernel web frontend.

The kernel is including all other apps in iframes.

It handles app installation.

It assembles all Motoko files and compiles them.

It opens dialogs in which users can allow or deny certain things like an app frontend requesting a call to be signed and allowed.

Stores all assets and serves them thru http

## Install

0. Install Internet Identity `dfx start --clean` and `dfx nns install`

1. Go to each /package/_ and /apps/_ folder and run `npm i`

2. Go to /app/hello and /app/hello2 and run `npm run package`

3. Upgrades need to go thru another canister. It will handle a tasks such as recovery, upgrades, verification, starting and stopping. The canister is located at support/upgrader and once deployed its id needs to be placed inside backend/main.mo (search for UPGRADER)

4. Deploy initial neutron

```
npm install
dfx deploy
npm run build:boot
```

5. Open in browser (replace with your canister id)

http://be2us-64aaa-aaaaa-qaabq-cai.localhost:8080/

6. Check what your principal is after logging in with Internet Identity and authorize it

```
dfx canister call neutron kernel_authorized_add '(principal "np5fy-hbsbu-5pe7m-wbbyl-5r2ti-il7pz-om6sl-hmyne-jkxn6-c4o3m-wqe")'
```

7. Make Neutron a controller

```
dfx canister update-settings --add-controller `dfx canister id neutron` neutron
```
