# Neutron

Decentralised, user-customizable, user-controlled, community-driven operating system running on ICP

Running this is pretty hard right now.

We are developing the chicken and the egg at the same time.

Neutron Litepaper: https://ikbpf-hyaaa-aaaam-abnma-cai.icp0.io/Neutron_litepaper.pdf

## How the security works

We are scanning all 3rd party app code for various things they shouldn’t use directly.
There are two scans, one is text-based, another is AST based. (Pretty much denies creating actors and running functions that are named setCertifiedData, cyclesAdd, and so on.)
It scans all libraries an app imports including the base libraries.

One of the problems is, there are two base libraries that provide allowed functionality but trigger the security checks. These are “Principal.mo” and “Random.mo”.
So we’ve whitelisted their hashes from the last 23 Motoko base releases.

Unless there is a way for Motoko code to jailbreak that I don’t know of, I suppose this should work?

Text checks:

![image](https://github.com/infu/neutron/assets/24810/f16b4fef-257f-441b-812e-c6a67249ffdf)

AST checks:
![image](https://github.com/infu/neutron/assets/24810/16283afc-6345-448d-93e8-8b2a0edd1c74)

Developers get notified when they use prohibited code
![image](https://github.com/infu/neutron/assets/24810/4322edd9-7882-4fbe-87a8-6c973eb1696c)

These apps get assembled based on a json config. The generated actor code with all apps looks like this:
(anti-injection & collision checks are done by the generator)
![image](https://github.com/infu/neutron/assets/24810/005ceafa-e186-4b0b-adf7-6c9915bdef9d)

(Devs get working type checks going on while developing, even with multiple apps.)
Neutron.json config:
![image](https://github.com/infu/neutron/assets/24810/16546010-70be-4828-a38d-dff5679ceb64)

Apps look like this:
![image](https://github.com/infu/neutron/assets/24810/813ce5e0-af89-4729-b43a-4e3932ffab4b)

Additionally, apps get bundled like this (It’s not a good idea to include the huge .mops folders inside the frontend) All these apps share the same modules if their hashes match. (This reduced the wasm size by 5kb, I am assuming either we have a bug, or Motoko is not doing that kind of optimization when libraries import the same file (same imports included) from different folders)

![image](https://github.com/infu/neutron/assets/24810/1dca6c77-d73f-4222-be41-df519ef30ee6)

When a user tries to install an app they see a dialog with the permissions it requires:
<img width="751" alt="image" src="https://github.com/infu/neutron/assets/24810/96369968-efe3-443e-a1d1-e8b028bde0f2">

or

<img width="739" alt="image" src="https://github.com/infu/neutron/assets/24810/5daf42de-2044-43b2-9210-587a3825d924">

## Todo:

- Figure memory migration
- Create a frontend function checking (using the whitelist), assembling and compiling Motoko
- ~~Create install UI~~
- Make some demo apps demonstrating functionality
- ~~Create json schema for neutron.json and scripts that validate it~~
- Improve app dev experience
- Documentation
- Cycles wallet, cycles sending requests
- Simple wallet app holding/transferring SNS-1 tokens
- Multi-chunk assets
- Certified assets
- Canister-derived identity (?probably not needed)
- Controllers - The canister itself and its derived identity too. This may result in bricking your canister, but that can be solved by storing the derived identity for longer inside browser memory.
- Neutron dispensers in multiple subnets, so we can cover the whole IC
- Allow apps to have private memory no other app can overtake without a signature
- Allow canisters (DAOs) to sign Neutron app packages. Neutron should be able to verify authenticity
- Disable browsers that don't support the security features used.
- Doublecheck the security of postMessage between apps
- Neutron recovery phrase (stored inside immutable canister)
- Neutron recovery UI
- UI for uninstalling apps
- Apps using shared functions or another app memory have to specify version requirements
- Tests in each package
  ...

## Workarounds:

- A canister can't self-upgrade without another canister https://forum.dfinity.org/t/self-upgrading-canisters/20486

## Install

Check apps/kernel/README.md
