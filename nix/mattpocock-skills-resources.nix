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
    cp ${../config/mattpocock-skills/code-review/SKILL.md} skills/engineering/code-review/SKILL.md
    cp ${../config/mattpocock-skills/implement/SKILL.md} skills/engineering/implement/SKILL.md
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
