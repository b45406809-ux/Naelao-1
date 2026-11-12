import hashlib
import tempfile
import unittest
from pathlib import Path

import validate_release_manifest as release


class ReleaseManifestTests(unittest.TestCase):
    def sample(self, directory: Path) -> dict:
        migration = directory / "0001_users.sql"
        migration.write_text("CREATE TABLE users(id TEXT);\n", encoding="utf-8")
        digest = hashlib.sha256(migration.read_bytes()).hexdigest()
        return {
            "formatVersion": 1,
            "migrationDirectory": "infra/migrations",
            "requiredSchemaVersion": "0001_users",
            "legacyBaselinePolicy": "operator_verified_only",
            "migrations": [{"filename": migration.name, "sha256": digest}],
        }

    def test_accepts_exact_ordered_inventory_and_checksums(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = self.sample(directory)
            self.assertEqual(release.validate_manifest(manifest, directory), [])

    def test_rejects_modified_migration_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = self.sample(directory)
            (directory / "0001_users.sql").write_text("DROP TABLE users;\n", encoding="utf-8")
            self.assertEqual(release.validate_manifest(manifest, directory), ["checksum mismatch: 0001_users.sql"])

    def test_rejects_unmanifested_and_missing_migrations(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = self.sample(directory)
            (directory / "0002_posts.sql").write_text("CREATE TABLE posts(id TEXT);\n", encoding="utf-8")
            self.assertEqual(
                release.validate_manifest(manifest, directory),
                ["migration is absent from manifest: 0002_posts.sql"],
            )
            (directory / "0001_users.sql").unlink()
            self.assertEqual(
                release.validate_manifest(manifest, directory),
                ["manifest migration is missing: 0001_users.sql", "migration is absent from manifest: 0002_posts.sql"],
            )

    def test_allows_legacy_number_gaps_but_rejects_reordered_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = self.sample(directory)
            manifest["migrations"] = [
                manifest["migrations"][0],
                {"filename": "0003_later.sql", "sha256": "a" * 64},
            ]
            manifest["requiredSchemaVersion"] = "0003_later"
            release.load_manifest_from_value(manifest)
            manifest["migrations"].reverse()
            with self.assertRaisesRegex(release.ManifestError, "lexically ordered"):
                release.load_manifest_from_value(manifest)

    def test_rejects_baseline_policy_weakening(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = self.sample(directory)
            manifest["legacyBaselinePolicy"] = "auto_adopt"
            with self.assertRaisesRegex(release.ManifestError, "operator_verified_only"):
                release.load_manifest_from_value(manifest)


if __name__ == "__main__":
    unittest.main()
