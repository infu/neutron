{
  description = "Neutron local development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          qualification-wasmtime = pkgs.wasmtime;
        });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          linuxPackages = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.chromium
          ];

          # Mops is distributed through npm rather than nixpkgs. Expose a
          # mops command inside the development shell so CI and local
          # development use the same toolchain entry point.
          mops = pkgs.writeShellScriptBin "mops" ''
            exec ${pkgs.nodejs_24}/bin/npx --yes --package ic-mops mops "$@"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs_24
              pkgs.git
              pkgs.curl
              pkgs.bitcoin
              pkgs.wasmtime
              mops
            ] ++ linuxPackages;

            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

            shellHook = ''
              if command -v chromium >/dev/null 2>&1; then
                export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v chromium)"
              fi
              export PLAYWRIGHT_CHROMIUM_ARGS="''${PLAYWRIGHT_CHROMIUM_ARGS:---js-flags=--stack-size=16384}"
              echo "Neutron dev shell"
              echo "  bun: $(bun --version 2>/dev/null || echo missing)"
              echo "  node: $(node --version 2>/dev/null || echo missing)"
              echo "  playwright chromium: ''${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-not configured}"
              echo "  playwright chromium args: ''${PLAYWRIGHT_CHROMIUM_ARGS:-none}"
              echo "Run local browser smoke: npm run test:e2e:local"
            '';
          };
        });
    };
}
