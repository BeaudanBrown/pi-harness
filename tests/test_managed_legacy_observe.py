import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("legacy", "scripts/managed-legacy-observe.py")
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
CID = "conv_" + "a" * 32
BOOT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


class LegacyExitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proc = Path(self.temp.name)
        boot = self.proc / "sys/kernel/random/boot_id"
        boot.parent.mkdir(parents=True)
        boot.write_text(BOOT)
        self.request = {"conversationId": CID, "window": {"sessionName": "project", "windowId": "@3", "paneId": "%3"}, "sessionFile": "/private/session.jsonl"}
        self.pane = f"project|@3|%54|123|{CID}||1|0|0\n"
        self.process(123, 1, 100, env=f"PI_MANAGED_SESSION_CONVERSATION_ID={CID}".encode())

    def process(self, pid, parent, start, env=b"", argv=b""):
        directory = self.proc / str(pid)
        directory.mkdir(exist_ok=True)
        fields = ["S", str(parent)] + ["0"] * 17 + [str(start)]
        (directory / "stat").write_text(f"{pid} (name with ) spaces) " + " ".join(fields))
        (directory / "environ").write_bytes(env)
        (directory / "cmdline").write_bytes(argv)

    def observe(self, panes=None, evidence=None):
        return legacy.observe({**self.request, **({"evidence": evidence} if evidence else {})}, self.pane if panes is None else panes, self.proc)

    def test_capture_is_observation_not_adoption_and_includes_descendants_and_detached_writers(self):
        self.process(124, 123, 101)
        self.process(125, 1, 102, env=f"PI_MANAGED_SESSION_CONVERSATION_ID={CID}".encode())
        self.process(126, 1, 103, argv=b"pi\0--session\0/private/session.jsonl\0")
        evidence = self.observe()
        self.assertEqual([p["pid"] for p in evidence["processes"]], ["123", "124", "125", "126"])
        self.assertEqual(evidence["bootId"], BOOT)
        self.assertNotIn("ownership", evidence)
        self.assertEqual(self.observe(evidence=evidence), {"state": "running"})

    def test_absent_or_changed_or_linked_window_never_creates_evidence(self):
        for panes in ["", self.pane * 2, self.pane.replace("project|", "other|"), self.pane.replace("||1|0|0", "|launch_" + "a" * 32 + "|1|0|0"), self.pane.replace("|1|0|0", "|2|0|0"), self.pane.replace("|1|0|0", "|1|1|0"), self.pane.replace("|1|0|0", "|1|0|1")]:
            with self.subTest(panes=panes), self.assertRaises(ValueError):
                self.observe(panes)

    def test_replaced_unrelated_pane_cannot_supply_exit_evidence(self):
        self.process(123, 1, 100)  # Marker survived but this process is unrelated.
        with self.assertRaisesRegex(ValueError, "no matching"):
            self.observe()
        # A detached writer elsewhere does not authenticate the unrelated pane.
        self.process(125, 1, 102, env=f"PI_MANAGED_SESSION_CONVERSATION_ID={CID}".encode())
        with self.assertRaisesRegex(ValueError, "no matching"):
            self.observe()
        self.process(124, 123, 101, argv=b"cat\0/private/session.jsonl\0")
        with self.assertRaisesRegex(ValueError, "no matching"):
            self.observe()
        self.process(124, 123, 101, argv=b"pi\0--session\0/private/session.jsonl\0")
        self.assertEqual(len(self.observe()["processes"]), 3)

    def test_missing_marker_is_not_process_exit(self):
        evidence = self.observe()
        self.assertEqual(self.observe("", evidence), {"state": "running"})
        self.process(123, 1, 200)  # PID reuse proves the original birth is gone.
        self.assertEqual(self.observe("", evidence), {"state": "gone"})
        # Replacement/unmarked pane in the same reusable window ID still blocks.
        self.assertEqual(self.observe(self.pane.replace(CID, ""), evidence), {"state": "running"})

    def test_reboot_proves_old_process_exit_but_not_current_writer_absence(self):
        evidence = self.observe()
        (self.proc / "sys/kernel/random/boot_id").write_text("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        self.process(123, 1, 100)  # New boot, unrelated process with the reused PID.
        self.assertEqual(self.observe("", evidence), {"state": "gone"})
        self.process(456, 1, 100, env=b"PI_MANAGED_PROJECT_SESSION_FILE=/private/session.jsonl\0")
        self.assertEqual(self.observe("", evidence), {"state": "running"})

    def test_read_errors_and_malformed_evidence_fail_closed(self):
        evidence = self.observe()
        for invalid in [{**evidence, "extra": True}, {**evidence, "processes": []}, {**evidence, "processes": [{"pid": "0", "startTicks": "100"}]}]:
            with self.assertRaises(ValueError):
                self.observe("", invalid)
        (self.proc / "123/stat").write_text("corrupt")
        with self.assertRaises(ValueError):
            self.observe("", evidence)

    def test_helper_is_read_only(self):
        before = {str(p): p.read_bytes() for p in self.proc.rglob("*") if p.is_file()}
        evidence = self.observe()
        self.observe("", evidence)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.proc.rglob("*") if p.is_file()})


if __name__ == "__main__":
    unittest.main()
