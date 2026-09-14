"""Khởi động server TypeScript."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NODE = Path(r"C:\Program Files\nodejs\node.exe")
node = str(NODE) if NODE.exists() else "node"
os.environ["PATH"] = r"C:\Program Files\nodejs;" + os.environ.get("PATH", "")
raise SystemExit(
    subprocess.call([node, "--experimental-strip-types", str(ROOT / "src" / "server.ts")], cwd=ROOT)
)
