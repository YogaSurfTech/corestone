#!/usr/bin/env bash
# Seeds a running corestone with two domains, configured as described in
# docs/CONFIGURATION.md:
#
#  - a requirements domain at the root: workflows, entry/document/link/comment
#    types with shared and type-specific fields and enumerations, a subtree
#    (specs/safety) that refines the requirement type, entries with overlays,
#    a document composed of entry references, links and comments;
#  - the dogfooding task tracker in corestone_tasks/, whose entry types are
#    cut off from the root (only tasks there) while links and comments are
#    still inherited.
#
# The predefined icons of examples/icons are stored in the root configuration,
# so every folder can use them; every type selects one.
#
#   ./examples/seed.sh [http://127.0.0.1:8080]
set -euo pipefail
API=${1:-http://127.0.0.1:8080}/api

post() { curl -sfS -X POST "$API/$1" -H 'Content-Type: application/json' -d "$2"; }
# cfg <folder> <path below .corestone/config> <file content>
cfg()  { curl -sfS -X PUT "$API/config?scope=$1&path=$2" -H 'Content-Type: application/json' -d "$3" >/dev/null; }
# icon <folder> <file.svg>: stores an icon as .corestone/config/icons/<file.svg>
icon() { curl -sfS -X PUT "$API/config?scope=$1&path=icons/$(basename "$2")" -H 'Content-Type: image/svg+xml' --data-binary @"$2" >/dev/null; }
guid() { python3 -c 'import json,sys; print(json.load(sys.stdin)["meta"]["guid"])'; }

# ---- root configuration ------------------------------------------------------

for f in "$(dirname "$0")"/icons/*.svg; do icon "" "$f"; done

DEV='{"name":"Development","initial":"open",
  "states":[{"id":"open","name":"Open"},{"id":"review","name":"In review","color":"#b7791f"},{"id":"done","name":"Done","color":"#1f9d55"}],
  "transitions":[{"id":"submit","name":"Submit for review","from":"open","to":"review"},
                 {"id":"approve","name":"Approve","from":"review","to":"done"},
                 {"id":"rework","name":"Request rework","from":"review","to":"open"},
                 {"id":"reopen","name":"Reopen","from":"done","to":"open"}]}'
PUBLISH='{"name":"Publishing","initial":"draft","states":["draft","released"],
  "transitions":[{"id":"release","from":"draft","to":"released"},{"id":"withdraw","from":"released","to":"draft"}]}'
cfg "" entries/workflows/dev-workflow.json "$DEV"
cfg "" entries/workflows/publish-workflow.json "$PUBLISH"
cfg "" documents/workflows/publish-workflow.json "$PUBLISH"

cfg "" entries/enums/priority-enum.json '{"name":"Priority","options":[{"value":"low"},{"value":"medium"},{"value":"high","color":"#d6455d"}]}'
cfg "" entries/enums/tags-enum.json '{"name":"Tags","extendable":true,"options":[{"value":"safety"},{"value":"performance"},{"value":"ux"}]}'
cfg "" entries/fields.json '{"fields":[
  {"id":"priority","name":"Priority","type":"enum","enum":"priority"},
  {"id":"effort","name":"Effort (days)","type":"integer"},
  {"id":"tags","name":"Tags","type":"enum","enum":"tags","multiple":true}]}'
cfg "" entries/requirement-fields.json '{"fields":[
  {"id":"rationale","name":"Rationale","type":"multiline"},
  {"id":"due","name":"Due","type":"date"},
  {"id":"spec","name":"Spec link","type":"hyperlink"}]}'
cfg "" entries/testcase-fields.json '{"fields":[
  {"id":"steps","name":"Steps","type":"multiline"},{"id":"automated","name":"Automated","type":"boolean"},
  {"id":"owner","name":"Owner","type":"text"}]}'
cfg "" entries/component-fields.json '{"fields":[
  {"id":"vendor","name":"Vendor","type":"text"},{"id":"cost","name":"Unit cost","type":"currency","currency":"EUR"},
  {"id":"parts","name":"Sub-components","type":"references","targetTypes":["component"]}]}'
cfg "" entries/types.json '{"types":[
  {"id":"requirement","displayName":"Requirement","description":"A single verifiable statement of need",
   "hid":{"prefix":"REQ"},"workflows":["dev","publish"],
   "fields":[{"id":"priority","required":true},"rationale","effort","due","tags","spec"],
   "presentation":{"columns":["priority","effort","due"],"icon":"requirement"}},
  {"id":"testcase","displayName":"Test case","hid":{"prefix":"TC","digits":3},"workflows":["dev"],"presentation":{"icon":"testcase"}},
  {"id":"component","displayName":"Component","hid":{"prefix":"CMP"},"presentation":{"icon":"component"}}]}'

cfg "" documents/spec-fields.json '{"fields":[{"id":"audience","name":"Audience","type":"enum","options":[{"value":"internal"},{"value":"customer"}]}]}'
cfg "" documents/types.json '{"types":[{"id":"spec","displayName":"Specification","hid":{"prefix":"SPEC"},"workflows":["publish"],"presentation":{"icon":"doc-spec"}}]}'

cfg "" links/verifies-fields.json '{"fields":[{"id":"coverage","name":"Coverage","type":"enum","options":[{"value":"full"},{"value":"partial"}]}]}'
cfg "" links/types.json '{"types":[
  {"id":"verifies","displayName":"verifies","sourceTypes":["testcase"],"targetTypes":["requirement"],"cardinality":"many-to-many","presentation":{"icon":"test-passed"}},
  {"id":"implements","displayName":"implements","sourceTypes":["component"],"targetTypes":["requirement"],"cardinality":"many-to-many","presentation":{"icon":"software"}},
  {"id":"related","displayName":"related to","presentation":{"icon":"interface"}}]}'

cfg "" comments/types.json '{"types":[{"id":"comment","displayName":"Comment","presentation":{"icon":"note"}}]}'

# A subtree that refines the requirement type with an extra field.
cfg specs/safety entries/enums/asil-enum.json '{"name":"ASIL","options":[{"value":"A"},{"value":"B"},{"value":"C"},{"value":"D"}]}'
cfg specs/safety entries/requirement-fields.json '{"fields":[{"id":"asil","name":"ASIL","type":"enum","enum":"asil"}]}'
cfg specs/safety entries/types.json '{"types":[{"id":"requirement","fields":["asil"]}]}'

# ---- dogfooding: the task tracker --------------------------------------------

T=corestone_tasks
cfg $T entries/workflows/task-workflow.json '{"name":"Task","initial":"open",
  "states":[
    {"id":"open","name":"Open"},
    {"id":"implementation","name":"In implementation","color":"#b7791f"},
    {"id":"verification","name":"In verification","color":"#3b5bdb"},
    {"id":"done","name":"Done","color":"#1f9d55"}],
  "transitions":[
    {"id":"start","name":"Start to implement","from":"open","to":"implementation"},
    {"id":"verify","name":"Start verification","from":"implementation","to":"verification"},
    {"id":"rework","name":"Request rework","from":"verification","to":"implementation"},
    {"id":"close","name":"Close","from":"verification","to":"done"},
    {"id":"reopen","name":"Reopen","from":"done","to":"open"}]}'
cfg $T entries/enums/priority-enum.json '{"name":"Priority","options":[{"value":"low"},{"value":"medium"},
  {"value":"high","color":"#a6852d"},{"value":"urgent","color":"#d6455d"}]}'
cfg $T entries/enums/tags-enum.json '{"name":"Tags","extendable":true,"options":[{"value":"server"},{"value":"client"},{"value":"docs"}]}'
cfg $T entries/fields.json '{"fields":[
  {"id":"priority","name":"Priority","type":"enum","enum":"priority"},
  {"id":"effort","name":"Effort (days)","type":"integer"},
  {"id":"description","name":"Description","type":"multiline"},
  {"id":"tags","name":"Tags","type":"enum","enum":"tags","multiple":true}]}'
cfg $T entries/types.json '{"inheritance":"off","types":[
  {"id":"task","displayName":"Task","hid":{"prefix":"TSK"},"workflows":["task"],
   "fields":[{"id":"priority","required":true},"effort","description","tags"],
   "presentation":{"columns":["priority","effort"],"icon":"task"}}]}'

# ---- requirements domain content ---------------------------------------------

R1=$(post entries '{"path":"specs/boot","type":"requirement","title":"System boots in under 2 seconds",
  "fields":{"priority":"high","rationale":"Startup latency is a key selling point.","effort":5,"due":"2026-12-01","tags":["performance"]}}' | guid)
R2=$(post entries '{"path":"specs/boot","type":"requirement","title":"Boot progress is displayed",
  "fields":{"priority":"low","effort":2,"tags":["ux"]}}' | guid)
R3=$(post entries '{"path":"specs/safety","type":"requirement","title":"Watchdog resets a hung system within 500 ms",
  "fields":{"priority":"high","asil":"C","tags":["safety"],"effort":8}}' | guid)
V1=$(post entries "{\"path\":\"specs/boot/variants\",\"type\":\"requirement\",\"title\":\"Variant: embedded boot in under 4 seconds\",
  \"base\":\"$R1\",\"fields\":{\"priority\":\"medium\",\"effort\":3}}" | guid)
T1=$(post entries '{"path":"tests","type":"testcase","title":"Measure cold boot time","fields":{"automated":true,"owner":"QA","steps":"1. Power off\n2. Power on\n3. Stop the clock at the login prompt"}}' | guid)
T2=$(post entries '{"path":"tests","type":"testcase","title":"Trigger watchdog with a busy loop","fields":{"automated":false,"owner":"HW lab"}}' | guid)
C1=$(post entries '{"path":"hardware","type":"component","title":"Main board","fields":{"vendor":"Acme","cost":149.5}}' | guid)
C2=$(post entries "{\"path\":\"hardware\",\"type\":\"component\",\"title\":\"Watchdog timer IC\",\"fields\":{\"vendor\":\"Acme\",\"cost\":2.1}}" | guid)
curl -sfS -X PUT "$API/entries/$C1" -H 'Content-Type: application/json' -d "{\"fields\":{\"parts\":[\"$C2\"]}}" >/dev/null

post links "{\"type\":\"verifies\",\"source\":\"$T1\",\"target\":\"$R1\",\"fields\":{\"coverage\":\"full\"}}" >/dev/null
post links "{\"type\":\"verifies\",\"source\":\"$T2\",\"target\":\"$R3\"}" >/dev/null
post links "{\"type\":\"implements\",\"source\":\"$C2\",\"target\":\"$R3\"}" >/dev/null
post links "{\"type\":\"related\",\"source\":\"$R1\",\"target\":\"$R2\"}" >/dev/null
CM=$(post comments "{\"subject\":\"$R1\",\"author\":\"alice\",\"text\":\"Is 2 s realistic on the low-end SKU?\"}" | guid)
post comments "{\"subject\":\"$R1\",\"parent\":\"$CM\",\"author\":\"bob\",\"text\":\"With the new bootloader, yes. See the variant for embedded.\"}" >/dev/null
post comments "{\"subject\":\"$R3\",\"author\":\"carol\",\"text\":\"Needs ASIL C evidence before release.\"}" >/dev/null

D1=$(post documents "{\"path\":\"docs\",\"type\":\"spec\",\"title\":\"Boot Specification\",\"fields\":{\"audience\":\"customer\"},
  \"content\":[{\"id\":\"s1\",\"type\":\"section\",\"title\":\"Timing\",\"children\":[
    {\"id\":\"p1\",\"type\":\"paragraph\",\"text\":\"The following requirements apply to every product variant:\"},
    {\"id\":\"e1\",\"type\":\"entry\",\"guid\":\"$R1\"},{\"id\":\"e2\",\"type\":\"entry\",\"guid\":\"$R2\"}]},
   {\"id\":\"s2\",\"type\":\"section\",\"title\":\"Safety\",\"children\":[
    {\"id\":\"p2\",\"type\":\"paragraph\",\"text\":\"Safety requirements are owned by the safety team and refined under specs/safety.\"},
    {\"id\":\"e3\",\"type\":\"entry\",\"guid\":\"$R3\"},
    {\"id\":\"l1\",\"type\":\"list\",\"items\":[{\"id\":\"i1\",\"type\":\"paragraph\",\"text\":\"Evidence: watchdog test report\"},{\"id\":\"i2\",\"type\":\"paragraph\",\"text\":\"Evidence: FMEA sheet\"}]}]}]}" | guid)
post "artifacts/$R1/transition" '{"workflow":"dev","to":"submit"}' >/dev/null
post "artifacts/$R3/transition" '{"workflow":"dev","to":"submit"}' >/dev/null
post "artifacts/$R3/transition" '{"workflow":"dev","to":"approve"}' >/dev/null
post "artifacts/$D1/transition" '{"workflow":"publish","to":"release"}' >/dev/null

# ---- task tracker content: the configuration layout work itself --------------

task() { post entries "{\"path\":\"$T\",\"type\":\"task\",\"title\":\"$1\",\"fields\":$2}" | guid; }
step() { for to in "${@:2}"; do post "artifacts/$1/transition" "{\"workflow\":\"task\",\"to\":\"$to\"}" >/dev/null; done; }
K1=$(task "Specify the configuration layout" '{"priority":"high","effort":1,"tags":["docs"],"description":"docs/CONFIGURATION.md"}')
K2=$(task "Model for the configuration layout" '{"priority":"high","effort":2,"tags":["server"]}')
K3=$(task "Configuration API and indexing" '{"priority":"high","effort":2,"tags":["server"]}')
K4=$(task "Enforce types and fields" '{"priority":"high","effort":2,"tags":["server"],"description":"Reject undefined types (create, retype, move) and adding or changing undefined fields."}')
K5=$(task "Show undefined fields read-only" '{"priority":"medium","effort":1,"tags":["client"]}')
K6=$(task "Copy or move configuration dialog" '{"priority":"low","tags":["client","server"],"description":"Clone the complete settings, keep only local definitions, or ignore."}')
step "$K1" start verify close
step "$K2" start verify close
step "$K3" start verify
step "$K4" start
post links "{\"type\":\"related\",\"source\":\"$K4\",\"target\":\"$K5\"}" >/dev/null

echo "Seeded: requirements $R1 $R2 $R3, variant $V1, tests $T1 $T2, components $C1 $C2, document $D1, tasks $K1 $K2 $K3 $K4 $K5 $K6"
