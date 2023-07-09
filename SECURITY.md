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
