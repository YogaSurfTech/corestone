package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/accounts"
)

// run calls the command with input piped to standard input.
func run(t *testing.T, input string, args ...string) (int, string, string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = w.WriteString(input); w.Close() }()
	defer r.Close()
	var out, errOut bytes.Buffer
	code := accountCommand(args, r, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestAccountAdd(t *testing.T) {
	// without -file: the entry is printed
	code, out, errOut := run(t, "s3cret\n", "add", "-name", "Ada", "-email", "ada@example.org")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	var rec accounts.Record
	if err := json.Unmarshal([]byte(out), &rec); err != nil || rec.Email != "ada@example.org" || !strings.HasPrefix(rec.Password, "pbkdf2-sha256$") || strings.Contains(out, "s3cret") {
		t.Fatalf("entry %s %v", out, err)
	}

	// with -file: added to the file, which a server reads
	file := filepath.Join(t.TempDir(), "accounts.json")
	if code, _, errOut := run(t, "pw-one\r\n", "add", "-name", "Ada", "-email", "ada@example.org", "-file", file); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if code, _, _ := run(t, "pw-two", "add", "-name", "Bob", "-email", "bob@example.org", "-file", file); code != 0 {
		t.Fatal("second account")
	}
	recs, err := accounts.File{Path: file}.Read()
	if err != nil || len(recs) != 2 || recs[1].Name != "Bob" {
		t.Fatalf("file %+v %v", recs, err)
	}

	// refused: a taken email, no password, missing flags
	if code, _, errOut := run(t, "x\n", "add", "-name", "Ada 2", "-email", "ADA@example.org", "-file", file); code != 1 || !strings.Contains(errOut, "exists already") {
		t.Fatalf("duplicate email: %d %s", code, errOut)
	}
	if code, _, errOut := run(t, "", "add", "-name", "Cy", "-email", "cy@example.org"); code != 1 || !strings.Contains(errOut, "no password") {
		t.Fatalf("empty input: %d %s", code, errOut)
	}
	if code, _, _ := run(t, "x\n", "add", "-name", "Cy"); code != 2 {
		t.Fatal("missing email accepted")
	}
	if code, _, _ := run(t, "", "remove"); code != 2 {
		t.Fatal("unknown subcommand accepted")
	}
}
