import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  stdin: { contents: 'export * from "./query-model"; export * from "./sorting";', resolveDir: fileURLToPath(new URL("../src/components", import.meta.url)) },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { quote, toText, clauseLabel, compare, fieldValue } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const field = (id, name = id, input = "text") => ({ id, name, input });
const clause = (f, value, more = {}) => ({ field: f, not: false, join: "AND", value, ...more });
const text = (t) => ({ kind: "text", text: t });
const range = (compare, a, b = "") => ({ kind: "range", compare, a, b });

test("a value is written as it is, or in quotes when it needs them", () => {
  assert.equal(quote("high"), "high");
  assert.equal(quote("TSK-12"), "TSK-12");
  assert.equal(quote("a.b/c@d+e*"), "a.b/c@d+e*");
  assert.equal(quote("Grün"), "Grün");
  assert.equal(quote("very low"), '"very low"');
  assert.equal(quote(""), '""');
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  // words of the language are values only in quotes
  for (const w of ["AND", "OR", "XOR", "NOT", "NULL"]) assert.equal(quote(w), `"${w}"`);
  assert.equal(quote("and"), "and");
});

test("words without a field are one search, in a field they are a phrase", () => {
  const any = field("", "Text");
  assert.equal(toText([clause(any, text("pump"))]), "pump");
  assert.equal(toText([clause(any, text("  pump   valve "))]), "(pump valve)");
  assert.equal(toText([clause(any, text("pump AND"))]), '"pump AND"');
  assert.equal(toText([clause(any, text("pump (old)"))]), '"pump (old)"');
  assert.equal(toText([clause(field("title"), text("pump"))]), "title:pump");
  assert.equal(toText([clause(field("title"), text("pump valve"))]), 'title:"pump valve"');
});

test("every kind of value has its form in the query text", () => {
  const prio = field("priority", "Priority", "enum");
  const due = field("due", "Due", "date");
  assert.equal(toText([clause(due, { kind: "empty" })]), "due:NULL");
  assert.equal(toText([clause(field("finished"), { kind: "bool", value: true })]), "finished:true");
  assert.equal(toText([clause(field("finished"), { kind: "bool", value: false })]), "finished:false");
  assert.equal(toText([clause(field("~base"), { kind: "artifact", id: "TSK-7", label: "Pump" })]), "~base:TSK-7");
  assert.equal(toText([clause(prio, { kind: "enum", values: [{ value: "high", label: "High" }] })]), "priority:high");
  assert.equal(toText([clause(prio, { kind: "enum", values: [{ value: "high", label: "High" }, { value: "very low", label: "Very low" }] })]), 'priority:(high "very low")');
  assert.equal(toText([clause(due, range("=", "2026-01-01"))]), "due:2026-01-01");
  assert.equal(toText([clause(due, range(">=", "2026-01-01"))]), "due:>=2026-01-01");
  assert.equal(toText([clause(due, range("<", "2026-01-01"))]), "due:<2026-01-01");
  assert.equal(toText([clause(due, range("between", "2026-01-01", "2026-02-01"))]), "(due:>=2026-01-01 AND due:<=2026-02-01)");
});

test("criteria are joined by their operators, the first one's is not written", () => {
  const a = clause(field("title"), text("pump"), { join: "XOR" });
  const b = clause(field("priority"), { kind: "enum", values: [{ value: "high", label: "High" }] }, { join: "OR", not: true });
  const c = clause(field("", "Text"), text("old valve"), { join: "XOR" });
  assert.equal(toText([]), "");
  assert.equal(toText([a]), "title:pump");
  assert.equal(toText([a, b, c]), "title:pump OR NOT priority:high XOR (old valve)");
  assert.equal(toText([{ ...a, not: true }]), "NOT title:pump");
});

test("a criterion reads as its button shows it", () => {
  const due = field("due", "Due", "date");
  assert.equal(clauseLabel(clause(due, { kind: "empty" })), "Due is empty");
  assert.equal(clauseLabel(clause(field("finished", "Finished"), { kind: "bool", value: true })), "Finished: yes");
  assert.equal(clauseLabel(clause(field("finished", "Finished"), { kind: "bool", value: false })), "Finished: no");
  assert.equal(clauseLabel(clause(field("~base", "Base of"), { kind: "artifact", id: "TSK-7", label: "Pump" })), "Base of: Pump");
  assert.equal(clauseLabel(clause(field("priority", "Priority"), { kind: "enum", values: [{ value: "high", label: "High" }, { value: "low", label: "Low" }] })), "Priority: High, Low");
  assert.equal(clauseLabel(clause(field("", "Text"), text("pump"))), "Text: pump");
  assert.equal(clauseLabel(clause(due, range("=", "2026-01-01"))), "Due: 2026-01-01");
  assert.equal(clauseLabel(clause(due, range("<=", "2026-01-01"))), "Due ≤ 2026-01-01");
  assert.equal(clauseLabel(clause(due, range(">", "2026-01-01"))), "Due > 2026-01-01");
  assert.equal(clauseLabel(clause(due, range("between", "2026-01-01", "2026-02-01"))), "Due: 2026-01-01 – 2026-02-01");
});

test("sorting: natural order, and empty values stay last in both directions", () => {
  assert.ok(compare("a2", "a10", 1) < 0);
  assert.ok(compare("a2", "a10", -1) > 0);
  assert.equal(compare("Pump", "pump", 1), 0);
  assert.ok(compare(2, 10, 1) < 0);
  assert.ok(compare(2, 10, -1) > 0);
  for (const dir of [1, -1]) {
    assert.equal(compare(null, "a", dir), 1);
    assert.equal(compare("", "a", dir), 1);
    assert.equal(compare("a", null, dir), -1);
    assert.equal(compare(null, "", dir), 0);
  }
});

test("sorting: values of a definition go by their place in it, unlisted ones after them", () => {
  const low = { value: "Low", rank: 0 }, high = { value: "High", rank: 2 };
  assert.ok(compare(low, high, 1) < 0); // not by name: High would come first
  assert.ok(compare(low, high, -1) > 0);
  for (const dir of [1, -1]) {
    assert.equal(compare(high, "Anything", dir), -1);
    assert.equal(compare("Anything", high, dir), 1);
    assert.equal(compare(high, null, dir), -1);
  }
});

test("sorting: a list of values is compared place by place", () => {
  assert.equal(compare(["a", 1], ["a", 1], 1), 0);
  assert.ok(compare(["a", 1], ["a", 2], 1) < 0);
  assert.ok(compare(["a", 1], ["a", 2], -1) > 0);
  assert.ok(compare(["a", 9], ["b", 1], 1) < 0);
  assert.equal(compare(["a"], ["a", "b"], 1), 1); // the missing place counts as empty
  assert.ok(compare("a", ["b"], 1) < 0);
});

test("a field's value as the table sorts and shows it", () => {
  const row = (fields) => ({ fields });
  assert.equal(fieldValue(row({ n: 3 }), "n"), 3);
  assert.equal(fieldValue(row({ n: 0 }), "n"), 0);
  assert.equal(fieldValue(row({}), "n"), null);
  assert.equal(fieldValue({}, "n"), null);
  assert.equal(fieldValue(row({ n: null }), "n"), null);
  assert.equal(fieldValue(row({ s: "text" }), "s"), "text");
  assert.equal(fieldValue(row({ b: true }), "b"), "true");
  assert.equal(fieldValue(row({ l: ["a", "b"] }), "l"), "a, b");
  assert.equal(fieldValue(row({ w: { state: "done", previous: "open" } }), "w"), "done");
  assert.equal(fieldValue(row({ r: [{ text: "Hello" }, { text: "world" }] }), "r"), "Hello\nworld");
  assert.equal(fieldValue(row({ o: { state: "done", other: 1 } }), "o"), "{…}");
});
