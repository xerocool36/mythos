#!/usr/bin/env bash
# Rebuild the Mythos handover documents, two PDFs from one template:
#
#   guida.template.html → MYTHOS-guida.pdf      (<!--G--> pages: how-to, nothing confidential,
#                                                 safe to give to all staff)
#                       → MYTHOS-riservato.pdf  (<!--R--> pages: accounts, console password,
#                                                 every link, handover signatures)
#
# Pages outside both markers (the cover shell) appear in both.
#
# Sources live here in tools/guida (template, screenshots of sample data — no
# secrets, safe in the public repo). Output goes to deliverables/, which is
# gitignored: the console password is read from deliverables/credenziali-console.txt
# and only ever lands in the riservato document.
#
# Images are inlined as data URIs (logos from docs/assets/img/mail, screenshots
# from tools/guida/shots, the menu QR).
#
# Edit the template, run `bash tools/guida/build-guida.sh`, hand over the PDFs.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(cd "$SRC/../.." && pwd)"
DIR="$BASE/deliverables"
mkdir -p "$DIR"

python3 - "$BASE" "$SRC" <<'PY'
import base64, datetime, pathlib, re, sys

base = pathlib.Path(sys.argv[1])
src = pathlib.Path(sys.argv[2])
d = base / "deliverables"
tpl = (src / "guida.template.html").read_text()

def uri(path):
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()

def img(m):
    name = m.group(1)
    if name.startswith("shots/"):
        return uri(src / (name + ".png"))
    if name == "qr-menu":
        return uri(base / "docs/assets/img/qr-menu.png")
    return uri(base / "docs/assets/img/mail" / (name + ".png"))

tpl = re.sub(r"IMG:([\w/-]+)", img, tpl)
months = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio",
          "agosto", "settembre", "ottobre", "novembre", "dicembre"]
today = datetime.date.today()
tpl = tpl.replace("{{DATE}}", f"{today.day} {months[today.month - 1]} {today.year}")

pw = re.search(r"^Password: (.+)$", (d / "credenziali-console.txt").read_text(), re.M).group(1).strip()

def edition(keep, drop, password):
    html = re.sub(rf"<!--{drop}-->.*?<!--/{drop}-->", "", tpl, flags=re.S)
    html = html.replace(f"<!--{keep}-->", "").replace(f"<!--/{keep}-->", "")
    html = html.replace("{{CONSOLE_PW}}", password)
    n = iter(range(2, 99))
    return re.sub(r"\{\{P\}\}", lambda _: str(next(n)), html)

riservato = edition("R", "G", pw)
guida = edition("G", "R", "")
assert pw not in guida and "admin.html" not in guida and "{{" not in guida + riservato
(d / "guida.html").write_text(guida)
(d / "riservato.html").write_text(riservato)
print(f"html: guida {len(guida) // 1024} KB, riservato {len(riservato) // 1024} KB")
PY

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for ed in guida riservato; do
  "$CHROME" --headless --disable-gpu --no-pdf-header-footer --virtual-time-budget=4000 \
    --print-to-pdf="$DIR/MYTHOS-$ed.pdf" "file://$DIR/$ed.html" 2>/dev/null
  echo "pdf:  $DIR/MYTHOS-$ed.pdf"
done
cp "$BASE/docs/assets/img/qr-menu.png" "$DIR/MYTHOS-qr-menu.png"
echo "qr:   $DIR/MYTHOS-qr-menu.png"
