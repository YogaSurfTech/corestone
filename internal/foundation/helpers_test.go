package foundation

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/ojson"
)

type ojsonObject = ojson.Object

func parseObject(s string) (*ojson.Object, error) { return ojson.ParseObject([]byte(s)) }

func must(o *ojson.Object, err error) *ojson.Object {
	if err != nil {
		panic(err)
	}
	return o
}

func assertHistoryIndexed(t *testing.T, f *Foundation, guids ...string) {
	t.Helper()
	ctx := context.Background()
	if !f.DB.Status().Capabilities.History {
		t.Fatal("history index not available")
	}
	for _, guid := range guids {
		indexed, err := f.History(ctx, guid, 0)
		if err != nil {
			t.Fatalf("indexed history of %s: %v", guid, err)
		}
		scanned, err := f.scanHistory(ctx, guid, 0)
		if err != nil {
			t.Fatalf("scanned history of %s: %v", guid, err)
		}
		// The index also holds the commits of links touching the artifact,
		// which a path scan cannot find: apart from those, both agree.
		var own []gitx.LogEntry
		for _, e := range indexed {
			if g := e.Trailers["Corestone-Guid"]; g != "" && g != guid && !slices.ContainsFunc(scanned, func(s gitx.LogEntry) bool { return s.SHA == e.SHA }) {
				continue
			}
			own = append(own, e)
		}
		if len(indexed) == 0 || !reflect.DeepEqual(own, scanned) {
			t.Fatalf("history of %s differs:\nindexed: %+v\nscanned: %+v", guid, indexed, scanned)
		}
	}
}
