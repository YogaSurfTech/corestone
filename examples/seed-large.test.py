"""Browser/server-independent tests for the Python program embedded in seed-large.sh."""
from collections import Counter
from contextlib import redirect_stderr
import io
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest

source = Path(__file__).with_name("seed-large.sh").read_text(encoding="utf-8")
program = source.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
seed = ModuleType("seed_large")
exec(compile(program, "seed-large.sh:python", "exec"), seed.__dict__)


class RecordingClient(seed.Client):
    def __init__(self, count=1000, scale=1, random_seed=20261023):
        super().__init__(SimpleNamespace(root="test-portfolio", url="http://unused.invalid", dry_run=True,
                                         count=count, scale=scale, seed=random_seed))
        self.configuration = {}
        self.artifacts = {}
        self.transitions = []
        self.role_counts = Counter()
        self.cross_project_links = 0

    def request(self, *args, **kwargs):
        raise AssertionError("Dry run attempted a network request")

    def config(self, scope, path, body):
        super().config(scope, path, body)
        self.configuration[scope, path] = body

    def lineage(self, folder):
        parts = folder.split("/")
        return ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]

    def definition(self, folder, kind, type_id):
        definition = {}
        fields = {}
        refs = []
        for scope in self.lineage(folder):
            types = self.configuration.get((scope, f"{kind}/types.json"), {})
            if types.get("inheritance") == "off":
                definition, fields, refs = {}, {}, []
            for field in self.configuration.get((scope, f"{kind}/fields.json"), {}).get("fields", []):
                fields[field["id"]] = field
            for item in types.get("types", []):
                if item["id"] == type_id:
                    definition.update(item)
                    refs.extend(item.get("fields", []))
            for field in self.configuration.get((scope, f"{kind}/{type_id}-fields.json"), {}).get("fields", []):
                fields[field["id"]] = field
        assert definition, (folder, kind, type_id)
        return definition, fields, refs

    def named(self, folder, kind, role, type_id, name):
        for scope in reversed(self.lineage(folder)):
            for stem in (f"{type_id}-{name}", name):
                key = (scope, f"{kind}/{role}s/{stem}-{role}.json")
                if key in self.configuration:
                    return self.configuration[key]
            if self.configuration.get((scope, f"{kind}/types.json"), {}).get("inheritance") == "off":
                break
        raise AssertionError((folder, kind, role, type_id, name))

    def create(self, kind, body):
        if kind == "links":
            assert body["source"] in self.artifacts, body
            assert body["target"] in self.artifacts, body
            source = self.artifacts[body["source"]]
            target = self.artifacts[body["target"]]
            folder = source["path"]
            self.cross_project_links += source["path"].split("/")[1] != target["path"].split("/")[1]
            if body["type"] == "verifies":
                assert source["type"] in seed.VERIFICATION, source
                assert target["type"] in seed.NEEDS | {"specification"}, target
        elif kind == "comments":
            assert body["subject"] in self.artifacts, body
            folder = self.artifacts[body["subject"]]["path"]
            if "parent" in body:
                assert self.artifacts[body["parent"]]["subject"] == body["subject"]
        else:
            folder = body["path"]
        definition, fields, refs = self.definition(folder, kind, body["type"])
        for name, value in body.get("fields", {}).items():
            assert name in fields, (folder, name)
            field = fields[name]
            if field["type"] == "enum":
                enum = self.named(folder, kind, "enum", body["type"], field["enum"])
                options = {item["value"] for item in enum["options"]}
                for item in value if field.get("multiple") else [value]:
                    assert item in options or enum.get("extendable"), (folder, name, item, options)
        for ref in refs:
            if isinstance(ref, dict) and ref.get("required"):
                assert ref["id"] in body["fields"]
        for ref in refs:  # a workflow is a field of the type; its definition is found from the folder
            field = fields[ref["id"] if isinstance(ref, dict) else ref]
            if field["type"] == "workflow":
                assert field["id"] not in body.get("fields", {}), "a state is set by transitions only"
                wf = self.named(folder, kind, "workflow", body["type"], field["workflow"])
                assert wf["initial"] in {state["id"] for state in wf["states"]}
        if kind == "documents":
            # The documents format: sections with an 8-character id, placed
            # entries (each at most once per document) and text paragraphs.
            sections, placed = set(), set()
            def check(nodes):
                for node in nodes:
                    assert "type" not in node and "id" not in node, node  # the old block format
                    if "entry" in node:
                        assert node["entry"] in self.artifacts, node
                        assert node["entry"] not in placed, node
                        placed.add(node["entry"])
                    elif "section" in node:
                        sid = node["section"]
                        assert len(sid) == 8 and sid.isascii() and sid.isalnum() and sid == sid.lower(), node
                        assert sid not in sections and node["title"], node
                        sections.add(sid)
                        check(node["children"])
                    else:
                        assert "text" in node, node
            check(body["content"])
        guid = super().create(kind, body)
        self.artifacts[guid] = {**body, "path": folder}
        if kind == "entries":
            self.role_counts[body["type"]] += 1
        return guid

    def advance(self, guid, field_id, depth):
        artifact = self.artifacts[guid]
        kind = "documents" if "content" in artifact else "entries"
        _, fields, refs = self.definition(artifact["path"], kind, artifact["type"])
        assert field_id in [ref["id"] if isinstance(ref, dict) else ref for ref in refs], (artifact["type"], field_id)
        assert fields[field_id]["type"] == "workflow", fields[field_id]
        wf = self.named(artifact["path"], kind, "workflow", artifact["type"], fields[field_id]["workflow"])
        assert 0 < depth < len(wf["states"])
        self.transitions.append((guid, field_id, depth))
        super().advance(guid, field_id, depth)


def run(count=1000, scale=1, random_seed=20261023):
    client = RecordingClient(count, scale, random_seed)
    with redirect_stderr(io.StringIO()):
        seed.configure(client)
        seed.generate(client)
    return client


class SeedTests(unittest.TestCase):
    def test_default_workload_and_references(self):
        client = run()
        self.assertEqual(client.counts["entries"], 1000)
        self.assertEqual(dict(client.projects), {p["id"]: p["weight"] for p in seed.PROJECTS})
        self.assertGreaterEqual(client.counts["configs"], 100)
        self.assertGreaterEqual(client.counts["documents"], 80)
        self.assertGreaterEqual(client.counts["links"], 1000)
        self.assertGreaterEqual(client.cross_project_links, 7)
        self.assertEqual(set(client.role_counts), set(seed.ALL_ROLES))
        self.assertGreaterEqual(len(client.folders), 150)

    def test_exact_counts_for_uneven_and_scaled_allocations(self):
        for count, scale in [(60, 1), (1001, 1), (1000, 2)]:
            with self.subTest(count=count, scale=scale):
                client = run(count, scale)
                self.assertEqual(client.counts["entries"], count * scale)
                self.assertEqual(sum(client.projects.values()), count * scale)

    def test_determinism_and_seed_variation(self):
        self.assertEqual(run().digest.hexdigest(), run().digest.hexdigest())
        self.assertNotEqual(run(random_seed=1).digest.hexdigest(), run(random_seed=2).digest.hexdigest())

    def test_flat_projects_and_kind_cutoff(self):
        client = run()
        for artifact in client.artifacts.values():
            if "/verdant-mcu" in artifact["path"]:
                self.assertEqual(artifact["path"], "test-portfolio/verdant-mcu")
            if "/moss-lora" in artifact["path"]:
                self.assertEqual(artifact["path"], "test-portfolio/moss-lora")
                self.assertNotIn("subject", artifact)
                self.assertNotIn("content", artifact)


if __name__ == "__main__":
    unittest.main()
