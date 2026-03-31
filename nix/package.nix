{ buildGoModule, lib }:

buildGoModule {
  pname = "pi-harness";
  version = "0.0.0";
  src = ../.;
  vendorHash = null;
  subPackages = [ "./cmd/pi-harness" ];

  postInstall = ''
    ln -s "$out/bin/pi-harness" "$out/bin/ph"
  '';

  meta = {
    description = "Local workstream-first tmux and Pi harness";
    mainProgram = "pi-harness";
    platforms = lib.platforms.linux;
  };
}
