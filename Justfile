set shell := ["bash", "-cu"]
set quiet

default-model := "gpt-5.4"
default-reasoning := "medium"
default-iterations := "10"
default-prompt := "prompts/implementation/session-switcher-v1-iteration.md"

lint:
  @nix run .#lint

test:
  @nix run .#test

verify:
  @nix run .#verify

loop iterations=default-iterations model=default-model reasoning=default-reasoning:
  @ITERATIONS={{iterations}} \
  CODEX_MODEL={{model}} \
  CODEX_REASONING={{reasoning}} \
  LOOP_PROMPT={{default-prompt}} \
  ./scripts/session-switcher-local-loop.sh

loop-dry-run iterations=default-iterations model=default-model reasoning=default-reasoning prompt=default-prompt:
  @ITERATIONS={{iterations}} \
  CODEX_MODEL={{model}} \
  CODEX_REASONING={{reasoning}} \
  LOOP_PROMPT={{prompt}} \
  DRY_RUN=1 \
  ./scripts/session-switcher-local-loop.sh
