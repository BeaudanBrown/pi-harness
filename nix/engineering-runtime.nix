{ bash, coreutils, findutils, gnugrep, gnused, git, gh, jq, ripgrep, which, nix, flock }:

# Generic engineering utilities only. Compilers and language runtimes belong to
# the project environment. Callers append this list after their existing PATH.
[ bash coreutils findutils gnugrep gnused git gh jq ripgrep which nix flock ]
