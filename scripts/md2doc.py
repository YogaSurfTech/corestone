#!/usr/bin/env python3
"""Converts a Markdown file into a Corestone document (texts and pictures; no entries).

The first level-1 heading is the document's title; the other headings become nested sections.
Bold, italic and web links are kept; inline code and code blocks use Courier New; lists keep their
kind and level; tables keep their first row as header cells; quotes become italic paragraphs.
<img src="..."> pictures with a local path become images (their files listed under "images");
badges, HTML wrappers and horizontal rules are dropped, as are links that are not web addresses.

  scripts/md2doc.py FILE.md                      prints {"title", "content", "images"} as JSON
  scripts/md2doc.py FILE.md --post URL --path FOLDER --type TYPE [--cookie FILE]
                                                 creates the document on a Corestone server (URL
                                                 e.g. http://127.0.0.1:8080; cookie: a curl cookie
                                                 jar of a login) and uploads its pictures
"""
import argparse, http.cookiejar, json, os, re, secrets, string, sys, urllib.request

ALNUM = string.ascii_lowercase + string.digits
def sid(): return "".join(secrets.choice(ALNUM) for _ in range(8))

INLINE = re.compile(r"(\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w))")
def runs(s, base=None):
    base = dict(base or {})
    out, pos = [], 0
    for m in INLINE.finditer(s):
        if m.start() > pos: out.append({"text": s[pos:m.start()], **base})
        if m.group(2) or m.group(3): out += runs(m.group(2) or m.group(3), {**base, "bold": True})
        elif m.group(4) is not None: out.append({"text": m.group(4), **base, "font": "Courier New"})
        elif m.group(5):
            href = m.group(6)
            extra = {"href": href} if re.match(r"^(https?:|mailto:|ftp:)", href) else {}
            out += runs(m.group(5), {**base, **extra})
        elif m.group(7) or m.group(8): out += runs(m.group(7) or m.group(8), {**base, "italic": True})
        pos = m.end()
    if pos < len(s): out.append({"text": s[pos:], **base})
    # merge plain neighbours
    merged = []
    for r in out:
        if merged and {k: v for k, v in merged[-1].items() if k != "text"} == {k: v for k, v in r.items() if k != "text"}: merged[-1]["text"] += r["text"]
        else: merged.append(r)
    return [r for r in merged if r["text"]]

def text_of(s, base=None):
    r = runs(s, base)
    if len(r) == 1 and set(r[0]) == {"text"}: return r[0]["text"]
    return r or ""

def convert(md, images):
    lines = md.split("\n")
    title, root = None, []
    stack = [(1, root)]  # (heading level, children list)
    def cur(): return stack[-1][1]
    i, para = 0, []
    def flush():
        if para:
            cur().append({"text": text_of(" ".join(x.strip() for x in para))})
            para.clear()
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if s.startswith("```"):
            flush(); i += 1; code = []
            while i < len(lines) and not lines[i].strip().startswith("```"): code.append(lines[i]); i += 1
            i += 1
            cur().append({"text": [{"text": "\n".join(code) or " ", "font": "Courier New"}]})
            continue
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*$", s)
        if m:
            flush()
            lvl, t = len(m.group(1)), re.sub(r"[*_`]", "", m.group(2))
            if lvl == 1 and title is None: title = t; i += 1; continue
            while len(stack) > 1 and stack[-1][0] >= lvl: stack.pop()
            node = {"section": sid(), "title": t, "children": []}
            cur().append(node); stack.append((lvl, node["children"])); i += 1; continue
        im = re.search(r'<img\s[^>]*src="([^"]+)"[^>]*?(?:width="(\d+)")?[^>]*>', s)
        if im and not im.group(1).startswith("http"):
            flush()
            src = im.group(1); name = src.split("/")[-1]; images[name] = src
            alt = re.search(r'alt="([^"]*)"', s)
            run = {"image": name}
            if alt: run["alt"] = alt.group(1)[:200]
            w = re.search(r'width="(\d+)"', s)
            run["width"] = min(int(w.group(1)) if w else 700, 700)
            cur().append({"text": [run], "align": "center"}); i += 1; continue
        if re.match(r"^</?\w+[^>]*>$", s) or re.match(r"^\[!\[", s) or re.match(r"^(-{3,}|\*{3,})$", s):
            flush(); i += 1; continue  # html wrappers, badges, rules
        if s.startswith("|"):
            flush(); rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.match(r"^:?-{2,}:?$", c) for c in cells if c): rows.append(cells)
                i += 1
            n = max(len(r) for r in rows)
            table = []
            for k, r in enumerate(rows):
                r = r + [""] * (n - len(r))
                cell = lambda c: (lambda t: t if isinstance(t, str) else [{"text": t}])(text_of(c))
                table.append([{"content": cell(c), "header": True} if k == 0 else cell(c) for c in r])
            cur().append({"table": table}); continue
        lm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", ln)
        if lm:
            flush()
            item = [lm.group(3)]
            j = i + 1
            while j < len(lines) and lines[j].strip() and not re.match(r"^\s*([-*+]|\d+[.)])\s+", lines[j]) and not lines[j].strip().startswith(("|", "#", "```")) and lines[j].startswith(" "):
                item.append(lines[j].strip()); j += 1
            level = min(len(lm.group(1).replace("\t", "  ")) // 2 + 1, 6)
            cur().append({"text": text_of(" ".join(item)), "list": "ol" if lm.group(2)[0].isdigit() else "ul", **({"level": level} if level > 1 else {})})
            i = j; continue
        if s.startswith(">"):
            flush()
            q = []
            while i < len(lines) and lines[i].strip().startswith(">"): q.append(lines[i].strip().lstrip(">").strip()); i += 1
            cur().append({"text": text_of(" ".join(q), {"italic": True})}); continue
        if not s: flush(); i += 1; continue
        para.append(s.replace("<br>", "")); i += 1
    flush()
    return title, root

def post(url, method, body, ctype, opener):
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": ctype})
    with opener.open(req) as r:
        data = r.read()
        return json.loads(data) if data else None

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Converts a Markdown file into a Corestone document.")
    ap.add_argument("file")
    ap.add_argument("--post", metavar="URL", help="create the document on this server")
    ap.add_argument("--path", default="", help="the folder for the document")
    ap.add_argument("--type", default="spec", help="the document type")
    ap.add_argument("--cookie", help="a curl cookie jar with a login")
    a = ap.parse_args()
    images = {}
    title, content = convert(open(a.file, encoding="utf-8").read(), images)
    title = title or os.path.splitext(os.path.basename(a.file))[0]
    if not a.post:
        print(json.dumps({"title": title, "content": content, "images": images}))
        sys.exit(0)
    jar = http.cookiejar.MozillaCookieJar()
    if a.cookie: jar.load(a.cookie, ignore_discard=True, ignore_expires=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    api = a.post.rstrip("/") + "/api"
    doc = post(api + "/documents", "POST", json.dumps({"path": a.path, "type": a.type, "title": title, "content": content}).encode(), "application/json", opener)
    guid = doc["meta"]["guid"]
    base = os.path.dirname(os.path.abspath(a.file))
    for name, src in images.items():
        for cand in (os.path.join(base, src), os.path.join(base, os.path.basename(src)), src):
            if os.path.exists(cand):
                post(f"{api}/artifacts/{guid}/files/{urllib.request.quote(name)}", "PUT", open(cand, "rb").read(), "application/octet-stream", opener)
                break
        else:
            print(f"picture not found: {src}", file=sys.stderr)
    print(guid)
