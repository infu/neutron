Whitelist data lives in `packages/neutron-scripts/whitelist.ts` and
`packages/neutron-compiler/whitelist.ts`. Only the pinned Motoko Core
`Principal` and `Runtime` facades may be reviewed exceptions. `Random` is
intentionally excluded because apps must request the kernel randomness
capability. To refresh the list using the kernel's pinned Core checkout, run:

```
bun packages/neutron-scripts/whitelist_create.ts apps/kernel
```

To see what security warnings a file will have

```
bun dump.ts path/to/file.mo
```

To check how the AST rules work on ./allowed/_ and ./disallowed/_

```
bun check.ts
```

To run the fixture tests:

```
bun test
```
