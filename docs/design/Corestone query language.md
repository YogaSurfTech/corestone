# Corestone query language: specification (draft)

Status: draft for TSK-13, revision 4. Input: decisions of 2026-11-17, 2026-11-18, 2026-11-20 and
2026-11-21. Built: the server side (parser, evaluation, API, `has_link`, query-backed
enumerations, `base`), the query field and the query builder in the overview. Where the text says **Proposal**, the point was not decided and is listed again in
section 12.

## 1. Purpose

One query language for every place where Corestone selects artifacts: the overview table, the
picker, entries under a document section, saved views, query-backed enumerations (TSK-28), bulk
edit (TSK-25) and the MCP tools (TSK-39).

- The syntax follows **Lucene**: every criterion is a field name, a colon and a value. People who
  know Lucene (or Polarion) can type queries directly.
- Most users will not type. The **query builder** (section 10) writes the same language, so there
  is one stored form: the query text.
- The language is **forgiving**: a query that names something unknown gives an empty result, not
  an error (section 8).

The first goal of TSK-13 is covered by it: hide finished entries (section 6).

## 2. Examples

| Query | Finds |
|---|---|
| `corestone` | artifacts with the word "corestone" anywhere |
| `description:corestone` | artifacts whose `description` contains the word |
| `description:(corestone claude)` | either word in `description` |
| `type:task AND priority:high` | tasks with high priority |
| `type:task AND NOT finished:true` | tasks that are not finished |
| `created:>=2026-11-01 AND created:<2026-12-01` | created in November 2026 |
| `modified:2026-11` | modified in November 2026 |
| `NOT assignee:NULL` | artifacts where `assignee` has a value |
| `type:task has_link:(depends_on, created:<2026-11-01)` | tasks, or anything that depends on an artifact created before 1 Nov 2026 (the two criteria are joined by OR, section 3.2) |
| `type:task AND has_link:(~depends_on, created:<2026-11-01)` | tasks that block an artifact created before 1 Nov 2026 |
| `base:REQ-1` | the entries based on REQ-1 (its overlays) |
| `~base:REQ-7` | the entry REQ-7 is based on |
| `NOT ~base:NULL` | the entries something is based on (all bases) |

## 3. Syntax

### 3.1 Criteria

- `field:value`: the field matches the value (section 5 says what "matches" means per field type).
- `field:(v1 v2)`: a value group. The values are combined like criteria, so side by side means
  OR, and operators and brackets are allowed: `tags:(server AND NOT docs)`.
- `value` without a field: searched in all text of the artifact (section 4.3).
- `field:<v`, `field:<=v`, `field:>v`, `field:>=v`: comparison, for dates, numbers and text.
  A comparison takes one value, not a group.
- A value with spaces or special characters is written in quotes: `title:"table view"`. In text
  fields this is a phrase: the words in this order. Inside quotes, `\"` is a quote and `\\` a
  backslash.
- Without quotes, a value may contain letters, digits and `_ - . / @ + *`. A time is written
  without quotes too: `created:>2026-11-17T14:30`.

### 3.2 Operators

- `AND`, `OR`, `NOT`, `XOR`, written in **capitals**. In lower case they are ordinary search
  words.
- Brackets `( )` group.
- Two criteria side by side with no operator are joined by **OR**, as in Lucene.
  `type:task priority:high` therefore finds all tasks plus everything with high priority. The
  query builder always writes `AND` explicitly.
- The exception (decided 2026-11-20): **values without a field** that stand side by side must
  all match. `table view` finds artifacts with both words, as the search box always did.
- Precedence without brackets is mathematical: `NOT` binds strongest, then `AND`, then `XOR`,
  then `OR`. A missing operator counts as `OR`: `a AND b c` is `(a AND b) OR c`.
- `XOR` is not part of Lucene; it is a Corestone addition.

### 3.3 Reserved words

| Word | Meaning |
|---|---|
| `AND` `OR` `NOT` `XOR` | operators |
| `NULL` | the value "no value" (section 7) |

To search for one of these as a word, put it in quotes: `title:"NULL"`.

### 3.4 Grammar

```
query     = xor { [ "OR" ] xor } ;
xor       = and { "XOR" and } ;
and       = not { "AND" not } ;
not       = [ "NOT" ] primary ;
primary   = "(" query ")" | link | criterion | value ;
criterion = field ":" ( compare value | value | "(" values ")" ) ;
values    = the same rules as query, with value in place of primary's criterion and link ;
field     = [ "~" ] id [ "." id ] [ "~" number ] ;   (* "~" in front only for base, section 4.4; ".id" for
                                                    workflow fields, section 6; "~n" only for folder, section 4.2 *)
compare   = "<" | "<=" | ">" | ">=" ;
link      = "has_link" ":" "(" [ "~" ] id [ "," query ] ")" ;
value     = word | quoted | "NULL" ;
```

Whitespace between tokens is ignored, also after the colon and around the comma.

## 4. Fields

### 4.1 Configured fields

A configured field is named by its **id**, never by its display name. Display names change and
may be translated; ids do not. The query builder shows names and writes ids. The same holds for
values that have ids: enumeration options, workflow states, types, link types.

### 4.2 Built-in fields

| Field | Value |
|---|---|
| `kind` | `entry`, `document`, `link`, `comment` |
| `type` | type id |
| `title` | text |
| `hid` | the HID, e.g. `TSK-13`; compared in natural order (`TSK-9` before `TSK-10`) |
| `guid` | the GUID |
| `folder` | path of the folder the artifact is in |
| `folder~n` | path of the nth parent of that folder (`folder~1` is the parent) |
| `author` | account that created the artifact |
| `created`, `modified` | date and time |
| `valid` | `true` or `false` |
| `finished` | `true` or `false`: whether the artifact's workflows have reached a final state (section 6) |
| `base` | the entry this entry is based on, by HID or GUID; `~base` reads it the other way round (section 4.4) |
| `has_link` | section 9 |

These names are **reserved**: no configured field may use one as its id. The configuration check
reports such a field as invalid, like any other invalid definition.

`folder:specs/brakes` matches artifacts directly in that folder. `folder~1:specs` matches
artifacts one level below `specs`. `folder:specs/*` matches `specs` and everything below it
(decided 2026-11-20); this is the only wildcard. `folder~n` is a use of `~` of its own, as a
suffix; everywhere else `~` in front of a name means "the other way round" (`~depends_on`, and
`~title` in a sort).

### 4.3 No field

A value without a field is searched in the title, the HID and the full-text index of the
artifact, which holds all its text fields including the plain text of rich-text fields. This is
what the search box does today, so `TSK-13` alone still finds the task.

### 4.4 Base and overlay

An entry can be based on another entry: it overlays its base and inherits the fields it does not
set itself. Two criteria ask for this relation (decided 2026-11-21):

| Criterion | Finds |
|---|---|
| `base:REQ-1` | the entries whose base is REQ-1: the overlays of REQ-1 |
| `~base:REQ-7` | the entry that is the base of REQ-7 |
| `base:NULL` | entries without a base |
| `NOT base:NULL` | entries with a base: every overlay |
| `~base:NULL` | entries nothing is based on |
| `NOT ~base:NULL` | entries something is based on: every base |

- The value is the other entry's HID or GUID; case is ignored.
- `~` in front of the field reads it the other way round, the same rule as `~depends_on` in
  `has_link` and `~title` in a sort. It is allowed for `base` only; in front of another field the
  criterion matches nothing and gives a warning.
- Only the direct base counts, not the base of the base.
- `base` cannot be compared (`<`, `>`).

## 5. Matching by field type

Lucene matches words; a database can match exactly. Corestone uses the word rule for text and
exact rules for everything else. If a field's whole value equals the search value, it always
matches.

| Field type | `field:value` | Comparisons |
|---|---|---|
| text, rich text, title | contains the word; case is ignored; quotes make a phrase | alphabetical, case ignored |
| enumeration | the option with this id | by the order of the options in the definition |
| workflow | the state with this id | by the order of the states in the definition |
| integer, number | equal | numeric |
| date, date and time | the day, month or year given (section 5.1) | chronological |
| boolean | `true` or `false` | none |
| reference | the target's HID or GUID | none |
| dynamic enumeration | the chosen artifact's HID or GUID | none |
| attachment | a file with this name | none |

- A field with several values matches if **any** value matches.
- An exact match for text ("the field is exactly this, nothing more") is not part of this
  revision; see section 12.

### 5.1 Dates

- Dates are written as ISO dates: `2026-11-17`, optionally with a time `2026-11-17T14:30`.
- A partial date is a range: `modified:2026-11` is the whole month, `created:2026` the whole year.
- With a comparison, a partial date stands for its start or end so that the result is what one
  expects: `created:<2026-11-01` is everything before that day began, `created:<=2026-11-01`
  includes the whole day, `created:>2026-11` is everything after November.
- Times without a zone are in the server's time zone.
- Relative dates ("the last 7 days") are left out of this revision.

## 6. Workflows as a field type

Prerequisite for the query language, and a separate change that comes first (decided
2026-11-18). Everything an artifact holds is a field; a workflow state is no exception.

- A workflow is a **field type** (`"type": "workflow"`), with its own configuration and its own
  control in the form, like every field type. The field has an id and a name like any other
  field, for example `status`, and names the workflow definition it follows.
- **Two fields may use the same workflow definition**, as two fields may use the same
  enumeration. A type may have several workflow fields.
- The state is the field's **value**, stored in `fields` with the other values. The separate
  `workflows` object of an artifact and the `workflows` list of a type go.
- A workflow definition has a list of **states** (one marked initial, any number marked final)
  and **transitions**, each leading from one or more states to one state.
- The field's control shows the current state. Its dropdown lists the **transitions** allowed
  from that state, each with its name and the state it leads to, for example
  "Send to review → In review" or "Approve → Approved".
- **The transition is what is sent, not the state.** Choosing one marks it in the form; the Save
  carries the field and the transition's id, and the **server runs the transition**, which gives
  the new state. A workflow field's value cannot be written directly. A new artifact starts in
  the initial state.
- Two transitions may lead from the same state to the same state. That is intended: they are
  different actions. Later a transition can require a role and run checks and actions (clear a
  field, …) through a script plugin system; another transition to the same state may need no
  role and run nothing.
- So every transition needs an **id**, unique in its workflow (optional today).
- In one Save, the other field changes are applied first and the transitions run after them, so
  a transition's checks see the values being saved.
- The server records, with the state, the **last transition** and the **state before it**. They
  are not shown in the form but can be queried, for example `status.transition:approve` and
  `status.previous:review` (**Proposal** for the names and the dot form). The save's commit
  message names the transition as well.
- **No migration.** There is no data to keep in the old form: the task repository (about 45
  entries) and the seed scripts are set up again with workflow fields. The old form is not read.
- A workflow field is queried like an enumeration: `status:open`, `status:(open implementation)`.
  With several workflow fields, each is queried by its own id:
  `status:approved AND release:draft`.
- The built-in field `finished` (section 4.2) says whether an artifact is done, without naming
  its fields or states: `finished:true` shows what is finished (to review it),
  `NOT finished:true` hides it (to concentrate on what still needs work). It keeps working when
  states are added, and across types with different workflows.
- An artifact with several workflow fields is finished when **all** of them are in a final
  state. An artifact without a workflow field is never finished, so hiding finished artifacts
  keeps it in view.

## 7. Empty and missing values

`field:NULL` matches every artifact that has **no value** for the field. `NOT field:NULL` matches
every artifact where the field is set.

**Proposal:** `NULL` does not distinguish between "the type has the field but it is empty" and
"the type has no such field". Both are "no value", and one reserved word is enough:

- The second case is a question about the type, not about the artifact, and `type:` already
  answers it: `type:task AND priority:NULL` is "tasks without a priority".
- If a real need for the difference appears, it can be added as a built-in field (for example
  `defined:priority`) without a new reserved word and without changing existing queries.

## 8. Forgiving and strict

- An unknown field, an unknown enumeration option, an unknown type or link type, or a value that
  does not fit the field (text where a number is needed) **matches nothing**. The query runs and
  that criterion is simply false. Note that `NOT priorty:high` (misspelt) then matches
  everything.
- **Proposal:** the answer always carries a list of warnings for such criteria ("unknown field
  `priorty`"), which the user interface can show under the query field. The query still runs.
- **Strict mode** turns these warnings into errors and the query does not run. It is meant for
  stored queries (saved views, query-backed enumerations) and for tools.
- **Proposal:** a query that cannot be parsed at all (an unclosed bracket or quote, an operator
  with nothing after it) is an error in both modes, reported with its position. There is no
  sensible result to give.

## 9. Links

`has_link:(role, query)` matches artifacts that have a link of the given link type to an
artifact that matches the inner query.

- `role` is a link type id. The artifact is the link's **source**; the inner query is applied to
  the **target**.
- `~role` reverses the direction: the artifact is the target, the inner query is applied to the
  source. `~depends_on` reads as the link type's reverse name ("blocks").
- The inner query is a complete query and may contain `has_link` again. **Proposal:** at most
  3 levels deep.
- The query is optional: `has_link:(depends_on)` matches artifacts with any such link, and
  `NOT has_link:(~verifies)` finds, for example, requirements nothing verifies.

Not in this revision: conditions on the link itself (its own fields), "any link type", and
counting links.

## 10. Query builder

Decided 2026-11-21, and built for the overview. This replaces the earlier proposal (one query in
two views, explicit brackets).

- The query field stands in the overview's toolbar, between "New" and the count. It holds either
  a typed text or built criteria.
- "+" at the left inside the field lists the fields that can be asked here: the general ones
  (text, type, title, ID, folder, created, modified, author, finished, based on, base of) and the
  fields of the types of the folder, or of the one type the view is filtered by. A small text
  field at the top of the list narrows it: a field stays if its name contains the text typed, at
  any place and in any case.
- A field opens the editor that fits its type:

| Field type | Editor |
|---|---|
| enumeration, workflow | its values or states to tick; several give `field:(a b)` |
| dynamic enumeration | its options to tick; written as the artifact's HID, or its GUID without one |
| boolean, `finished` | yes or no |
| number | a comparison (is, less than, up to, more than, from, between) and the value |
| date | the same comparisons; a day from a date picker, or a month or year typed |
| text | a text field; several words in a field are a phrase |
| reference | the artifact picker |
| based on (`base`) | the artifact picker, offering only entries something is based on |
| base of (`~base`) | the artifact picker, offering only entries that have a base |
| attachment, JSON | only "is empty" |

- Beside the list of fields stands the **history**: the fifteen criteria used last, the newest
  first. A click adds one again. A criterion can be pinned; pinned ones stand first, are never
  forgotten and do not count among the fifteen. The history is kept in the browser.
- Every field with an id also offers "is empty" (`field:NULL`).
- "Between" is one criterion in the builder and two in the text: `(due:>=a AND due:<=b)`.
- A criterion is a button in the field. A click opens its editor again. It carries a NOT that is
  switched on and off, and a button to remove it. The editor has the same NOT switch, so a criterion
  with NOT is made in one go and lands in the history as such.
- Between two criteria stands the operator, a button that offers AND, OR and XOR. A new criterion
  is joined by AND.
- The builder has no brackets. The operators bind as in the text (NOT, AND, XOR, OR), and the
  field shows it by distance: what binds closer stands closer together.
- The builder shows names (fields, options, states, types) and writes ids.
- The whole query can be turned into text. A text is never turned back into criteria. The
  criteria of a built query are kept in the browser beside their text, so they survive a reload
  there; elsewhere the same link shows the query as text.
- While a text is typed in the field, a criterion from "+" joins it as text, with AND.
- Not in the builder: `has_link`, `kind` (the kind buttons beside the field do that), `folder~n`,
  `valid`, `guid`.

## 11. Server

- The server owns the grammar: it parses the text into a tree and builds the database query from
  the tree in one place. This replaces the flat filter (exact field and state values) that
  `/api/repository/search` and `/api/repository/query` each fill by hand today.
- `POST /api/repository/query` takes the query text in its filter. The view's own context (folder
  and subtree, the types of a picker) stays separate and is combined with the query by AND.
- A second call parses a query without running it and returns the tree and the warnings; the
  builder uses it.
- The projection stores field values as text for exact comparison today. Word search per field
  and typed comparisons (numbers, dates, option order) need typed values and a text index per
  field: a projection change with a reindex.
- Limits (**Proposal**): query text up to 4,000 characters, 100 criteria, bracket depth 20.
- Queries see what the user may read; once folder roles exist (TSK-24), this includes the
  artifacts reached through `has_link`.

## 12. Open decisions

1. **Plain words side by side.** Decided: values without a field must all match (section 3.2).
2. **Lucene precedence switch.** A server setting for Lucene's own precedence was suggested for
   compatibility. Two concerns: Lucene's behaviour is not a precedence order but a
   must/should/must-not model, so it is a second evaluation mode; and a stored query would mean
   different things on different servers. Suggestion: leave it out until someone needs it.
3. **Subtree of a folder.** Decided: `folder:specs/*` (section 4.2).
4. **`~` and Lucene.** Lucene uses `~` after a term for fuzzy and proximity search. `folder~1` and
   `~role` use it in other positions, so nothing clashes, but the fuzzy syntax cannot be added
   later in those positions.
5. **Last transition and previous state.** Decided and built: the field's value is one object,
   `{"state", "transition", "previous"}`, written by the server. `status:review` matches the
   state; `status.transition:send_to_review` and `status.previous:open` match the other two.
6. **`NULL` without a "defined" counterpart** (section 7).
7. **Exact match for text.** Needed when a database-style comparison is wanted, e.g.
   `title:="Table view"`.
8. **`author`.** Decided: the creator only.
9. **Limits and nesting depth** (sections 9 and 11).

## 13. Out of scope for this revision

- Wildcards, fuzzy and proximity search, boosts, Lucene range syntax (`[a TO b]`), regular
  expressions.
- Relative dates.
- Sorting and columns as part of the query (they belong to a saved view).
- Queries on historic states.
