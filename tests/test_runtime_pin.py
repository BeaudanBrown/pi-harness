"""Runtime rooting policy at the Nix/process seam; no daemon or real Pi used."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pin", "scripts/pin-runtime.py")
pin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pin)


class RuntimePinTests(unittest.TestCase):
    def run_pin(self, fail=False, retain=False, code=7):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            launcher = "/nix/store/abc-pi/bin/pi"
            events = []
            def root_command(args, **kwargs):
                events.append("root")
                self.assertEqual(args[-1], "/nix/store/abc-pi")
                self.assertIn("--indirect", args)
                if fail:
                    raise subprocess.CalledProcessError(1, args)
                Path(args[2]).symlink_to("/nix/store/abc-pi")
            class Child:
                def wait(self):
                    events.append("wait")
                    assert len(list(state.glob("pi-runtime-roots/launch-*/runtime"))) == 1
                    return code
                def poll(self):
                    return code
            def launch(args, **kwargs):
                events.append("launch")
                self.assertEqual(kwargs["env"]["PI_HARNESS_PINNED_LAUNCHER"], launcher)
                self.assertEqual(args, [launcher, "--session", "example"])
                return Child()
            with patch.dict(os.environ, {"XDG_STATE_HOME": directory, "PI_RUNTIME_NIX_STORE": "nix-store", "PI_RUNTIME_RETAIN_ON_FAILURE": "1" if retain else "0"}), \
                 patch.object(pin.sys, "argv", ["pin", launcher, "--session", "example"]), \
                 patch.object(pin.subprocess, "run", root_command), patch.object(pin.subprocess, "Popen", launch), \
                 patch.object(pin.signal, "signal"):
                if fail:
                    with self.assertRaises(subprocess.CalledProcessError):
                        pin.main()
                    self.assertEqual(events, ["root"])
                else:
                    self.assertEqual(pin.main(), code)
                    self.assertEqual(events, ["root", "launch", "wait"])
                self.assertEqual(len(list(state.glob("pi-runtime-roots/launch-*"))), 1 if retain and code != 0 and not fail else 0)

    def test_root_covers_live_child_and_is_removed_after_exit(self):
        self.run_pin()

    def test_failed_task_retains_a_conservative_root_for_possible_git_orphans(self):
        self.run_pin(retain=True, code=1)
        self.run_pin(retain=True, code=137)

    def test_successful_task_releases_its_root(self):
        self.run_pin(retain=True, code=0)

    def test_failed_root_never_launches(self):
        self.run_pin(fail=True)

    def test_mutable_launcher_rejected(self):
        with patch.object(pin.sys, "argv", ["pin", "/tmp/pi"]):
            with self.assertRaises(SystemExit):
                pin.main()


if __name__ == "__main__":
    unittest.main()
