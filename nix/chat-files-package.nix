{ pkgs }:
let
  python = pkgs.python3;
  download = ../config/agent/extensions/bridge-chat/download.py;
  closure = pkgs.closureInfo { rootPaths = [ python download pkgs.cacert pkgs.imagemagick ]; };
  launcher = pkgs.writeText "pi-chat-file-sandbox.py" ''
    import os, pathlib, subprocess, sys
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    args = ["${pkgs.bubblewrap}/bin/bwrap", "--unshare-all", "--die-with-parent",
            "--new-session", "--cap-drop", "ALL", "--clearenv", "--dir", "/nix",
            "--dir", "/nix/store", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    fds = []
    with open("${closure}/store-paths") as paths:
        for path in paths:
            path = path.strip()
            args += ["--ro-bind", path, path]
    if mode == "download" and len(sys.argv) == 3:
        path = pathlib.Path(sys.argv[2])
        if not path.is_absolute() or str(path.resolve(strict=True)) != str(path):
            raise SystemExit("invalid staging directory")
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        fds.append(fd)
        args += ["--share-net", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
                 "--ro-bind", "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt", "/ca.pem",
                 "--bind", f"/proc/self/fd/{fd}", "/download", "--chdir", "/download",
                 "${python}/bin/python3", "-I", "-B", "${download}"]
    elif mode == "image":
        args += ["--chdir", "/tmp", "--setenv", "MAGICK_THREAD_LIMIT", "1",
                 "${pkgs.imagemagick}/bin/magick"] + sys.argv[2:]
    else:
        raise SystemExit("invalid operation")
    raise SystemExit(subprocess.call(args, pass_fds=tuple(fds), env={}))
  '';
in pkgs.runCommand "pi-chat-file-sandbox" { } ''
  mkdir -p "$out/bin"
  for mode in download image; do
    cat > "$out/bin/pi-chat-$mode" <<EOF
#!${pkgs.runtimeShell}
exec ${python}/bin/python3 -I -B ${launcher} $mode "\$@"
EOF
    chmod +x "$out/bin/pi-chat-$mode"
  done
''
