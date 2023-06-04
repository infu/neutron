# Neutron

Decentralized, user-customizable, user-controlled, community-driven operating system running on ICP

Running this is pretty hard right now.

We are developing the chicken and the egg at the same time.

Left to do:

- Figure memory migration
- Create a frontend function checking (using the whitelist), assembling and compiling Motoko
- Create install UI
- Make some demo apps demonstrating functionality
- Create json schema for neutron.json and scripts that validate it
- Improve app dev experience
- Documentation
- Cycles wallet, cycles sending requests
- Simple wallet app holding/transferring SNS-1 tokens
- Multi-chunk assets
- Certified assets
- Canister derived identity
- Controllers - The canister itself and its derived identity too. This may result in bricking your canister, but that can be solved by storing the derived identity for longer inside browser memory.
- Neutron dispensers in multiple subnets, so we can cover the whole IC
- Allow apps to have private memory no other app can overtake without a signature
- Allow canisters (DAOs) to sign Neutron app packages. Neutron should be able to verify authenticity
- Disable browsers that don't support the security features used.
  ...
