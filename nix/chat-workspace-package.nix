{ pkgs, commands ? { }, commandMounts ? { } }:
let
  python = pkgs.python3;
  worker = ../config/agent/extensions/bridge-chat/workspace.py;
  commandConfig = pkgs.writeText "pi-chat-project-commands.json" (builtins.toJSON commands);
  mounts = pkgs.writeText "pi-chat-command-mounts.json" (builtins.toJSON commandMounts);
  closure = pkgs.closureInfo { rootPaths = [ python worker commandConfig ]; };
  launcher = pkgs.writeText "pi-chat-workspace-launch.py" ''
    import json, os, pathlib, stat, sys, subprocess

    def directory(value):
        path = pathlib.Path(value)
        if not path.is_absolute() or str(path.resolve(strict=True)) != value:
            raise RuntimeError("noncanonical directory")
        return os.open(value, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)

    if len(sys.argv) != 3:
        raise SystemExit("expected trusted workspace and IPC directories")
    project, ipc = map(directory, sys.argv[1:])
    roots = [pathlib.Path(p) for p in sys.argv[1:]]
    if roots[0] == roots[1] or any(a in b.parents for a in roots for b in roots if a != b):
        raise SystemExit("directories must not overlap")
    fds = [project, ipc]
    args = ["${pkgs.bubblewrap}/bin/bwrap", "--unshare-all", "--die-with-parent",
            "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--dir", "/nix", "--dir", "/nix/store", "--proc", "/proc",
            "--dev", "/dev", "--tmpfs", "/tmp",
            "--bind", f"/proc/self/fd/{project}", "/workspace",
            "--bind", f"/proc/self/fd/{ipc}", "/ipc"]
    with open("${closure}/store-paths") as paths:
        for path in paths:
            path = path.strip()
            args += ["--ro-bind", path, path]
    args += ["--ro-bind", "${commandConfig}", "/commands.json"]
    with open("${mounts}") as stream:
        for name, mount in json.load(stream).items():
            if not name.isascii() or not name.isidentifier():
                raise SystemExit("invalid mount key")
            fd = directory(mount["source"])
            fds.append(fd)
            args += ["--ro-bind" if mount["readOnly"] else "--bind", f"/proc/self/fd/{fd}", "/commands/data/" + name]
    for name in (".git", ".pi", ".agents", ".publishing"):
        try:
            metadata = os.stat(name, dir_fd=project, follow_symlinks=False)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(metadata.st_mode):
            args += ["--tmpfs", "/workspace/" + name, "--remount-ro", "/workspace/" + name]
    args += ["--chdir", "/workspace", "--setenv", "HOME", "/tmp",
             "--setenv", "PATH", "${python}/bin",
             "${python}/bin/python3", "-I", "-B", "${worker}"]
    # No direct-worker fallback if isolation fails.
    raise SystemExit(subprocess.call(args, pass_fds=tuple(fds), env={}))
  '';
in pkgs.writeShellApplication {
  name = "pi-chat-workspace";
  text = ''
    exec ${python}/bin/python3 -I -B ${launcher} "$@"
  '';
}
