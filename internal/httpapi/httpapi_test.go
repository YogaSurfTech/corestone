package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/testutil"
)

type api struct {
	t   *testing.T
	srv *httptest.Server
	s   *Server
}

func (a *api) Hub() *Hub { return a.s.Hub }

func newAPI(t *testing.T) *api {
	t.Helper()
	f, err := foundation.Open(context.Background(), t.TempDir()+"/repo.git", "main", testutil.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	s := New(f)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &api{t: t, srv: srv, s: s}
}

type resp struct {
	code int
	body map[string]any
	raw  []byte
	hdr  http.Header
}

func (a *api) do(method, path string, body string, headers ...string) resp {
	a.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, a.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	r := resp{code: res.StatusCode, raw: raw, hdr: res.Header}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		_ = json.Unmarshal(raw, &r.body)
	}
	return r
}

func (a *api) ok(method, path, body string, want int, headers ...string) resp {
	a.t.Helper()
	r := a.do(method, path, body, headers...)
	if r.code != want {
		a.t.Fatalf("%s %s: got %d want %d: %s", method, path, r.code, want, r.raw)
	}
	return r
}

func meta(r resp, key string) string {
	m, _ := r.body["meta"].(map[string]any)
	s, _ := m[key].(string)
	return s
}

func (a *api) seed() {
	a.ok("PUT", "/api/config?path=entries/workflows/dev-workflow.json", `{"initial":"open","states":["open","review","done"],"transitions":[{"id":"submit","from":"open","to":"review"},{"id":"approve","from":"review","to":"done"}]}`, 200)
	a.ok("PUT", "/api/config?path=entries/fields.json", `{"fields":[{"id":"priority","type":"enum","options":[{"value":"low"},{"value":"high"}]},{"id":"rationale","type":"multiline"},{"id":"status","type":"workflow","workflow":"dev"}]}`, 200)
	a.ok("PUT", "/api/config?path=entries/types.json", `{"types":[
		{"id":"requirement","displayName":"Requirement","hid":{"prefix":"REQ"},"fields":[{"id":"priority","required":true},"rationale","status"]},
		{"id":"testcase","hid":{"prefix":"TC"}}]}`, 200)
	a.ok("PUT", "/api/config?path=documents/types.json", `{"types":[{"id":"spec"}]}`, 200)
	a.ok("PUT", "/api/config?path=links/types.json", `{"types":[{"id":"verifies","sourceTypes":["testcase"],"targetTypes":["requirement"],"cardinality":"many-to-many"}]}`, 200)
	a.ok("PUT", "/api/config?path=comments/types.json", `{"types":[{"id":"comment"}]}`, 200)
}

func TestRESTLifecycle(t *testing.T) {
	a := newAPI(t)
	a.seed()

	// configuration: invalid files and paths outside the layout are refused;
	// open references are accepted and reported
	a.ok("PUT", "/api/config?path=entries/schema.json", `{}`, 400)
	a.ok("PUT", "/api/config?path=entries/fields.json", `{"fields":[{"id":"x","type":"nope"}]}`, 400)
	a.ok("PUT", "/api/config?path=entries/types.json", `not json`, 400)
	a.ok("PUT", "/api/config?scope=..&path=entries/types.json", `{"types":[]}`, 400)
	cw := a.ok("PUT", "/api/config?scope=lab&path=entries/types.json", `{"types":[{"id":"probe","fields":["missing"]}]}`, 200)
	if ws := cw.body["warnings"].([]any); len(ws) != 1 || cw.hdr.Get("ETag") == "" {
		t.Fatalf("config write %s", cw.raw)
	}
	cf := a.ok("GET", "/api/config?scope=lab&path=entries/types.json", "", 200)
	if !strings.Contains(string(cf.raw), `"probe"`) || cf.hdr.Get("ETag") != cw.hdr.Get("ETag") {
		t.Fatalf("config read %s %v", cf.raw, cf.hdr)
	}
	a.ok("PUT", "/api/config?scope=lab&path=entries/types.json", `{"types":[]}`, 412, "If-Match", `"deadbeef"`)
	a.ok("DELETE", "/api/config?scope=lab&path=entries/types.json", "", 200, "If-Match", cw.hdr.Get("ETag"))

	r1 := a.ok("POST", "/api/entries", `{"path":"specs/boot","type":"requirement","title":"Boot fast","fields":{"priority":"high"}}`, 201)
	g1 := meta(r1, "guid")
	if meta(r1, "hid") != "REQ-1" || r1.hdr.Get("ETag") == "" || r1.hdr.Get("Location") != "/api/entries/"+g1 {
		t.Fatalf("create response %s %v", r1.raw, r1.hdr)
	}
	etag := r1.hdr.Get("ETag")
	a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"no priority"}`, 400)
	a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"dup","hid":"REQ-1","fields":{"priority":"low"}}`, 409)
	a.ok("POST", "/api/entries", `[1,2]`, 400)
	a.ok("POST", "/api/entries", strings.Repeat("x", 5<<20), 413)

	// GET with ETag / If-None-Match, kind-checked routes
	g := a.ok("GET", "/api/entries/"+g1, "", 200)
	if g.hdr.Get("ETag") != etag {
		t.Fatalf("etag %s vs %s", g.hdr.Get("ETag"), etag)
	}
	a.ok("GET", "/api/entries/"+g1, "", 304, "If-None-Match", etag)
	a.ok("GET", "/api/documents/"+g1, "", 404)
	a.ok("GET", "/api/artifacts/"+g1, "", 200)
	a.ok("GET", "/api/entries/not-a-guid", "", 404)
	a.ok("GET", "/api/nope", "", 404)

	// PUT with If-Match (quoted, weak, star) → 200 / 412
	u := a.ok("PUT", "/api/entries/"+g1, `{"title":"Boot in 2 s"}`, 200, "If-Match", etag)
	a.ok("PUT", "/api/entries/"+g1, `{"title":"stale"}`, 412, "If-Match", etag)
	a.ok("PUT", "/api/entries/"+g1, `{"fields":{"rationale":"weak"}}`, 200, "If-Match", "W/"+u.hdr.Get("ETag"))
	a.ok("PUT", "/api/entries/"+g1, `{"fields":{"rationale":"star"}}`, 200, "If-Match", "*")
	a.ok("PUT", "/api/entries/"+g1, `{"fields":{"priority":"urgent"}}`, 400)
	a.ok("PUT", "/api/documents/"+g1, `{"title":"x"}`, 404)

	// documents referencing entries
	d := a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"Boot spec","content":[{"section":"timing01","title":"Timing","children":[{"text":"See:"},{"entry":"`+g1+`"}]}]}`, 201)
	gd := meta(d, "guid")
	a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"bad ref","content":[{"entry":"00000000-0000-4000-8000-000000000000"}]}`, 400)
	usedIn := func(want ...string) {
		t.Helper()
		r := a.ok("GET", "/api/artifacts/"+g1+"/documents", "", 200)
		var got []string
		for _, d := range r.body["documents"].([]any) {
			got = append(got, d.(map[string]any)["guid"].(string))
		}
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Fatalf("documents using the entry: got %v, want %v", got, want)
		}
	}
	usedIn(gd)
	a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"twice","content":[{"entry":"`+g1+`"},{"section":"again001","title":"Again","children":[{"entry":"`+g1+`"}]}]}`, 400)
	d2 := a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"Draft","content":[{"text":"Intro"},{"entry":"`+g1+`"}]}`, 201)
	usedIn(gd, meta(d2, "guid"))
	a.ok("PUT", "/api/documents/"+meta(d2, "guid"), `{"content":[{"text":"no entries"}]}`, 200, "If-Match", "*")
	usedIn(gd)
	a.ok("GET", "/api/artifacts/00000000-0000-4000-8000-000000000000/documents", "", 404)
	// an entry that disappeared after it was placed does not stop the document from saving
	gone := meta(a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"Gone soon","fields":{"priority":"low"}}`, 201), "guid")
	d3 := meta(a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"Keeps","content":[{"entry":"`+gone+`"}]}`, 201), "guid")
	a.ok("DELETE", "/api/entries/"+gone, "", 204, "If-Match", "*")
	a.ok("PUT", "/api/documents/"+d3, `{"content":[{"text":"Still here:"},{"entry":"`+gone+`"}]}`, 200, "If-Match", "*")
	a.ok("PUT", "/api/documents/"+d3, `{"content":[{"entry":"00000000-0000-4000-8000-000000000000"}]}`, 400, "If-Match", "*")
	// the old format is refused
	a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"old","content":[{"type":"paragraph","text":"x"}]}`, 400)
	a.ok("POST", "/api/documents", `{"path":"docs","type":"requirement","title":"wrong kind","fields":{"priority":"low"}}`, 400)

	// links, relationships, comments, workflows
	tc := a.ok("POST", "/api/entries", `{"path":"tests","type":"testcase","title":"Cold boot"}`, 201)
	gt := meta(tc, "guid")
	a.ok("POST", "/api/links", `{"type":"verifies","source":"`+g1+`","target":"`+gt+`"}`, 400)
	l := a.ok("POST", "/api/links", `{"type":"verifies","source":"`+gt+`","target":"`+g1+`"}`, 201)
	a.ok("POST", "/api/links", `{"type":"verifies","source":"`+gt+`","target":"`+g1+`"}`, 409)
	rel := a.ok("GET", "/api/artifacts/"+g1+"/relationships", "", 200)
	if n := len(rel.body["incoming"].([]any)); n != 1 {
		t.Fatalf("incoming %d", n)
	}
	c := a.ok("POST", "/api/comments", `{"subject":"`+g1+`","text":"why?","author":"alice"}`, 201)
	a.ok("POST", "/api/comments", `{"subject":"`+g1+`","parent":"`+meta(c, "guid")+`","text":"because"}`, 201)
	a.ok("POST", "/api/comments", `{"subject":"`+g1+`","text":""}`, 400)
	cm := a.ok("GET", "/api/artifacts/"+g1+"/comments", "", 200)
	if n := len(cm.body["comments"].([]any)); n != 2 {
		t.Fatalf("comments %d", n)
	}
	ws := a.ok("GET", "/api/artifacts/"+g1+"/workflows", "", 200)
	if !strings.Contains(string(ws.raw), `"state":"open"`) {
		t.Fatalf("workflows %s", ws.raw)
	}
	a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"field":"status","transition":"approve"}`, 400) // not from this state
	a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"field":"status","transition":"review"}`, 400)  // a state is no transition
	a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"workflow":"dev","to":"review"}`, 400)          // the old form
	tr := a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"field":"status","transition":"submit"}`, 200)
	if !strings.Contains(string(tr.raw), `"status":{"state":"review","transition":"submit","previous":"open"}`) {
		t.Fatalf("transition %s", tr.raw)
	}
	a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"field":"status","transition":"approve"}`, 412, "If-Match", etag)
	// a workflow field is searched by its state
	if found := a.ok("GET", "/api/repository/search?field.status=review", "", 200); !strings.Contains(string(found.raw), g1) {
		t.Fatalf("search by state %s", found.raw)
	}

	// overlay analysis
	ov := a.ok("POST", "/api/entries", `{"path":"specs/boot","type":"requirement","title":"Variant","base":"`+g1+`","fields":{"priority":"low"}}`, 201)
	an := a.ok("GET", "/api/artifacts/"+meta(ov, "guid")+"/overlay", "", 200)
	if n := len(an.body["chain"].([]any)); n != 2 {
		t.Fatalf("overlay chain %d: %s", n, an.raw)
	}

	// attachments
	a.ok("PUT", "/api/artifacts/"+g1+"/files/notes.txt", "hello world", 204)
	f := a.ok("GET", "/api/artifacts/"+g1+"/files/notes.txt", "", 200)
	if f.hdr.Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
		t.Fatalf("attachments must be sandboxed, got CSP %q", f.hdr.Get("Content-Security-Policy"))
	}
	if string(f.raw) != "hello world" {
		t.Fatalf("attachment %q", f.raw)
	}
	a.ok("GET", "/api/artifacts/"+g1+"/files/missing.txt", "", 404)
	a.ok("PUT", "/api/artifacts/"+g1+"/files/.corestone.json", "x", 400)

	// search, tree, types, effective schema, history, hid lookup, validate, status
	s := a.ok("GET", "/api/repository/search?q=boot&kind=entry", "", 200)
	if s.body["total"].(float64) != 2 {
		t.Fatalf("search %s", s.raw)
	}
	s = a.ok("GET", "/api/repository/search?field.status=review", "", 200)
	if s.body["total"].(float64) != 1 {
		t.Fatalf("state search %s", s.raw)
	}
	s = a.ok("GET", "/api/repository/search?field.priority=low&path=specs", "", 200)
	if s.body["total"].(float64) != 1 {
		t.Fatalf("field search %s", s.raw)
	}
	a.ok("GET", "/api/repository/search?kind=blob", "", 400)
	tree := a.ok("GET", "/api/repository/tree", "", 200)
	if n := len(tree.body["folders"].([]any)); n != 3 { // docs, specs, tests
		t.Fatalf("tree %s", tree.raw)
	}
	tree = a.ok("GET", "/api/repository/tree?path=specs&subtree=1", "", 200)
	if n := len(tree.body["artifacts"].([]any)); n != 2 {
		t.Fatalf("subtree %s", tree.raw)
	}
	ty := a.ok("GET", "/api/repository/types?path=specs/boot", "", 200)
	if n := len(ty.body["types"].([]any)); n != 5 { // requirement, testcase, spec, verifies, comment
		t.Fatalf("types %s", ty.raw)
	}
	vals := a.ok("GET", "/api/repository/values?type=requirement&field=priority", "", 200)
	if vs := vals.body["values"].([]any); len(vs) == 0 || vs[0].(map[string]any)["count"].(float64) < 1 {
		t.Fatalf("values %s", vals.raw)
	}
	a.ok("GET", "/api/repository/values?type=requirement", "", 400)
	eff := a.ok("GET", "/api/schemas/effective?type=requirement&path=specs/boot", "", 200)
	if eff.body["displayName"] != "Requirement" {
		t.Fatalf("effective %s", eff.raw)
	}
	a.ok("GET", "/api/schemas/effective?type=nope", "", 404)
	so := a.ok("GET", "/api/artifacts/"+g1+"/schema", "", 200)
	if so.body["type"] != "requirement" {
		t.Fatalf("schemaOf %s", so.raw)
	}
	h := a.ok("GET", "/api/artifacts/"+g1+"/history", "", 200)
	if n := len(h.body["history"].([]any)); n < 5 {
		t.Fatalf("history %d", n)
	}
	a.ok("GET", "/api/repository/hids/REQ-1", "", 200)
	a.ok("GET", "/api/repository/hids/REQ-999", "", 404)
	v := a.ok("GET", "/api/repository/validate", "", 200)
	if v.body["errors"].(float64) != 0 {
		t.Fatalf("validate %s", v.raw)
	}
	st := a.ok("GET", "/api/repository", "", 200)
	if st.body["inSync"] != true {
		t.Fatalf("status %s", st.raw)
	}
	cfg := a.ok("GET", "/api/config", "", 200)
	if n := len(cfg.body["files"].([]any)); n != 6 {
		t.Fatalf("config files %s", cfg.raw)
	}
	a.ok("GET", "/api/workflows/dev?type=requirement&path=specs", "", 200)
	a.ok("GET", "/api/workflows/dev?type=spec&path=specs", "", 404) // entry workflows are not visible to document types
	a.ok("GET", "/api/workflows/nope?type=requirement", "", 404)

	// move artifact and folder
	mv := a.ok("POST", "/api/artifacts/"+g1+"/move", `{"path":"archive"}`, 200)
	if meta(mv, "folder") != "archive" {
		t.Fatalf("move %s", mv.raw)
	}
	a.ok("POST", "/api/artifacts/"+g1+"/move", `{"path":"../x"}`, 400)
	a.ok("POST", "/api/repository/folders/move", `{"from":"specs/boot","to":"specs/startup"}`, 200)
	a.ok("POST", "/api/repository/folders/move", `{"from":"specs","to":"specs/in"}`, 400)
	a.ok("POST", "/api/repository/folders/move", `{"from":"missing","to":"x"}`, 404)
	a.ok("POST", "/api/repository/maintenance/relocate-metadata", "", 200)

	// delete with wrong kind route, precondition, cascade, deleted listing
	a.ok("DELETE", "/api/documents/"+g1, "", 404)
	a.ok("DELETE", "/api/entries/"+g1, "", 412, "If-Match", `"deadbeef"`)
	a.ok("DELETE", "/api/entries/"+g1, "", 204)
	a.ok("GET", "/api/entries/"+g1, "", 404)
	a.ok("GET", "/api/links/"+meta(l, "guid"), "", 404)
	del := a.ok("GET", "/api/repository/deleted", "", 200)
	if n := len(del.body["deleted"].([]any)); n != 5 { // with the entry deleted from under a document above
		t.Fatalf("deleted %s", del.raw)
	}
	a.ok("DELETE", "/api/documents/"+gd, "", 204)
	a.ok("DELETE", "/api/config?path=documents/types.json", "", 200)
	a.ok("DELETE", "/api/config?path=documents/types.json", "", 404)
	dw := a.ok("DELETE", "/api/config?path=entries/workflows/dev-workflow.json", "", 200)
	if ws := dw.body["warnings"].([]any); len(ws) != 1 { // requirement still uses the workflow
		t.Fatalf("delete warnings %s", dw.raw)
	}

	// reindex is accepted and finishes
	a.ok("POST", "/api/repository/reindex", "", 202)
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := a.ok("GET", "/api/repository", "", 200)
		p := st.body["projection"].(map[string]any)
		if p["maintenance"] == false && st.body["inSync"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reindex did not finish: %s", st.raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestWebSocketSession(t *testing.T) {
	a := newAPI(t)
	a.seed()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(a.srv.URL, "http") + "/api/ws"
	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.CloseNow()
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()
	read := func(c *websocket.Conn) map[string]any {
		t.Helper()
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		return m
	}
	if h := read(c1); h["type"] != "hello" || h["status"] == nil {
		t.Fatalf("hello %v", h)
	}
	read(c2)
	// presence: c2 starts editing an artifact; c1 hears about it
	guid := "11111111-1111-4111-8111-111111111111"
	if err := c2.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","name":"bob"}`)); err != nil {
		t.Fatal(err)
	}
	if err := c2.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"edit","guid":%q,"on":true}`, guid))); err != nil {
		t.Fatal(err)
	}
	p := read(c1)
	if p["type"] != "presence" || p["guid"] != guid || fmt.Sprint(p["editors"]) != "[bob]" {
		t.Fatalf("presence %v", p)
	}
	// a commit is broadcast to every client
	a.ok("POST", "/api/entries", `{"path":"x","type":"requirement","title":"T","fields":{"priority":"low"}}`, 201)
	for _, c := range []*websocket.Conn{c1, c2} {
		var got map[string]any
		for i := 0; i < 5; i++ {
			got = read(c)
			if got["type"] == "commit" {
				break
			}
		}
		if got["type"] != "commit" || got["op"] != "create" || got["commit"] == "" {
			t.Fatalf("commit event %v", got)
		}
	}
}

func TestHealthReportsVersionAndDatabase(t *testing.T) {
	a := newAPI(t)
	a.s.Version = "test-build"
	r := a.ok("GET", "/api/health", "", 200)
	if r.body["status"] != "ok" || r.body["database"] != true || r.body["version"] != "test-build" {
		t.Fatalf("unexpected health body: %s", r.raw)
	}
	if r.hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("health must not be cached: %q", r.hdr.Get("Cache-Control"))
	}
}

func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	a := newAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(a.srv.URL, "http") + "/api/ws"
	_, res, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}})
	if err == nil {
		t.Fatal("cross-origin session was accepted")
	}
	if res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 for a foreign origin, got %v", res)
	}
	// Same-origin and explicitly allowed origins connect.
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {a.srv.URL}}})
	if err != nil {
		t.Fatalf("same-origin session refused: %v", err)
	}
	defer c.CloseNow()
	a.s.Hub.OriginPatterns = []string{"app.example.com"}
	c2, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://app.example.com"}}})
	if err != nil {
		t.Fatalf("allowed origin refused: %v", err)
	}
	defer c2.CloseNow()
}

func TestHubCloseEndsSessionsAndRefusesNewOnes(t *testing.T) {
	a := newAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(a.srv.URL, "http") + "/api/ws"
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if _, _, err := c.Read(ctx); err != nil { // hello
		t.Fatal(err)
	}
	a.s.Hub.Close()
	if _, _, err := c.Read(ctx); err == nil {
		t.Fatal("session survived hub close")
	}
	if _, _, err := websocket.Dial(ctx, url, nil); err == nil {
		t.Fatal("new session accepted after close")
	}
	if n := a.s.Hub.Clients(); n != 0 {
		t.Fatalf("clients after close: %d", n)
	}
}

func TestIcons(t *testing.T) {
	a := newAPI(t)
	a.seed()
	root := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>`
	lab := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>`
	a.ok("PUT", "/api/config?path=icons/testcase.svg", root, 200)
	a.ok("PUT", "/api/config?scope=lab&path=icons/testcase.svg", lab, 200)
	a.ok("PUT", "/api/config?path=icons/bad.svg", `<svg><script>alert(1)</script></svg>`, 400)
	a.ok("PUT", "/api/config?path=icons/bad%20name.svg", root, 400)

	// stored byte for byte, served as an inert image
	r := a.ok("GET", "/api/icons/testcase?path=specs/boot", "", 200)
	if string(r.raw) != root || r.hdr.Get("Content-Type") != "image/svg+xml" || !strings.Contains(r.hdr.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("root icon: %q %v", r.raw, r.hdr)
	}
	a.ok("GET", "/api/icons/testcase?path=specs/boot", "", 304, "If-None-Match", r.hdr.Get("ETag"))
	// a folder replaces it for itself and below
	if r := a.ok("GET", "/api/icons/testcase?path=lab/deep", "", 200); string(r.raw) != lab {
		t.Fatalf("lab icon: %q", r.raw)
	}
	if r := a.ok("GET", "/api/config?scope=lab&path=icons/testcase.svg", "", 200); r.hdr.Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("config read of an icon: %v", r.hdr)
	}
	a.ok("GET", "/api/icons/nope?path=lab", "", 404)
	a.ok("GET", "/api/icons/a.b?path=lab", "", 400)

	// a type naming an icon that does not exist is reported, not refused
	cw := a.ok("PUT", "/api/config?scope=lab&path=entries/types.json", `{"types":[{"id":"probe","presentation":{"icon":"ghost"}}]}`, 200)
	if !strings.Contains(string(cw.raw), `uses icon \"ghost\", which is not defined`) {
		t.Fatalf("warnings: %s", cw.raw)
	}
}

func TestKindWildcardLinkEndpoints(t *testing.T) {
	a := newAPI(t)
	a.seed()
	a.ok("PUT", "/api/config?path=links/types.json", `{"types":[{"id":"bogus","sourceTypes":["blob/*"]}]}`, 400)
	a.ok("PUT", "/api/config?path=links/types.json", `{"types":[
		{"id":"describes","sourceTypes":["document/*"],"targetTypes":["entries/*"]},
		{"id":"free","sourceTypes":["*"],"targetTypes":["*"]}]}`, 200)
	d1 := meta(a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"One"}`, 201), "guid")
	d2 := meta(a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"Two"}`, 201), "guid")
	e := meta(a.ok("POST", "/api/entries", `{"path":"docs","type":"testcase","title":"T"}`, 201), "guid")

	a.ok("POST", "/api/links", `{"type":"describes","source":"`+d1+`","target":"`+e+`"}`, 201)
	a.ok("POST", "/api/links", `{"type":"describes","source":"`+e+`","target":"`+d1+`"}`, 400)
	a.ok("POST", "/api/links", `{"type":"describes","source":"`+d1+`","target":"`+d2+`"}`, 400)
	a.ok("POST", "/api/links", `{"type":"free","source":"`+d1+`","target":"`+d2+`"}`, 201)

	rel := a.ok("GET", "/api/artifacts/"+d1+"/relationships", "", 200)
	var src []string
	for _, s := range rel.body["allowedAsSource"].([]any) {
		src = append(src, s.(map[string]any)["type"].(string))
	}
	if strings.Join(src, ",") != "describes,free" {
		t.Fatalf("link types a document may originate: %v", src)
	}
}

func TestTableQueryAndDetails(t *testing.T) {
	a := newAPI(t)
	a.seed()
	var reqs []string
	for _, prio := range []string{"high", "low", "high"} {
		r := a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"R","fields":{"priority":"`+prio+`","rationale":"why"}}`, 201)
		reqs = append(reqs, meta(r, "guid"))
	}
	tc := meta(a.ok("POST", "/api/entries", `{"path":"specs","type":"testcase","title":"T"}`, 201), "guid")
	l := meta(a.ok("POST", "/api/links", `{"type":"verifies","source":"`+tc+`","target":"`+reqs[0]+`"}`, 201), "guid")
	c := meta(a.ok("POST", "/api/comments", `{"type":"comment","subject":"`+l+`","text":"ok"}`, 201), "guid")

	ids := func(r resp) []string {
		var out []string
		for _, id := range r.body["ids"].([]any) {
			out = append(out, id.(string))
		}
		return out
	}
	// REQ-1 high, REQ-2 low, REQ-3 high: low before high, then ID descending
	r := a.ok("POST", "/api/repository/query", `{"filter":{"kind":["entry"],"type":"requirement"},
		"sort":["priority","~$hid"]}`, 200)
	if got := ids(r); !slices.Equal(got, []string{reqs[1], reqs[2], reqs[0]}) || r.body["total"] != float64(3) || r.body["truncated"] != false {
		t.Fatalf("query: %s", r.raw)
	}
	r = a.ok("POST", "/api/repository/query", `{"filter":{"kind":["entry"]},"limit":1}`, 200)
	if len(ids(r)) != 1 || r.body["total"] != float64(4) || r.body["truncated"] != true {
		t.Fatalf("truncated query: %s", r.raw)
	}
	if r = a.ok("POST", "/api/repository/query", ``, 200); r.body["total"] != float64(6) {
		t.Fatalf("unfiltered query: %s", r.raw)
	}
	if r = a.ok("POST", "/api/repository/query", `{"filter":{"types":["testcase","links/*"]}}`, 200); r.body["total"] != float64(2) {
		t.Fatalf("types filter: %s", r.raw)
	}
	if r = a.ok("POST", "/api/repository/query", `{"filter":{"kind":["entry"],"types":["*"]}}`, 200); r.body["total"] != float64(4) {
		t.Fatalf("types wildcard: %s", r.raw)
	}
	a.ok("POST", "/api/repository/query", `{"sort":["$nope"]}`, 400)
	a.ok("POST", "/api/repository/query", `{"sort":[{"col":"$hid","dir":"desc"}]}`, 400) // the old form
	a.ok("POST", "/api/repository/query", `{"filter":{"kind":["nope"]}}`, 400)
	a.ok("POST", "/api/repository/query", `{"filter":{"path":"../x"}}`, 400)
	a.ok("POST", "/api/repository/query", `[`, 400)

	// rows in request order with only the requested fields; endpoints,
	// subjects and the endpoints of link subjects come along
	d := a.ok("POST", "/api/artifacts/details", `{"ids":["`+c+`","00000000-0000-4000-8000-000000000000","`+reqs[1]+`"],"columns":["$hid","priority"]}`, 200)
	rows := d.body["artifacts"].([]any)
	if len(rows) != 2 || rows[0].(map[string]any)["guid"] != c {
		t.Fatalf("details: %s", d.raw)
	}
	if f := rows[1].(map[string]any)["fields"].(map[string]any); len(f) != 1 || f["priority"] != "low" {
		t.Fatalf("details fields: %s", d.raw)
	}
	if names := d.body["typeNames"].(map[string]any)["specs"].(map[string]any); names["requirement"] != "Requirement" || names["testcase"] != "testcase" {
		t.Fatalf("type names: %s", d.raw)
	}
	related := d.body["related"].(map[string]any)
	for _, g := range []string{l, tc, reqs[0]} {
		if related[g] == nil {
			t.Fatalf("related %s missing: %s", g, d.raw)
		}
	}
	// the State column brings the workflow fields along
	st := a.ok("POST", "/api/artifacts/details", `{"ids":["`+reqs[1]+`"],"columns":["$state"]}`, 200)
	if f := st.body["artifacts"].([]any)[0].(map[string]any)["fields"].(map[string]any); len(f) != 1 || f["status"].(map[string]any)["state"] != "open" {
		t.Fatalf("details for the State column: %s", st.raw)
	}
	all := a.ok("POST", "/api/artifacts/details", `{"ids":["`+reqs[1]+`"]}`, 200)
	if f := all.body["artifacts"].([]any)[0].(map[string]any)["fields"].(map[string]any); len(f) != 3 { // priority, rationale, status
		t.Fatalf("details without columns: %s", all.raw)
	}
	many := `"` + strings.Repeat(reqs[0]+`","`, 500) + reqs[0] + `"`
	a.ok("POST", "/api/artifacts/details", `{"ids":[`+many+`]}`, 400)
}

func TestSaveEndpoint(t *testing.T) {
	a := newAPI(t)
	a.seed()
	r := a.ok("POST", "/api/entries", `{"path":"reqs","type":"requirement","title":"R","fields":{"priority":"low"}}`, 201)
	g, etag := meta(r, "guid"), r.hdr.Get("ETag")
	tc := meta(a.ok("POST", "/api/entries", `{"path":"tests","type":"testcase","title":"T"}`, 201), "guid")

	a.ok("POST", "/api/artifacts/"+g+"/save", `{"patch":{"title":"x"}}`, 412, "If-Match", `"stale"`)
	a.ok("POST", "/api/artifacts/"+g+"/save", `{"patch":{"title":"x"},"transitions":[{"field":"status","transition":"approve"}]}`, 400, "If-Match", etag)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("changes", `{"patch":{"title":"Saved"},"transitions":[{"field":"status","transition":"submit"}],
		"addLinks":[{"type":"verifies","source":"`+tc+`","target":"`+g+`"}],"addComments":[{"author":"ann","text":"hi"}]}`)
	fw, _ := mw.CreateFormFile("file", "notes.txt")
	_, _ = fw.Write([]byte("hello"))
	_ = mw.Close()
	s := a.ok("POST", "/api/artifacts/"+g+"/save", body.String(), 200, "If-Match", etag, "Content-Type", mw.FormDataContentType())
	if s.hdr.Get("ETag") == etag || s.body["data"].(map[string]any)["title"] != "Saved" {
		t.Fatalf("save: %s", s.raw)
	}
	if f := a.ok("GET", "/api/artifacts/"+g+"/files/notes.txt", "", 200); string(f.raw) != "hello" {
		t.Fatalf("attachment %q", f.raw)
	}
	h := a.ok("GET", "/api/artifacts/"+g+"/history", "", 200)
	if !strings.Contains(string(h.raw), "1 link added, 1 comment added, 1 attachment stored") {
		t.Fatalf("history: %s", h.raw)
	}
}

func TestSaveUploadLimits(t *testing.T) {
	a := newAPI(t)
	a.seed()
	r := a.ok("POST", "/api/entries", `{"path":"reqs","type":"requirement","title":"R","fields":{"priority":"low"}}`, 201)
	g := meta(r, "guid")
	upload := func(sizes map[string]int) (string, string) {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		_ = mw.WriteField("changes", `{}`)
		for name, n := range sizes {
			fw, _ := mw.CreateFormFile("file", name)
			_, _ = fw.Write(bytes.Repeat([]byte{'x'}, n))
		}
		_ = mw.Close()
		return body.String(), mw.FormDataContentType()
	}

	// Several files may together exceed the limit of one attachment.
	b, ct := upload(map[string]int{"a.bin": 20 << 20, "b.bin": 20 << 20})
	a.ok("POST", "/api/artifacts/"+g+"/save", b, 200, "Content-Type", ct)

	// A single file over the limit is named.
	b, ct = upload(map[string]int{"huge.bin": maxAttachment + 1})
	if res := a.ok("POST", "/api/artifacts/"+g+"/save", b, 413, "Content-Type", ct); !strings.Contains(string(res.raw), "huge.bin") {
		t.Fatalf("too large: %s", res.raw)
	}
}

func TestSaveMergesAndReportsConflicts(t *testing.T) {
	a := newAPI(t)
	a.seed()
	r := a.ok("POST", "/api/entries", `{"path":"reqs","type":"requirement","title":"R","fields":{"priority":"low"}}`, 201)
	g, base := meta(r, "guid"), r.hdr.Get("ETag")
	a.ok("PUT", "/api/artifacts/"+g, `{"title":"Theirs"}`, 200)

	// Different things: merged.
	a.ok("POST", "/api/artifacts/"+g+"/save", `{"patch":{"fields":{"rationale":"why"}}}`, 200, "If-Match", base)
	// The same thing: 412 with what overlaps; overwriting that version saves.
	c := a.ok("POST", "/api/artifacts/"+g+"/save", `{"patch":{"title":"Mine"}}`, 412, "If-Match", base)
	conflicts, _ := c.body["conflicts"].([]any)
	if len(conflicts) != 1 || conflicts[0].(map[string]any)["key"] != "title" || conflicts[0].(map[string]any)["theirs"] != "Theirs" {
		t.Fatalf("conflict: %s", c.raw)
	}
	s := a.ok("POST", "/api/artifacts/"+g+"/save", `{"patch":{"title":"Mine"},"overwrite":"`+c.body["etag"].(string)+`"}`, 200, "If-Match", base)
	if s.body["data"].(map[string]any)["title"] != "Mine" {
		t.Fatalf("overwrite: %s", s.raw)
	}

	// A removed link is checked against the version the client saw.
	tc := meta(a.ok("POST", "/api/entries", `{"path":"tests","type":"testcase","title":"T"}`, 201), "guid")
	l := a.ok("POST", "/api/links", `{"type":"verifies","source":"`+tc+`","target":"`+g+`"}`, 201)
	lg, le := meta(l, "guid"), strings.Trim(l.hdr.Get("ETag"), `"`)
	a.ok("PUT", "/api/artifacts/"+lg, `{"note":"changed"}`, 200)
	a.ok("POST", "/api/artifacts/"+g+"/save", `{"removeLinks":[{"guid":"`+lg+`","etag":"`+le+`"}]}`, 412)
	a.ok("POST", "/api/artifacts/"+g+"/save", `{"removeLinks":["`+lg+`"]}`, 200)
}

// A document's save creates the entries made in it: in the same commit, with
// GUIDs from the server put into the content; a new entry that does not
// check out refuses the whole save.
func TestSaveCreatesEntries(t *testing.T) {
	a := newAPI(t)
	a.seed()
	d := a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"Doc","content":[{"text":"Intro"}]}`, 201)
	g, etag := meta(d, "guid"), d.hdr.Get("ETag")
	save := func(changes string, code int, files ...string) resp {
		t.Helper()
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		_ = mw.WriteField("changes", changes)
		for i := 0; i+1 < len(files); i += 2 {
			fw, _ := mw.CreateFormFile(files[i], files[i+1])
			_, _ = fw.Write([]byte("png"))
		}
		_ = mw.Close()
		return a.ok("POST", "/api/artifacts/"+g+"/save", body.String(), code, "Content-Type", mw.FormDataContentType())
	}
	content := `"content":[{"text":"Intro"},{"entry":"new:a"},{"text":[{"text":"see ","ref":"new:a","xref":true}]}]`

	// refused: a required field is missing; the document and the repository stay as they were
	bad := save(`{"patch":{`+content+`},"addEntries":[{"key":"new:a","type":"requirement","title":"Lacks priority"}]}`, 400)
	if msg := string(bad.raw); !strings.Contains(msg, `new entry \"Lacks priority\"`) || !strings.Contains(msg, "priority") {
		t.Fatalf("refusal: %s", bad.raw)
	}
	if r := a.ok("GET", "/api/repository/search?q=Lacks&kind=entry", "", 200); r.body["total"].(float64) != 0 {
		t.Fatalf("a refused save left an entry: %s", r.raw)
	}
	if r := a.ok("GET", "/api/documents/"+g, "", 200); r.hdr.Get("ETag") != etag {
		t.Fatalf("a refused save changed the document")
	}
	// refused: a new entry the content does not use, a key the content uses without its entry,
	// files for no new entry, a bad key, new entries with an entry
	save(`{"patch":{"content":[{"text":"x"}]},"addEntries":[{"key":"new:a","type":"requirement","title":"A","fields":{"priority":"low"}}]}`, 400)
	save(`{"patch":{`+content+`}}`, 400)
	save(`{"patch":{`+content+`},"addEntries":[{"key":"new:a","type":"requirement","title":"A","fields":{"priority":"low"}}]}`, 400, "entryfile:new:b", "x.png")
	save(`{"patch":{"content":[{"entry":"new:a b"}]},"addEntries":[{"key":"new:a b","type":"requirement","title":"A","fields":{"priority":"low"}}]}`, 400)
	e := a.ok("POST", "/api/entries", `{"path":"reqs","type":"requirement","title":"R","fields":{"priority":"low"}}`, 201)
	a.ok("POST", "/api/artifacts/"+meta(e, "guid")+"/save", `{"addEntries":[{"key":"new:a","type":"requirement","title":"A","fields":{"priority":"low"}}]}`, 400)

	// saved: the entry in the document's folder (no path given), its file, the GUID in placement and reference
	ok := save(`{"patch":{`+content+`},"addEntries":[{"key":"new:a","type":"requirement","title":"Made here","fields":{"priority":"low"}}]}`, 200,
		"entryfile:new:a", "dot.png")
	guid, _ := ok.body["created"].(map[string]any)["new:a"].(string)
	if len(guid) != 36 {
		t.Fatalf("created: %s", ok.raw)
	}
	stored := a.ok("GET", "/api/documents/"+g, "", 200)
	if raw := string(stored.raw); strings.Contains(raw, "new:a") || !strings.Contains(raw, `"entry":"`+guid+`"`) || !strings.Contains(raw, `"ref":"`+guid+`"`) {
		t.Fatalf("content: %s", stored.raw)
	}
	ent := a.ok("GET", "/api/entries/"+guid, "", 200)
	if meta(ent, "title") != "Made here" || meta(ent, "folder") != "docs" {
		t.Fatalf("entry: %s", ent.raw)
	}
	if f := a.ok("GET", "/api/artifacts/"+guid+"/files/dot.png", "", 200); string(f.raw) != "png" {
		t.Fatalf("entry file %q", f.raw)
	}
	// one commit: the entry's creation is the document's save
	dh := a.ok("GET", "/api/artifacts/"+g+"/history", "", 200)
	eh := a.ok("GET", "/api/artifacts/"+guid+"/history", "", 200)
	first := func(r resp) map[string]any { return r.body["history"].([]any)[0].(map[string]any) }
	if !strings.Contains(string(dh.raw), "1 entry added") || first(dh)["commit"] != first(eh)["commit"] || len(eh.body["history"].([]any)) != 1 {
		t.Fatalf("history: document %s\nentry %s", dh.raw, eh.raw)
	}
}

// The check answers whether an entry could be created, without creating it.
func TestCheckEntry(t *testing.T) {
	a := newAPI(t)
	a.seed()
	before := a.ok("GET", "/api/repository", "", 200).raw
	r := a.ok("POST", "/api/entries/check", `{"path":"reqs","type":"requirement","title":"Fine","fields":{"priority":"low"}}`, 200)
	if r.body["ok"] != true || len(r.body["problems"].([]any)) != 0 {
		t.Fatalf("a valid entry: %s", r.raw)
	}
	r = a.ok("POST", "/api/entries/check", `{"path":"reqs","type":"requirement","title":"Lacks"}`, 200)
	if p := r.body["problems"].([]any); r.body["ok"] != false || len(p) != 1 || !strings.Contains(p[0].(string), "priority") {
		t.Fatalf("a missing required field: %s", r.raw)
	}
	r = a.ok("POST", "/api/entries/check", `{"path":"reqs","type":"nosuchtype","title":"X"}`, 200)
	if r.body["ok"] != false {
		t.Fatalf("an unknown type: %s", r.raw)
	}
	// nothing was created
	if s := a.ok("GET", "/api/repository/search?q=Fine&kind=entry", "", 200); s.body["total"].(float64) != 0 {
		t.Fatalf("the check created an entry: %s", s.raw)
	}
	if after := a.ok("GET", "/api/repository", "", 200).raw; string(after) != string(before) {
		t.Fatalf("the check changed the repository:\n%s\n%s", before, after)
	}
	a.ok("POST", "/api/documents/check", `{"path":"docs","type":"spec","title":"D"}`, 200)
	a.ok("POST", "/api/entries/check", `not json`, 400)
}

// A dynamic enumeration offers artifacts as its options: a value is the
// artifact's GUID, checked when it is chosen.
func TestDynamicEnum(t *testing.T) {
	a := newAPI(t)
	a.seed()
	a.ok("PUT", "/api/config?path=entries/product-fields.json", `{"fields":[{"id":"rank","type":"integer"}]}`, 200)
	a.ok("PUT", "/api/config?path=entries/types.json", `{"types":[
		{"id":"requirement","hid":{"prefix":"REQ"},"fields":[{"id":"priority","required":true},"rationale","status"]},
		{"id":"testcase","hid":{"prefix":"TC"}},{"id":"product","hid":{"prefix":"P"}}]}`, 200)
	source := `"source":{"kind":"entry","types":["product"],"query":"rank>1","sort":["~rank","title"]}`
	for _, bad := range []string{
		`{"id":"product","type":"text",` + source + `}`,                                // only enumerations
		`{"id":"product","type":"enum","options":[{"value":"a"}],` + source + `}`,      // a source replaces options
		`{"id":"product","type":"enum","source":{"kind":"link","types":["verifies"]}}`, // entries and documents only
		`{"id":"product","type":"enum","source":{"kind":"entry","types":[]}}`,          // no type
		`{"id":"product","type":"enum","source":{"kind":"entry","types":["product"],"sort":["rank desc"]}}`,
		`{"id":"product","type":"enum","source":{"kind":"entry","types":["product"],"sort":["~"]}}`,
		`{"id":"product","type":"enum","source":{"kind":"entry","types":["product"],"sort":[{"col":"rank","dir":"desc"}]}}`, // the old form
	} {
		a.ok("PUT", "/api/config?path=documents/fields.json", `{"fields":[`+bad+`]}`, 400)
	}
	a.ok("PUT", "/api/config?path=documents/fields.json", `{"fields":[{"id":"product","name":"Belongs to product","type":"enum",`+source+`},
		{"id":"also","type":"enum","multiple":true,"source":{"kind":"entry","types":["product"]}},
		{"id":"reversed","type":"enum","source":{"kind":"entry","types":["product"],"sort":["~title"]}}]}`, 200)
	a.ok("PUT", "/api/config?path=documents/types.json", `{"types":[{"id":"spec","fields":["product","also","reversed"]}]}`, 200)

	product := func(title string, rank int) string {
		return meta(a.ok("POST", "/api/entries", fmt.Sprintf(`{"path":"products","type":"product","title":%q,"fields":{"rank":%d}}`, title, rank), 201), "guid")
	}
	beta, alpha, gamma := product("Beta", 2), product("Alpha", 3), product("Gamma", 1)
	req := meta(a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"R","fields":{"priority":"low"}}`, 201), "guid")

	// the options: every product, in the source's order (rank descending); the second field by title
	titles := func(field string) string {
		var out []string
		for _, o := range a.ok("GET", "/api/repository/options?type=spec&path=docs&field="+field, "", 200).body["options"].([]any) {
			out = append(out, o.(map[string]any)["title"].(string))
		}
		return strings.Join(out, " ")
	}
	if got := titles("product"); got != "Alpha Beta Gamma" {
		t.Fatalf("options by rank: %s", got)
	}
	if got := titles("also"); got != "Alpha Beta Gamma" {
		t.Fatalf("options by title: %s", got)
	}
	if got := titles("reversed"); got != "Gamma Beta Alpha" {
		t.Fatalf("options by ~title: %s", got)
	}
	a.ok("PUT", "/api/entries/"+gamma, `{"title":"A first"}`, 200)
	if got := titles("also"); got != "A first Alpha Beta" {
		t.Fatalf("options by title after a rename: %s", got)
	}
	a.ok("GET", "/api/repository/options?type=spec&path=docs&field=nope", "", 404)
	a.ok("GET", "/api/repository/options?type=requirement&path=specs&field=priority", "", 404)

	// a value is the GUID of an option
	doc := func(title, fields string, status int) string {
		return meta(a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"`+title+`","fields":`+fields+`}`, status), "guid")
	}
	doc("no guid", `{"product":"Beta"}`, 400)
	doc("no option", `{"product":"`+req+`"}`, 400)
	doc("missing", `{"product":"00000000-0000-4000-8000-000000000000"}`, 400)
	doc("one of several is no option", `{"also":["`+alpha+`","`+req+`"]}`, 400)
	dB := doc("For Beta", `{"product":"`+beta+`","also":["`+alpha+`","`+gamma+`"]}`, 201)
	dA := doc("For Alpha", `{"product":"`+alpha+`"}`, 201)

	// found by the value, and sorted by the chosen artifact's title
	if found := a.ok("GET", "/api/repository/search?kind=document&field.product="+beta, "", 200); found.body["total"] != float64(1) {
		t.Fatalf("search by product: %s", found.raw)
	}
	r := a.ok("POST", "/api/repository/query", `{"filter":{"kind":["document"],"type":"spec"},"sort":["product"]}`, 200)
	if got := r.body["ids"].([]any); len(got) != 2 || got[0] != dA || got[1] != dB {
		t.Fatalf("sorted by product: %s", r.raw)
	}

	// a product deleted later: the value stays and other edits still work; it cannot be chosen again
	a.ok("DELETE", "/api/entries/"+beta, "", 204)
	a.ok("PUT", "/api/documents/"+dB, `{"title":"Still for Beta"}`, 200)
	a.ok("PUT", "/api/documents/"+dA, `{"fields":{"product":"`+beta+`"}}`, 400)
	if got := titles("product"); got != "Alpha A first" {
		t.Fatalf("options after a delete: %s", got)
	}
}

// The search's sort names a column; "~" in front sorts descending.
func TestSearchSortDirection(t *testing.T) {
	a := newAPI(t)
	a.seed()
	for _, title := range []string{"Bravo", "Alpha", "Charlie"} { // REQ-1, REQ-2, REQ-3, created in this order
		a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"`+title+`","fields":{"priority":"low"}}`, 201)
	}
	titles := func(sort string) string {
		var out []string
		for _, s := range a.ok("GET", "/api/repository/search?kind=entry&sort="+sort, "", 200).body["artifacts"].([]any) {
			out = append(out, s.(map[string]any)["title"].(string))
		}
		return strings.Join(out, " ")
	}
	for sort, want := range map[string]string{
		"title": "Alpha Bravo Charlie", "~title": "Charlie Bravo Alpha",
		"hid": "Bravo Alpha Charlie", "~hid": "Charlie Alpha Bravo",
		"created": "Bravo Alpha Charlie", "~created": "Charlie Alpha Bravo",
		"modified": "Bravo Alpha Charlie", "~modified": "Charlie Alpha Bravo", "": "Charlie Alpha Bravo",
	} {
		if got := titles(sort); got != want {
			t.Errorf("sort=%s: %s, want %s", sort, got, want)
		}
	}
	for _, bad := range []string{"nope", "~", "~~title", "title%20desc"} {
		a.ok("GET", "/api/repository/search?sort="+bad, "", 400)
	}
}
