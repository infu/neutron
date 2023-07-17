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
- ~~Multi-chunk assets~~
- ~~Certified assets~~
- ~~BTree assets, not Hashmap. Searching for files in a directory will be faster~~
- ~~n/a Canister-derived identity (?probably not needed)~~
- ~~n/a Controllers - The canister itself and its derived identity too. This may result in bricking your canister, but that can be solved by storing the derived identity for longer inside browser memory.~~
- ~~Neutron dispenser~~
- Neutron dispensers in multiple subnets, so we can cover the whole IC
- Allow apps to have private memory no other app can overtake without a signature
- Allow canisters (DAOs) to sign Neutron app packages. Neutron should be able to verify authenticity
- Disable browsers that don't support the security features used.
- Doublecheck the security of postMessage between apps
- ~~n/a Neutron recovery phrase (stored inside immutable canister)~~
- Neutron recovery UI
- UI for uninstalling apps
- Apps using shared functions or another app memory have to specify version requirements
- Tests in each package
  ...
