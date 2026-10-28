import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class NodeInstallerTests(unittest.TestCase):
    def test_install_repeat_and_python_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            original = 'model = "example"\nmodel_instructions_file = "./previous.md"\n[provider]\nname = "kept"\n'
            config.write_text(original, encoding="utf-8")
            env = {**os.environ, "CODEX_HOME": directory}
            for _ in range(2):
                subprocess.run(["node", str(ROOT / "install.js")], env=env, check=True, capture_output=True)
            self.assertIn('model_instructions_file = "./gpt-6.1-sol-v1-rc2.md"', config.read_text(encoding="utf-8"))
            state = json.loads((home / ".gpt56-sol-instruct-state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["previous_model_instructions_line"], 'model_instructions_file = "./previous.md"')
            self.assertEqual(len(list(home.glob("config.toml.bak_*"))), 2)
            subprocess.run([os.sys.executable, str(ROOT / "codex-instruct.py"), "--reset", "--codex-dir", directory], input="y\n", text=True, check=True, capture_output=True)
            self.assertEqual(config.read_text(encoding="utf-8"), original)
            self.assertFalse((home / "gpt-6.1-sol-v1-rc2.md").exists())

    def test_unmanaged_prompt_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            prompt = home / "gpt-6.1-sol-v1-rc2.md"
            prompt.write_text("user content", encoding="utf-8")
            env = {**os.environ, "CODEX_HOME": directory}
            result = subprocess.run(["node", str(ROOT / "install.js")], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(prompt.read_text(encoding="utf-8"), "user content")
            self.assertFalse((home / "config.toml").exists())


if __name__ == "__main__":
    unittest.main()
