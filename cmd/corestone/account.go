package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/thomdehoog/corestone/internal/accounts"
)

const accountUsage = `usage: corestone account add -name NAME -email EMAIL [-file FILE]

Creates an account entry with a hashed password. The password is asked for
without echo on a terminal, or read from the first line of standard input
when piped:

  corestone account add -name "Ada" -email ada@example.org -file data/accounts.json
  echo "$PASSWORD" | corestone account add -name "Ada" -email ada@example.org

With -file the account is added to that accounts file (a running server
picks it up); without, the JSON entry is printed for pasting into one.
Roles are not set here: admins are listed in the repository's
.corestone/access.json.
`

// accountCommand runs `corestone account ...` and returns the exit code.
func accountCommand(args []string, stdin *os.File, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "add" {
		fmt.Fprint(stderr, accountUsage)
		return 2
	}
	fs := flag.NewFlagSet("corestone account add", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, accountUsage) }
	name := fs.String("name", "", "visible name")
	email := fs.String("email", "", "email address, used to sign in")
	file := fs.String("file", "", "accounts file to add the account to (default: print the entry)")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if fs.NArg() > 0 || *name == "" || *email == "" {
		fs.Usage()
		return 2
	}
	password, err := readPassword(stdin, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "corestone: %v\n", err)
		return 1
	}
	rec, err := accounts.NewRecord(*name, *email, password, 0)
	if err != nil {
		fmt.Fprintf(stderr, "corestone: %v\n", err)
		return 1
	}
	if *file == "" {
		out, _ := json.MarshalIndent(rec, "", "  ")
		fmt.Fprintln(stdout, string(out))
		return 0
	}
	err = accounts.File{Path: *file}.Update(func(recs []accounts.Record) ([]accounts.Record, error) {
		return accounts.Add(recs, rec)
	})
	if err != nil {
		fmt.Fprintf(stderr, "corestone: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "added %s <%s> as %s to %s\n", rec.Name, rec.Email, rec.GUID, *file)
	return 0
}

// readPassword asks twice without echo on a terminal; otherwise it reads the
// first line of the input (without its line ending).
func readPassword(in *os.File, prompt io.Writer) (string, error) {
	if term.IsTerminal(int(in.Fd())) {
		fmt.Fprint(prompt, "Password: ")
		pw, err := term.ReadPassword(int(in.Fd()))
		fmt.Fprintln(prompt)
		if err != nil {
			return "", err
		}
		fmt.Fprint(prompt, "Repeat password: ")
		again, err := term.ReadPassword(int(in.Fd()))
		fmt.Fprintln(prompt)
		if err != nil {
			return "", err
		}
		if string(pw) != string(again) {
			return "", errors.New("the passwords differ")
		}
		return string(pw), nil
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return "", errors.New("no password on standard input")
	}
	return line, nil
}
