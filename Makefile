# Corestone — build, test and run.
#
#   make build            build web/dist and bin/corestone
#   make test             go vet, gofmt gate, unit tests (PostgreSQL-backed tests need CORESTONE_TEST_DSN)
#   make test-ui          Playwright browser tests against a temporary server (needs CORESTONE_TEST_DSN)
#   make test-ui-auth     Playwright sign-in tests against a temporary server with -auth local
#   make e2e              REST end-to-end script against a temporary server (needs CORESTONE_TEST_DSN)
#   make lint             golangci-lint (https://golangci-lint.run) over the Go code
#   make run              serve http://127.0.0.1:8080 (needs CORESTONE_DB; AUTH=none skips signing in)
#   make docker           build the container image (tag corestone:$(VERSION))
.PHONY: build web test test-ui test-ui-all test-ui-auth lint e2e fuzz run docker clean

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

CORESTONE_TEST_DSN ?= postgres://postgres:postgres@127.0.0.1:5432/corestone_test?sslmode=disable
# Servers started by e2e/test-ui use their own database: two servers with different
# repositories must never share one projection database.
CORESTONE_E2E_DSN ?= postgres://postgres:postgres@127.0.0.1:5432/corestone_e2e?sslmode=disable
CORESTONE_DB ?= postgres://postgres:postgres@127.0.0.1:5432/corestone?sslmode=disable
# Sign-in for `make run`: local (accounts) or none (open, for development).
AUTH ?= local
export CORESTONE_TEST_DSN

build: web
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/corestone ./cmd/corestone

web:
	cd web && npm install --no-audit --no-fund && npm run typecheck && npm run build

test:
	go vet ./...
	test -z "$$(gofmt -l .)"
	go test -race ./...

lint:
	golangci-lint run ./...

fuzz:
	go test -run xxx -fuzz FuzzRoundTrip   -fuzztime 20s ./internal/ojson/
	go test -run xxx -fuzz FuzzCleanFolder -fuzztime 20s ./internal/model/
	go test -run xxx -fuzz FuzzClassify    -fuzztime 20s ./internal/scanner/

# Starts a throwaway server (fresh bare repo, the test database), runs the
# given command against it, and stops it again. The fourth argument is the
# sign-in mode (default none, so the suites need no account).
define with_server
	rm -rf /tmp/corestone-$(1).git /tmp/corestone-$(1).accounts.json*; \
	./bin/corestone -repo /tmp/corestone-$(1).git -addr 127.0.0.1:$(2) -web web/dist -db "$(CORESTONE_E2E_DSN)" \
	  -auth $(or $(4),none) -accounts /tmp/corestone-$(1).accounts.json > /tmp/corestone-$(1).log 2>&1 & pid=$$!; \
	for i in $$(seq 1 50); do curl -sf http://127.0.0.1:$(2)/api/health >/dev/null && break; sleep 0.2; done; \
	$(3); status=$$?; \
	kill $$pid 2>/dev/null; rm -rf /tmp/corestone-$(1).git /tmp/corestone-$(1).accounts.json*; exit $$status
endef

e2e: build
	$(call with_server,e2e,18099,./scripts/e2e.sh http://127.0.0.1:18099)

test-ui: build
	$(call with_server,ui,18090,cd web && CORESTONE_URL=http://127.0.0.1:18090 npx playwright test tests/ui.spec.ts)

# The complete browser suite (fields, documents, navigation, relations,
# collaboration, adversarial); slower than test-ui.
test-ui-all: build
	$(call with_server,ui,18090,cd web && CORESTONE_URL=http://127.0.0.1:18090 npx playwright test)

# Sign-in tests: a fresh accounts file starts with the "create the first account" page.
test-ui-auth: build
	$(call with_server,auth,18091,cd web && CORESTONE_AUTH_URL=http://127.0.0.1:18091 npx playwright test tests/auth.spec.ts,local)

run: build
	./bin/corestone -repo data/corestone.git -addr 127.0.0.1:8080 -web web/dist -db "$(CORESTONE_DB)" -auth $(AUTH)

docker:
	docker build --build-arg VERSION=$(VERSION) -t corestone:$(VERSION) .

clean:
	rm -rf bin web/dist web/node_modules web/test-results web/playwright-report web/shots
