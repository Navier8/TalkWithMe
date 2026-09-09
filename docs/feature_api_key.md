# API key

This document describes an addition to the TalkWithMe app.
The goal is to allow the user to optionally configure an
API key for use when connecting to any OpenAI-compatible LLM.

## Current state

TalkWithMe was designed from day 1 to be a single-user application
for use on a secure local network. Security was deliberately never
given a high priority. The application currently expects to be able
to connect to any OpenAI-compatible LLM, without an API key.
The assumption was that the LLM would be hosted locally, though
this is technically not enforced - the user can enter any IP
or hostname for their LLM, even if it's outside the local network.

## Desired state

An API key can optionally be specified and used when connecting to
the LLM. There are several key considerations:

- the API key is NOT stored in `settings.yaml` (this file is tracked in git)
- on startup, the app will check for an env var `TALKWITHME_LLM_API_KEY` and
  a file in project root named `llm_api_key`. If both are set, the env var
  is used. If neither are set, no API key will be used.
- `llm_api_key` does NOT exist in git. User must create it. An example
  file called `llm_api_key.example` will be provided. User can rename
  this example file and fill in their key.
- `app/services/llm.py` adds `Authorization: Bearer <key>` to the httpx calls.
  The client currently builds a fresh `AsyncClient` per call - no shared headers,
  so each of the ~3 call sites will need it, or add a small shared-headers object.
- The API key is NEVER shown in the UI. Cannot be viewed/changed at runtime.
- The API key is NEVER logged.
- Add an explicit `.gitignore` entry for `llm_api_key` so that the file is
  not accidentally committed after the user creates it.

### Environment variable

`TALKWITHME_LLM_API_KEY` carries the raw API key as a string value.
If present, it is used verbatim. The env var takes priority over
the `llm_api_key` file.

### `llm_api_key`

An example file `llm_api_key.example` will be committed to git:

```
# If your LLM requires an API key to connect,
# rename this file to llm_api_key and fill
# in the value below.
#
# Alternatively, you can specify the key
# in the env var TALKWITHME_LLM_API_KEY
llm_api_key = your_key_here
```

### Documentation

The `README.md` for this project currently states "Fully local - no internet required,
no authentication". This should be amended:

```
- Fully local — no internet required, no authentication. You can connect to remote LLMs with an API key if you wish, but TalkWithMe can be run 100% locally. NOTE: only connect to remote LLMs that you trust.
```

Additionally, the "MCP tools" section of the README should contain one additional paragraph
warning about security concerns:

```
Be careful connecting MCP servers, especially if you are connecting to a remote LLM.
You are giving the LLM the ability to execute arbitrary tools, which might be a
privacy or security concern.
```

### Transport

TalkWithMe currently does not warn when using `http://` LLM URLs, because the assumption
was that it was being run on a trusted local network. The application should log a
warning when using `http://` and not `https://`: "Warning: your LLM connection uses http;
your chats are sent in cleartext."


