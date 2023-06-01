To create whitelist.json

```
npm install
mops init
node install_all_base_libraries.js
node whitelist.js
```

To see what security warnings a file will have

```
node dump.js path/to/file.mo
```

To check how the AST rules work on ./allowed/_ and ./disallowed/_

```
node check.js
```
