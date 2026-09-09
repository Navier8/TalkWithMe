"""Tests for app/services/llm_auth.py — LLM API key resolution
(docs/feature_api_key.md).

Coverage: env-var/file sources and their priority, the file format, and
the "never logged" invariant. The "never in the settings API / settings.yaml"
invariant lives in test_routers_settings.py.

The autouse fixture in conftest.py points llm_auth._PROJECT_ROOT at the
per-test tmp_path and clears TALKWITHME_LLM_API_KEY, so no test ever
reads the real key file or the developer's environment.
"""

import logging

import pytest

import app.services.llm_auth as llm_auth


def write_key_file(tmp_path, content: str):
    """Write the key file into the (tmp) project root and reset the cache."""
    (tmp_path / llm_auth.KEY_FILENAME).write_text(content, encoding="utf-8")
    llm_auth.invalidate_llm_api_key()


class TestLoadLlmApiKey:
    """load_llm_api_key(): source selection and priority."""

    def test_load_llm_api_key_noSources_returnsNone(self, monkeypatch):
        # GIVEN no env var and no key file (the fixture defaults),
        monkeypatch.delenv(llm_auth.ENV_VAR_NAME, raising=False)
        llm_auth.invalidate_llm_api_key()

        # WHEN the key is resolved,
        # THEN no key is used (a local LLM needs none):
        assert llm_auth.load_llm_api_key() is None

    def test_load_llm_api_key_envVarOnly_returnsEnvValue(self, monkeypatch):
        # GIVEN a key in the environment:
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "sk-abc-123")
        llm_auth.invalidate_llm_api_key()

        # WHEN the key is resolved,
        # THEN the env var value is used:
        assert llm_auth.load_llm_api_key() == "sk-abc-123"

    def test_load_llm_api_key_envVarWithPadding_stripsPadding(self, monkeypatch):
        # GIVEN a padded env var (a common export typo):
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "  sk-padded  ")
        llm_auth.invalidate_llm_api_key()

        # WHEN the key is resolved,
        # THEN the padding is stripped, the key itself untouched:
        assert llm_auth.load_llm_api_key() == "sk-padded"

    def test_load_llm_api_key_blankEnvVar_fallsThroughToFile(self, monkeypatch, tmp_path):
        # GIVEN a blank env var (present but meaningless) AND a key file:
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "   ")
        write_key_file(tmp_path, "llm_api_key = sk-from-file\n")

        # WHEN the key is resolved,
        # THEN the blank var is treated as unset and the file wins:
        assert llm_auth.load_llm_api_key() == "sk-from-file"

    def test_load_llm_api_key_envVarBeatsFile_returnsEnvValue(self, monkeypatch, tmp_path):
        # GIVEN BOTH sources set (the doc's priority rule),
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "sk-from-env")
        write_key_file(tmp_path, "llm_api_key = sk-from-file\n")

        # WHEN the key is resolved,
        # THEN the env var wins:
        assert llm_auth.load_llm_api_key() == "sk-from-env"

    def test_load_llm_api_key_fileOnly_returnsFileValue(self, tmp_path):
        # GIVEN only a key file (comments and blank lines around the key):
        write_key_file(
            tmp_path,
            "# If your LLM requires an API key to connect,\n"
            "# rename this file to llm_api_key and fill\n"
            "# in the value below.\n"
            "\n"
            "   llm_api_key =    sk-from-file   \n",
        )

        # WHEN the key is resolved,
        # THEN the file value is used, with surrounding whitespace stripped:
        assert llm_auth.load_llm_api_key() == "sk-from-file"

    def test_load_llm_api_key_fileWithDuplicateKeyLines_firstWins(self, tmp_path):
        # GIVEN two key lines (ambiguous by definition; first wins):
        write_key_file(
            tmp_path,
            "llm_api_key = sk-first\nllm_api_key = sk-second\n",
        )

        # WHEN the key is resolved,
        # THEN the first line is used:
        assert llm_auth.load_llm_api_key() == "sk-first"

    def test_load_llm_api_key_fileWithoutKeyLine_returnsNoneAndWarns(self, tmp_path, caplog):
        # GIVEN a key file with comments only,
        write_key_file(tmp_path, "# nothing useful here\n# still nothing\n")

        # WHEN the key is resolved,
        with caplog.at_level(logging.WARNING):
            result = llm_auth.load_llm_api_key()

        # THEN no key is used AND a warning explains why:
        assert result is None
        assert "no LLM API key will be used" in caplog.text

    def test_load_llm_api_key_fileWithBareKeyLine_returnsNoneAndWarns(self, tmp_path, caplog):
        # GIVEN a bare key on a line of its own (NOT the documented
        # 'llm_api_key = <value>' format),
        write_key_file(tmp_path, "sk-just-the-key\n")

        # WHEN the key is resolved,
        with caplog.at_level(logging.WARNING):
            result = llm_auth.load_llm_api_key()

        # THEN it is NOT guessed: no key, and a warning is logged:
        assert result is None
        assert "no LLM API key will be used" in caplog.text

    def test_load_llm_api_key_fileValueWithEqualsKeepsRestVerbatim(self, tmp_path):
        # GIVEN a key containing '=' (unusual, but possible in tokens):
        write_key_file(tmp_path, "llm_api_key = sk-abc=def=ghi\n")

        # WHEN the key is resolved,
        # THEN everything after the FIRST '=' is the value:
        assert llm_auth.load_llm_api_key() == "sk-abc=def=ghi"

    def test_load_llm_api_key_fileBlankValue_returnsNone(self, tmp_path):
        # GIVEN a key line whose value is blank:
        write_key_file(tmp_path, "llm_api_key =   \n")

        # WHEN the key is resolved,
        # THEN it is treated as unset:
        assert llm_auth.load_llm_api_key() is None

    def test_load_llm_api_key_fileUnreadable_returnsNoneAndWarns(self, tmp_path, monkeypatch, caplog):
        # GIVEN a key file that raises on read,
        write_key_file(tmp_path, "llm_api_key = sk-should-not-matter\n")

        def boom(self, *args, **kwargs):
            raise OSError("permission denied")

        monkeypatch.setattr(type(llm_auth._PROJECT_ROOT), "read_text", boom)

        # WHEN the key is resolved,
        with caplog.at_level(logging.WARNING):
            result = llm_auth.load_llm_api_key()

        # THEN startup survives: no key, loud warning:
        assert result is None
        assert "Could not read" in caplog.text

    def test_load_llm_api_key_projectRootIsDirectory_namedLlmApiKey_returnsNone(self, tmp_path):
        # GIVEN a DIRECTORY named llm_api_key (a user typo, e.g. a failed
        # rename),
        (tmp_path / llm_auth.KEY_FILENAME).mkdir()
        llm_auth.invalidate_llm_api_key()

        # WHEN the key is resolved,
        # THEN it is not a file: no key, no crash:
        assert llm_auth.load_llm_api_key() is None

    def test_load_llm_api_key_reResolvesOnEachCall(self, monkeypatch):
        # GIVEN a key in the environment, resolved once:
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "sk-one")
        assert llm_auth.load_llm_api_key() == "sk-one"

        # WHEN the environment changes and load runs again,
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "sk-two")
        # THEN the new value is picked up (load always re-resolves; the
        # app simply only ever calls it at startup):
        assert llm_auth.load_llm_api_key() == "sk-two"


class TestGetLlmApiKey:
    """get_llm_api_key(): lazy access for request paths."""

    def test_get_llm_api_key_lazyLoad_resolvesOnFirstAccess(self, monkeypatch, tmp_path):
        # GIVEN a key file but no explicit load_llm_api_key() call
        # (the test client skips the startup lifespan):
        write_key_file(tmp_path, "llm_api_key = sk-lazy\n")

        # WHEN the request path asks for the key,
        # THEN it is resolved on first access:
        assert llm_auth.get_llm_api_key() == "sk-lazy"

    def test_get_llm_api_key_afterInvalidate_resolvesAgain(self, monkeypatch):
        # GIVEN a resolved env-var key,
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "sk-a")
        assert llm_auth.get_llm_api_key() == "sk-a"

        # WHEN the cache is invalidated and the env changes,
        llm_auth.invalidate_llm_api_key()
        monkeypatch.setenv(llm_auth.ENV_VAR_NAME, "sk-b")
        # THEN the next access sees the new value:
        assert llm_auth.get_llm_api_key() == "sk-b"

    def test_get_llm_api_key_noSource_returnsNone(self, monkeypatch):
        # GIVEN no sources at all,
        monkeypatch.delenv(llm_auth.ENV_VAR_NAME, raising=False)
        llm_auth.invalidate_llm_api_key()

        # WHEN the request path asks for the key,
        # THEN None is returned (no header will be sent):
        assert llm_auth.get_llm_api_key() is None


class TestKeyNeverLogged:
    """The key value must never reach the log (docs: 'NEVER logged')."""

    @pytest.mark.parametrize("source", ["env", "file"])
    def test_load_llm_api_key_keyValue_absentFromAllLogRecords(self, source, monkeypatch, tmp_path, caplog):
        sentinel = "sk-sentinel-never-in-logs"
        if source == "env":
            # GIVEN the key in the environment:
            monkeypatch.setenv(llm_auth.ENV_VAR_NAME, sentinel)
            llm_auth.invalidate_llm_api_key()
        else:
            # GIVEN the key in the (tmp) key file:
            write_key_file(tmp_path, f"llm_api_key = {sentinel}\n")

        # WHEN the key is loaded (the only code path that logs about it),
        with caplog.at_level(logging.INFO):
            llm_auth.load_llm_api_key()

        # THEN the log names the SOURCE but never the VALUE:
        assert sentinel not in caplog.text
        if source == "env":
            assert (
                "LLM API key loaded from environment variable TALKWITHME_LLM_API_KEY"
                in caplog.text
            )
        else:
            assert f"LLM API key loaded from {llm_auth.KEY_FILENAME}" in caplog.text
