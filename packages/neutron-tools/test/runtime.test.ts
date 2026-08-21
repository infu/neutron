import { expect, test } from "bun:test";
import {
  appFramePrefix,
  appBackgroundUrl,
  appMediaSessionUrl,
  appIndexUrl,
  appTrayUrl,
  canisterIdFromUrl,
  isDedicatedAppOrigin,
  kernelParentOriginFromAppUrl,
  localCanisterOrigin,
  localIdentityProvider,
  scopedLocalIdentityProvider,
  mediaSessionFramePrefix,
} from "../src/runtime.ts";
import { loadTileContext } from "../src/app.ts";

const canisterId = "4caro-hl777-77775-aaaba-cai";

test("media session URLs bind the exact ephemeral origin and lease query", () => {
  const nonce = "ab".repeat(32);
  expect(mediaSessionFramePrefix({ originNonce: nonce })).toBe(
    `m${nonce.slice(0, 24)}`,
  );
  expect(
    appMediaSessionUrl({
      canisterId,
      appId: "rendezvous",
      entrypoint: "media.html",
      binding: {
        installationUid: "42",
        originNonce: nonce,
        authorityEpoch: "7",
      },
      local: true,
      localHost: "http://localhost:8000",
    }),
  ).toBe(
    `http://m${nonce.slice(0, 24)}--${canisterId}.localhost:8000/app/rendezvous/media.html?app=rendezvous&role=media&installation-uid=42&resident-frame-security=media-session-v1&browser-origin-nonce=${nonce}&browser-origin-authority-epoch=7`,
  );
  expect(() => mediaSessionFramePrefix({ originNonce: "abcd" })).toThrow();
});

test("app frame URLs authenticate the matching kernel shell origin", () => {
  expect(
    kernelParentOriginFromAppUrl(
      `https://ahelloa--${canisterId}.icp0.io/app/hello/index.html`,
    ),
  ).toBe(`https://${canisterId}.icp0.io`);
  expect(
    kernelParentOriginFromAppUrl(
      `https://ahelloa--${canisterId}.raw.icp0.io/app/hello/index.html`,
    ),
  ).toBeNull();
  expect(
    kernelParentOriginFromAppUrl(
      `http://ahelloa--${canisterId}.localhost:8000/app/hello/index.html`,
    ),
  ).toBe(`http://${canisterId}.localhost:8000`);
  expect(
    kernelParentOriginFromAppUrl(
      `https://gateway.example/app/hello/index.html?canisterId=${canisterId}`,
    ),
  ).toBeNull();
  expect(kernelParentOriginFromAppUrl("data:text/html,hello")).toBeNull();
});

test("local canister URLs use canister subdomains on localhost", () => {
  expect(
    localCanisterOrigin(canisterId, "http://127.0.0.1:8000"),
  ).toBe(`http://${canisterId}.localhost:8000`);
  expect(
    appIndexUrl({
      canisterId,
      appId: "hello",
      local: true,
      localHost: "http://localhost:8000",
    })
  ).toBe(`http://ahelloa--${canisterId}.localhost:8000/app/hello/index.html`);
});

test("app iframe URLs use one stable app-specific local origin", () => {
  expect(
    appFramePrefix({ appId: "hello", tileId: "main", instanceId: "tile-1" })
  ).toBe("ahelloa");
  expect(
    appFramePrefix({
      appId: "hello_app",
    })
  ).toBe("ahello-appa");
  expect(
    appIndexUrl({
      canisterId,
      appId: "hello",
      tileId: "main",
      instanceId: "tile-1",
      workspace: 2,
      local: true,
      localHost: "http://localhost:8000",
    })
  ).toBe(
    `http://ahelloa--${canisterId}.localhost:8000/app/hello/index.html?app=hello&tile=main&instance=tile-1&workspace=2`
  );
});

test("generic local canister URLs keep proxy hosts but app frames fail closed", () => {
  expect(
    localCanisterOrigin(canisterId, "http://100.88.36.22:9000"),
  ).toBe("http://100.88.36.22:9000");
  expect(
    localCanisterOrigin(canisterId, "https://jinxos.tail8525af.ts.net"),
  ).toBe("https://jinxos.tail8525af.ts.net");
  expect(() =>
    appIndexUrl({
      canisterId,
      appId: "hello",
      local: true,
      localHost: "http://100.88.36.22:9000",
    })
  ).toThrow("Verified local app origins require");
  expect(() =>
    appIndexUrl({
      canisterId,
      appId: "hello",
      local: true,
      localHost: "http://localhost:18083",
    })
  ).toThrow("Verified local app origins require");
});

test("mainnet app URLs use verified app-prefixed origins", () => {
  expect(
    appIndexUrl({ canisterId, appId: "hello" }),
  ).toBe(`https://ahelloa--${canisterId}.icp0.io/app/hello/index.html`);
});

test("unprefixed app surfaces use the verified canister origin", () => {
  expect(
    appIndexUrl({
      canisterId,
      appId: "gemma",
      unprefixed: true,
    }),
  ).toBe(`https://${canisterId}.icp0.io/app/gemma/index.html`);
  expect(
    appIndexUrl({
      canisterId,
      appId: "gemma",
      unprefixed: true,
      local: true,
      localHost: "http://localhost:8000",
    }),
  ).toBe(`http://${canisterId}.localhost:8000/app/gemma/index.html`);
  expect(
    appTrayUrl({
      canisterId,
      appId: "gemma",
      path: "tray.html",
      instanceId: "tray-1",
      unprefixed: true,
    }),
  ).toBe(
    `https://${canisterId}.icp0.io/app/gemma/tray.html?app=gemma&role=tray&instance=tray-1`,
  );
});

test("tile iframe URLs include tile path and context query", () => {
  expect(
    appIndexUrl({
      canisterId,
      appId: "hello",
      path: "tools/index.html",
      tileId: "tools",
      instanceId: "tile-1",
      workspace: 2,
    })
  ).toBe(`https://ahelloa--${canisterId}.icp0.io/app/hello/tools/index.html?app=hello&tile=tools&instance=tile-1&workspace=2`);
});

test("background iframe URLs use a deterministic resident endpoint origin", () => {
  expect(
    appBackgroundUrl({
      canisterId,
      appId: "gemma",
      path: "service.html",
      local: true,
      localHost: "http://localhost:8000",
    })
  ).toBe(
    `http://agemmaa--${canisterId}.localhost:8000/app/gemma/service.html?app=gemma&role=background`
  );
});

test("dedicated background origins and initial-request bindings are installation scoped", () => {
  const firstNonce = "0123456789abcdef0123456789abcdef";
  const secondNonce = "fedcba9876543210fedcba9876543210";
  const residentBinding = {
    installationUid: "17",
    mode: "credentialless_ephemeral_dedicated_v1" as const,
    browserOriginAuthorityEpoch: "3",
  };
  const first = appBackgroundUrl({
    canisterId,
    appId: "gemma",
    path: "service.html",
    residentBinding: {
      ...residentBinding,
      browserOriginNonce: firstNonce,
    },
  });
  const second = appBackgroundUrl({
    canisterId,
    appId: "gemma",
    path: "service.html",
    residentBinding: {
      ...residentBinding,
      browserOriginNonce: secondNonce,
    },
  });

  expect(new URL(first).hostname).toBe(
    `p0123456789abcdef01234567--${canisterId}.icp0.io`,
  );
  expect(new URL(first).searchParams).toEqual(
    new URLSearchParams({
      app: "gemma",
      role: "background",
      "installation-uid": "17",
      "resident-frame-security":
        "credentialless_ephemeral_dedicated_v1",
      "browser-origin-nonce": firstNonce,
      "browser-origin-authority-epoch": "3",
    }),
  );
  expect(new URL(first).origin).not.toBe(new URL(second).origin);
  expect(isDedicatedAppOrigin(first, canisterId, "gemma", firstNonce)).toBe(
    true,
  );
  expect(isDedicatedAppOrigin(first, canisterId, "gemma", secondNonce)).toBe(
    false,
  );
  expect(() =>
    appBackgroundUrl({
      canisterId,
      appId: "gemma",
      path: "service.html",
      residentBinding: {
        ...residentBinding,
        browserOriginNonce: "not-a-kernel-nonce",
      },
    }),
  ).toThrow("Invalid dedicated resident background binding");
});

test("tray iframe URLs carry a distinct transient endpoint context", () => {
  expect(
    appTrayUrl({
      canisterId,
      appId: "gemma",
      path: "tray/index.html",
      instanceId: "tray-3",
      local: true,
      localHost: "http://localhost:8000",
    }),
  ).toBe(
    `http://agemmaa--${canisterId}.localhost:8000/app/gemma/tray/index.html?app=gemma&role=tray&instance=tray-3`,
  );
});

test("dedicated app origins reject same-host proxy fallbacks", () => {
  expect(
    isDedicatedAppOrigin(
      `https://agemmaa--${canisterId}.icp0.io/app/gemma/service.html`,
      canisterId,
      "gemma"
    )
  ).toBe(true);
  expect(
    isDedicatedAppOrigin(
      "http://100.88.36.22:9000/app/gemma/service.html",
      canisterId,
      "gemma"
    )
  ).toBe(false);
});

test("tile context can be read by app frontends", () => {
  expect(
    loadTileContext(
      `https://${canisterId}.icp0.io/app/hello/index.html?app=hello&tile=main&instance=abc&workspace=20`
    )
  ).toEqual({
    app: "hello",
    tile: "main",
    instance: "abc",
    workspace: 20,
  });
  expect(
    loadTileContext(
      `https://${canisterId}.icp0.io/app/hello/index.html?workspace=21`
    ).workspace
  ).toBeNull();
});

test("canister id can be read from query string or subdomain", () => {
  expect(
    canisterIdFromUrl(`http://localhost:8000/?canisterId=${canisterId}`),
  ).toBe(canisterId);
  expect(
    canisterIdFromUrl(`http://${canisterId}.localhost:8000/`),
  ).toBe(canisterId);
  expect(
    canisterIdFromUrl(
      `http://ahelloa--${canisterId}.localhost:8000/`
    )
  ).toBe(canisterId);
  expect(
    canisterIdFromUrl("http://n.localhost:9000/", canisterId),
  ).toBe(canisterId);
  expect(canisterIdFromUrl("http://n.localhost:9000/")).toBe(false);
  expect(canisterIdFromUrl("http://aaaaa-aa.localhost:8000/")).toBe(false);
});

test("local identity provider follows local gateway host and port", () => {
  expect(
    localIdentityProvider("http://127.0.0.1:8000"),
  ).toBe("http://id.ai.localhost:8000/");
});

test("local identity provider storage is scoped to one Neutron canister", () => {
  expect(
    scopedLocalIdentityProvider({
      neutronCanisterId: canisterId,
      localHost: "http://127.0.0.1:8000",
    })
  ).toBe(
    `http://ii-${canisterId}--uqzsh-gqaaa-aaaaq-qaada-cai.localhost:8000/`
  );
  expect(
    scopedLocalIdentityProvider({
      neutronCanisterId: "efadq-gl777-77774-aaaba-cai",
      localHost: "http://localhost:8000",
    })
  ).not.toBe(
    scopedLocalIdentityProvider({
      neutronCanisterId: canisterId,
      localHost: "http://localhost:8000",
    })
  );
  expect(
    scopedLocalIdentityProvider({
      neutronCanisterId: canisterId,
      localHost: "https://neutron.example.test",
    })
  ).toBe("https://id.ai.neutron.example.test/");
});
