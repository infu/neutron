Simple Neutron app package.

```
cd ../..
npm install

cd apps/hello
npm test
npm run package
```

The frontend entrypoint is `src/index.tsx` and the build script is `build.ts`.
Both run through Bun/esbuild. The app imports the generic canister client from
`neutron-tools/app`, which asks the kernel for approved calls and
kernel-derived method schemas.

The backend uses managed memory under canonical manifest format 3. The
immutable schema and clean-install default live in
`backend/memory/hello/v1.mo`; `backend/main.mo` imports that `Mem` type.
Packaging records the schema's content-addressed entry in `dist/neutron.json`
and verifies the independently versioned format-2 `neutron.lock.json`.

For a future type change, add `v2.mo` and `v1_to_v2.mo`, increment
`memory.hello.version`, and append both roots to `neutron.json`. Never edit a
locked historical schema or migration closure. See
`doc/memory-migrations-and-uninstall.md` for the full workflow.
