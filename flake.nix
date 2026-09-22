{
  description = "Claude Desktop for Linux - unofficial package with extra features";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        packages = {
          claude-desktop = pkgs.callPackage ./packaging/nix/package.nix {
            # The official .deb ships on Electron 44 (see CHANGELOG / the deb's
            # usr/lib/claude-desktop/version). nixpkgs' `electron` alias lags a
            # major behind, so pin the one the bundle was built for.
            electron = pkgs.electron_44;
            # Avoid pulling claude-code from nixpkgs — its npm tarball is
            # frequently yanked between releases, breaking the build.
            # Users can override: claude-desktop.override { claude-code = pkgs.claude-code; }
            claude-code = null;
          };
          default = self.packages.${system}.claude-desktop;
          # Alias under the new project name (claude-desktop-bin -> claude-desktop-extra
          # relaunch); both attrs resolve to the same package.
          claude-desktop-extra = self.packages.${system}.claude-desktop;
        };
      }
    );
}
