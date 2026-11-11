//go:build !unix

package accounts

import "sync"

var fileMu sync.Mutex

// lockFile serializes writers within this process only.
func lockFile(string) (func(), error) {
	fileMu.Lock()
	return fileMu.Unlock, nil
}
