"""Score the tool on the fictional test documents in tests/corpus/, with the name model switched on.

    python3 tests/run_corpus.py        # both sets
    python3 tests/run_corpus.py a      # one set

Serves a temporary copy of the site on 127.0.0.1, opens it in headless Chrome (set CHROME to override the path),
and the page posts its results back. Nothing is written into the repository.
"""
import http.server
import json
import os
import pathlib
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS = ROOT / "tests" / "corpus"
CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
MODES = {"只靠規則": "rules", "使用模型（預設）": "model", "貼上名單": "lists"}

HARNESS = """
<script>
(async function(){
  const DOCS = %s, NAMES = %s, ORGS = %s, out = {}, t0 = Date.now();
  while (!(window.PiiNer && window.PiiNer.session) && Date.now() - t0 < 90000) await new Promise(r => setTimeout(r, 300));
  const empty = {names: [], orgs: [], keywords: [], extraNames: []};
  for (const [name, text] of Object.entries(DOCS)) {
    const pack = r => ({masked: r.masked, roundtrip: window.deid.restore(r.masked, r.mapping) === text});
    out[name] = {
      rules: pack(window.deid.run(text, empty)),
      model: pack(await window.deid.runAuto(text, empty)),
      lists: pack(window.deid.run(text, Object.assign({}, empty, {names: NAMES, orgs: ORGS}))),
    };
  }
  await fetch('/__results', {method: 'POST', body: JSON.stringify({loaded: !!(window.PiiNer && window.PiiNer.session), out})});
})().catch(e => fetch('/__results', {method: 'POST', body: JSON.stringify({error: String(e && e.stack || e)})}));
</script>
"""


def chrome_path():
    for p in [os.environ.get("CHROME")] + CHROME_PATHS:
        if p and pathlib.Path(p).exists():
            return p
    sys.exit("Chrome not found; set CHROME to its path")


def run_in_browser(docs, names, orgs):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="pii_mask_test_"))
    site = tmp / "site"
    shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns(".git", "tests"))
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    harness = HARNESS % tuple(json.dumps(x, ensure_ascii=False) for x in (docs, names, orgs))
    (site / "runner.html").write_text(page.replace("</body>", harness + "</body>"), encoding="utf-8")
    box = {}

    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(site), **k)

        def log_message(self, *a):
            pass

        def do_POST(self):
            box["data"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(204)
            self.end_headers()

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = subprocess.Popen([chrome_path(), "--headless=new", "--disable-gpu", "--no-first-run", f"--user-data-dir={tmp / 'profile'}",
                                f"http://127.0.0.1:{server.server_address[1]}/runner.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 240
    while "data" not in box and time.time() < deadline:
        time.sleep(0.5)
    browser.kill()
    server.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    if "data" not in box:
        sys.exit("timed out waiting for the page")
    if "error" in box["data"]:
        sys.exit("page error: " + box["data"]["error"])
    return box["data"]


def normalise(s):
    return re.sub(r"[\s\-()（）#+]", "", s)


def score(set_name):
    truth = json.loads((CORPUS / f"truth_{set_name}.json").read_text(encoding="utf-8"))
    docs = {n: (CORPUS / set_name / n).read_text(encoding="utf-8") for n in truth}
    names = sorted({p["value"] for d in truth.values() for p in d["pii"] if p["type"] == "姓名"}, key=len, reverse=True)
    orgs = sorted({p["value"] for d in truth.values() for p in d["pii"] if p["type"] == "公司"}, key=len, reverse=True)
    result = run_in_browser(docs, names, orgs)
    print(f"第 {set_name.upper()} 組：{len(docs)} 份文件，模型{'已' if result['loaded'] else '沒有'}載入")
    for label, mode in MODES.items():
        caught = total = roundtrip = 0
        missed, overmasked = [], []
        for name, t in truth.items():
            masked = result["out"][name][mode]["masked"]
            roundtrip += result["out"][name][mode]["roundtrip"]
            for p in t["pii"]:
                total += 1
                leaked = p["leak_check"] in masked or (p["type"] not in ("姓名", "公司", "地址") and normalise(p["leak_check"]) in normalise(masked))
                if leaked:
                    missed.append(f"{p['type']} {p['value']}")
                else:
                    caught += 1
            overmasked += [k for k in t["keep"] if k not in masked]
        print(f"  {label}：遮掉 {caught}/{total}，誤遮 {len(overmasked)}，還原一字不差 {roundtrip}/{len(docs)}")
        if mode == "model":
            print(f"    漏掉：{'、'.join(missed) or '無'}")
            print(f"    誤遮：{'、'.join(overmasked) or '無'}")


if __name__ == "__main__":
    for s in (sys.argv[1:] or ["a", "b"]):
        score(s)
