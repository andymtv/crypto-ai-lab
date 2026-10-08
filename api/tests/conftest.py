import os
import sys
import tempfile

# Isolate tests from the real data directory.
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="crypto-ai-lab-test-")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
