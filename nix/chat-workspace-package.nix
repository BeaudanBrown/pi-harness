{ pkgs }:
let
  python = pkgs.python3;
  worker = ../config/agent/extensions/bridge-chat/workspace.py;
  closure = pkgs.closureInfo { rootPaths = [ python worker ]; };
  launcher = pkgs.writeText "pi-chat-workspace-launch.py" ''
    import os, pathlib, stat, sys
    import subprocess

    def directory(value):
        path = pathlib.Path(value)
        if not path.is_absolute() or str(path.resolve(strict=True)) != value:
            raise RuntimeError("noncanonical directory")
        return os.open(value, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)

    if len(sys.argv) != 4:
        raise SystemExit("expected trusted workspace, state and IPC directories")
    project, state, ipc = map(directory, sys.argv[1:])
    identities = [(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in (project, state, ipc)]
    if len(set(identities)) != 3:
        raise SystemExit("directories must be distinct")
    roots = [pathlib.Path(p) for p in sys.argv[1:]]
    if any(a in b.parents for a in roots for b in roots if a != b):
        raise SystemExit("directories must not overlap")
    args = ["${pkgs.bubblewrap}/bin/bwrap", "--unshare-all", "--die-with-parent",
            "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--dir", "/nix", "--dir", "/nix/store", "--proc", "/proc",
            "--dev", "/dev", "--tmpfs", "/tmp",
            "--bind", f"/proc/self/fd/{project}", "/workspace",
            "--bind", f"/proc/self/fd/{state}", "/state",
            "--bind", f"/proc/self/fd/{ipc}", "/ipc"]
    with open("${closure}/store-paths") as paths:
        for path in paths:
            path = path.strip()
            args += ["--ro-bind", path, path]
    # Never expose project-controlled Pi/Git/publication internals. Only mount
    # over existing real directories; do not create placeholders in the source.
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
    # Kernel isolation failure exits nonzero. Never run the worker directly.
    # Descriptors are needed for mount setup, and closed by bwrap before exec.
    raise SystemExit(subprocess.call(args, pass_fds=(project, state, ipc), env={}))
  '';
in pkgs.writeShellApplication {
  name = "pi-chat-workspace";
  text = ''
    exec ${python}/bin/python3 -I -B ${launcher} "$@"
  '';
}
