set shell := ["bash", "-cu"]
set quiet

verify:
  @nix run .#verify

run:
  @nix run .#pi
