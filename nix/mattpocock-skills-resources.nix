{
  stdenvNoCC,
  lib,
  mattPocockSkillsSrc,
}:

let
  selectedSkills = [
    "engineering/ask-matt"
    "engineering/codebase-design"
    "engineering/code-review"
    "engineering/diagnosing-bugs"
    "engineering/domain-modeling"
    "engineering/grill-with-docs"
    "engineering/implement"
    "engineering/prototype"
    "engineering/research"
    "engineering/resolving-merge-conflicts"
    "engineering/setup-matt-pocock-skills"
    "engineering/tdd"
    "engineering/to-spec"
    "engineering/to-tickets"
    "engineering/triage"
    "engineering/wayfinder"
    "productivity/grilling"
    "productivity/handoff"
  ];
in
stdenvNoCC.mkDerivation {
  pname = "mattpocock-skills-resources";
  version = "2026-07-10";
  src = mattPocockSkillsSrc;

  postPatch = ''
    skill=skills/engineering/code-review/SKILL.md
    substituteInPlace "$skill" \
      --replace-fail '### 4. Spawn both sub-agents in parallel' '### 4. Run both review agents in parallel' \
      --replace-fail 'Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both.' 'Call `review_agents` once with the fixed point from step 1 and one task per available axis. A single call pins one diff for both isolated agents and runs the tasks concurrently with the dedicated review model.' \
      --replace-fail '**Standards sub-agent prompt** — include:' '**Standards task instructions** — include:' \
      --replace-fail 'the sub-agent has no other access to it.' 'the review agent has no other access to it.' \
      --replace-fail '**Spec sub-agent prompt** — include:' '**Spec task instructions** — include:' \
      --replace-fail 'If the spec is missing, skip the Spec sub-agent and note this in the final report.' 'If the spec is missing, pass only the Standards task and note this in the final report.'
  '';

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/pi-harness/mattpocock-skills"
    ${lib.concatMapStringsSep "\n" (
      skill:
      let
        name = lib.last (lib.splitString "/" skill);
      in
      ''
        cp -R "skills/${skill}" "$out/share/pi-harness/mattpocock-skills/${name}"
      ''
    ) selectedSkills}

    runHook postInstall
  '';

  passthru = {
    inherit selectedSkills;
  };

  meta = {
    description = "Curated immutable Matt Pocock engineering skills for pi-harness";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
