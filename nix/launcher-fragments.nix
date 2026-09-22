{ lib }:
{
  # Resource selection stays in profiles.json; launchers supply concrete roots.
  resourceArgs = profile: { harnessRoot, mattSkillsRoot }:
    lib.concatStringsSep "\n" (
      map (name: ''--extension "${harnessRoot}/extensions/${name}/index.ts"'')
        (builtins.filter (name: !(builtins.elem name [ "pi-r" "agentgraph" "lsp" ])) profile.extensions)
      ++ lib.concatMap (name:
        if name == "harness" then [ ''--skill "${harnessRoot}/skills"'' ]
        else if name == "matt-pocock" then [ ''--skill "${mattSkillsRoot}"'' ] else [ ]) profile.skills
      ++ lib.optional (builtins.elem "harness" profile.prompts) ''--prompt-template "${harnessRoot}/prompts"''
      ++ lib.optional (builtins.elem "harness" profile.themes) ''--theme "${harnessRoot}/themes"''
    );

  lspCleanup = ''
    if [[ -n "''${PI_HARNESS_LSP_FALLBACK_PATH:-}" ]]; then
      IFS=: read -r -a pi_path_parts <<< "''${PATH:-}"
      IFS=: read -r -a pi_lsp_parts <<< "$PI_HARNESS_LSP_FALLBACK_PATH"
      pi_clean_path=()
      for pi_path_part in "''${pi_path_parts[@]}"; do
        pi_keep_path=1
        for pi_lsp_part in "''${pi_lsp_parts[@]}"; do
          if [[ "$pi_path_part" == "$pi_lsp_part" ]]; then pi_keep_path=0; break; fi
        done
        if [[ "$pi_keep_path" == 1 ]]; then pi_clean_path+=("$pi_path_part"); fi
      done
      PATH="$(IFS=:; printf '%s' "''${pi_clean_path[*]}")"
      export PATH
    fi
    unset PI_HARNESS_LSP_ENABLED PI_HARNESS_LSP_EXTENSION PI_HARNESS_LSP_FALLBACK_PATH
  '';

  piREnvironment = piR: pi: ''
    export PI_R_RESOURCE_ROOT="${piR.resourcePaths.root}"
    export PI_R_TREE_SITTER="${piR.resourcePaths.parser}"
    export PI_R_TREE_SITTER_R="${piR.resourcePaths.parserGrammar}"
    export PI_R_TREE_SITTER_QUERY="${piR.resourcePaths.parserQuery}"
    export PI_R_RSCRIPT="${piR.resourcePaths.rscript}"
    export PI_R_BASE_RSCRIPT="${piR.resourcePaths.rscript}"
    export PI_R_FORMATTER_SCRIPT="${piR.resourcePaths.formatter}"
    export PI_R_CONTRACT_READER="${piR.resourcePaths.contractReader}"
    export PI_R_BWRAP="${piR.resourcePaths.sandbox}"
    export PI_R_WORKER_RSCRIPT="${piR.resourcePaths.rscript}"
    export PI_R_WORKER_SCRIPT="${piR.resourcePaths.worker}"
    export PI_R_VALUE_SUMMARY_SCRIPT="${piR.resourcePaths.valueSummary}"
    export PI_R_TARGET_RUNNER_SCRIPT="${piR.resourcePaths.targetRunner}"
    export PI_R_ARTIFACT_INSPECTOR_SCRIPT="${piR.resourcePaths.artifactInspector}"
    export PI_R_DATA_INSPECTOR_SCRIPT="${piR.resourcePaths.dataInspector}"
    export PI_R_SANDBOX_PATH="${piR.resourcePaths.sandboxRuntimePath}"
    export PI_R_NIXPKGS_PATH="${piR.resourcePaths.nixpkgs}"
    export PI_R_NIXPKGS_PIN_PATH="${piR.resourcePaths.nixpkgsPin}"
    export PI_R_SCOUT_PI="${lib.getExe pi}"
    export PI_R_SCOUT_EXTENSION="${piR.resourcePaths.scoutExtension}"
    unset PI_R_TEST_TREE_SITTER PI_R_TEST_TREE_SITTER_R PI_R_TEST_TREE_SITTER_QUERY PI_R_TEST_BASE_RSCRIPT PI_R_TEST_RESOURCE_ROOT
  '';
}
