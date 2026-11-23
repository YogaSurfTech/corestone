# Scripts

Status: exploring · Started: 2026-11-23 · Owner: Thom

Customers extend workflows with their own scripts, written in Starlark or JavaScript. Scripts live
in the repository with the rest of the configuration, run on the server, and run only in versions
an administrator has approved. Corestone's own functions (approval rounds, signatures) are
validated product features; customer scripts are validated by the customer.

Scripts are a general mechanism; approvals are only one use. Typical uses:

- **Calculations:** a risk score and class from probability and severity (Starlark example below).
- **Consistency checks:** refuse a save or a transition that would leave an entry incomplete
  (JavaScript example below).
- **Defaults:** set fields from others, e.g. a verification method from the requirement text.
- **Driving approvals:** choose approvers, decide rounds by a customer rule, escalate stuck rounds
  (`approvals-and-scripts.md`).

The API below is a proposal, invented to show the shape; names may change.

## Where scripts live

```
<folder>/.corestone/config/scripts/
├── risk-score.star                 a script: named in workflow configuration, run by the server
├── notify-owner.js
├── lib/                            libraries: loaded by scripts, never run on their own
│   ├── risk.star
│   └── text.js
└── approvals/<guid>.json           administrator approvals of script versions
```

Scripts resolve like the rest of the configuration: nearest folder first, then the parent folders up
to the root. A subtree can override a script or a library, and `"inheritance": "off"` in its
configuration cuts it off from its parents.

## Extension points

| Point | Runs | Entry function | May |
| --- | --- | --- | --- |
| Save hook | before a save is published | `on_save` / `onSave` | change fields, refuse the save |
| Transition condition | before a transition | `on_condition` / `onCondition` | refuse it, with a message |
| Transition action | after a transition, same commit | `on_action` / `onAction` | change fields, call product functions, refuse |
| Round event | after an approval vote or amendment | `on_round_event` / `onRoundEvent` | amend the round, notify; never vote |

A workflow names scripts per transition and maps the script's own field names to the type's field
ids, so one script serves several types:

```json
{ "id": "assess", "from": "draft", "to": "assessed",
  "conditions": [{ "script": "has-owner" }],
  "actions": [{ "script": "risk-score",
                "fields": { "probability": "prob", "severity": "sev",
                            "risk_score": "rscore", "risk_class": "rclass" } }] }
```

## The context

Every entry function gets one argument, `ctx`:

| Member | What it is |
| --- | --- |
| `ctx.entry` | the artifact as it will be published: `get(field)`, `hid`, `guid`, `type`, `folder` |
| `ctx.before` | the artifact as it was before the operation (save hook, transition) |
| `ctx.fields` | the field mapping of the workflow configuration: `ctx.fields.severity` is the field id |
| `ctx.transition` | `id`, `name`, `from`, `to` (transition points only) |
| `ctx.target_state` | `id`, `name` of the state the transition leads to |
| `ctx.user` | the account the script runs for: `guid`, `name`, `groups` |
| `ctx.set(field, value)` | proposes a change; validated against the field type, written in the same commit |
| `ctx.refuse(message)` | cancels the whole operation and shows the message |
| `ctx.note(message)` | shows a message, changes nothing |
| `ctx.query(text)` | runs a Corestone query, read-only, as the user |

Scripts run under the account of the user who triggered the operation, on the server. Protected
fields and view limits do not apply to `ctx.set`. Nothing a script does reaches the repository
except through the commit of the operation that triggered it: no file access, no network, no clock
other than the operation's time, and limits on run time and memory.

## Example: Starlark

A library and a transition action that computes a risk score and class from probability and severity.

```python
# .corestone/config/scripts/lib/risk.star
MATRIX = {            # severity:  1         2         3         4
    1: ["low",    "low",    "medium", "medium"],
    2: ["low",    "medium", "medium", "high"],
    3: ["medium", "medium", "high",   "high"],
    4: ["medium", "high",   "high",   "critical"],
}

def classify(p, s):
    return MATRIX[p][s - 1]

def missing(ctx, *names):
    """The names of the mapped fields that have no value."""
    return [n for n in names if ctx.entry.get(getattr(ctx.fields, n)) == None]
```

```python
# .corestone/config/scripts/risk-score.star
load("lib/risk.star", "classify", "missing")

def on_action(ctx):
    empty = missing(ctx, "probability", "severity")
    if empty:
        return ctx.refuse("Set " + " and ".join(empty) + " before " + ctx.transition.name + ".")
    p = int(ctx.entry.get(ctx.fields.probability))
    s = int(ctx.entry.get(ctx.fields.severity))
    ctx.set(ctx.fields.risk_score, p * s)
    ctx.set(ctx.fields.risk_class, classify(p, s))
```

## Example: JavaScript

A save hook that keeps a requirement's verification method consistent with its text, and refuses a
save that would leave a high risk without a mitigation.

```js
// .corestone/config/scripts/lib/text.js
export function mentions(text, words) {
  const t = (text || "").toLowerCase();
  return words.some((w) => t.includes(w));
}
```

```js
// .corestone/config/scripts/requirement-check.js
import { mentions } from "lib/text.js";

export function onSave(ctx) {
  const f = ctx.fields;
  const text = ctx.entry.get(f.text);

  // A requirement that names a measurement is verified by test, unless someone chose otherwise.
  if (!ctx.entry.get(f.verification) && mentions(text, ["measured", "within", "at most", "at least"])) {
    ctx.set(f.verification, "test");
  }

  // High or critical risk needs a mitigation before the entry can be saved.
  const risk = ctx.entry.get(f.risk_class);
  if ((risk === "high" || risk === "critical") && !ctx.entry.get(f.mitigation)) {
    return ctx.refuse(`Risk is ${risk}: describe the mitigation before saving.`);
  }
}
```

JavaScript runs in the same sandbox as Starlark, with the same context. Functions that would make a
run non-repeatable are not available (`Date.now()` and `Math.random()` are replaced: the time is the
operation's, random numbers are refused).

## Includes

- **Starlark:** `load("lib/risk.star", "classify")`. **JavaScript:** `import { mentions } from "lib/text.js"`.
- **Resolution:** a name is looked up in the loading script's own `.corestone/config/scripts/`,
  then in the parent folders up to the root, as for all configuration. The first match wins.
- **Libraries are passive.** Files a script loads provide functions and constants; only scripts named
  in workflow configuration are run.
- **No cycles, one language.** A load cycle is refused; a `.star` file cannot load a `.js` file or the
  other way round.
- **Everything loaded is part of the script's approval** (below): a library cannot change behaviour
  that was approved without the change being approved too.

## Blob fixture

Git stores every version of every file as a *blob*, named by the hash of its content (its blob id,
e.g. `327c7860e43b…`, the same value `git hash-object <file>` prints). The same content always has
the same id, and different content never shares one. A blob id therefore fixes a script's code
exactly, independent of its path, its commit or its history.

Corestone uses blob ids, not file paths or commits, wherever it must know which code ran:

- an approval names the blob ids of the script and of everything it loads;
- a run checks that the files it resolved have exactly those blob ids;
- a commit made by a script names the blob ids that ran.

A script moved to another folder keeps its blob id; a script changed by one character gets a new one.

## Approval of scripts

**The record.** `.corestone/config/scripts/approvals/<guid>.json`, written once:

```json
{ "script": "risk-score", "path": "specs/.corestone/config/scripts/risk-score.star",
  "blob": "327c7860e43b9a675a765c28ace6b735ffe9dbc7",
  "loads": { "lib/risk.star": "8e1f0d9a3c5b7e2f4a6c8b0d1e3f5a7c9b1d3e5f" },
  "approvedBy": "<account guid>", "at": "2026-11-23T10:00:00Z", "reason": "Validated per VAL-12" }
```

The administrator approves in the client; Corestone resolves the script and its loads, computes
their blob ids and writes the record in one commit. Revoking an approval is a second record
(`"revokes": "<guid>"`, with reason), never an edit or a deletion.

**At every run**, before executing anything, the server:

1. resolves the script by name from the artifact's folder, and every `load`/`import` from there;
2. computes the blob ids of what it resolved;
3. looks for an approval, not revoked, whose `blob` and `loads` match exactly.

No match: the script does not run, and the operation is refused with "Script risk-score is not
approved in this version". Nothing falls back to an older approved version, because the files in
the repository are what would run.

**After a run**, the commit of the operation names what ran, in trailers:

```
Corestone-Script: risk-score@327c7860e43b9a675a765c28ace6b735ffe9dbc7
Corestone-Script-Load: lib/risk.star@8e1f0d9a3c5b7e2f4a6c8b0d1e3f5a7c9b1d3e5f
Corestone-Script-Approval: 9d8c7b6a-1111-4222-8333-444455556666
```

The blobs and the approval record are in the repository at the commit's parent, so a reindex can
show for every change made by a script which approved code made it, from Git alone.

**In the client**, the configuration view lists every script with its language, the extension
points that use it, and its state: approved (by whom, when), changed since approval, or never
approved. A change to a library lists the scripts it deactivates before it is saved.

## Open questions

1. How many administrators approve a script: one, or a configurable number?
2. Does revoking an approval stop open approval rounds whose round-event script it covered?
3. Recursion: does a `ctx.set` in an action run the save hook again? Proposal: no; hooks run once per operation.
4. Limits: run time, memory, and number of `ctx.query` calls per run.
5. Should approved libraries be shareable between repositories (a script package), or always copied?
6. Test support: a way to run a script against an entry in a dry run, without publishing, for validation evidence.
