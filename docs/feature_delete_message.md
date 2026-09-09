# Selective message deletion

This document describes an addition to the TalkWithMe app.
The goal is to let the user delete individual messages from the chat view —
both persona replies and the user's own messages — with the deletion
propagating to the room's persistence directory: the message is removed from
`history.json` and all of its associated audio files are deleted from disk,
while every other message (text and audio) in the room is left untouched.

## Current state

The chat view renders every message as a bubble (user and persona), but
offers no way to remove an individual one. The only existing deletion is
all-or-nothing:

- **"New Chat"** (`POST /api/session/new`) calls `session.reset()`, which
  clears the in-memory history and calls `persistence.clear_room()` — every
  file in the room's persistence subdirectory is deleted at once.
- **Deleting a chat room** (`DELETE /api/chatrooms/{name}`) removes only the
  room's entry in `chatrooms.yaml`. (The room's persistence directory is in
  fact left on disk as an orphan — a separate, pre-existing issue outside
  the scope of this feature.)

There is no API to remove a single message, and no per-message identity in
the in-memory session: `ChatMessage` (in `app/models.py`) carries only
`role`, `content`, and `persona`. Message UUIDs exist on disk (each
`history.json` row has an `id`, and audio files are named after it) and are
known to the frontend for every rendered bubble (`data-message-id` on each
message row), but the backend session discards them after the disk write.
As a result, even if a message were removed from `history.json`, it would
keep being supplied to the LLM via `build_llm_messages()` for the rest of
the session, until the room was reloaded.

## Desired state

Each chat bubble in the chat view has a small delete button beside it, for
user messages and persona replies alike. Clicking it deletes exactly that
message:

- the message row is removed from `history.json` for the room,
- every audio file associated with that message is deleted from the room's
  persistence directory,
- the message is removed from the in-memory session history, so it no longer
  reaches the LLM for subsequent conversation turns,
- no other message in the room — text, audio, or otherwise — is affected.

The feature is not optional and needs no configuration: every rendered
message bubble gets the button.

### UI changes

A small delete button (a trash/✕ icon, styled after the existing
`.audio-play-btn`) is added to every persisted message row:

- **User rows**: inside the `.user-message-content` wrapper, next to the
  bubble/audio.
- **Persona rows**: inside `.bubble-content`, next to the bubble/audio.
- The button is revealed on hover of the message row (always visible on
  touch devices).
- **Streaming persona bubbles**: the button is rendered but kept
  disabled/hidden until the stream settles: the `done` event on success,
  or the `error` event for a stream that died before persisting. The
  assistant row is only written to disk at the end of a successful
  stream, so a button visible mid-stream would have nothing to delete
  yet. The `error` case is deliberate, not an oversight: the 404 clause
  in the click behavior below names a reply that "errored before
  completion" as a deletable case, and gating on `done` alone would leave
  such a row permanently undeletable. A click on it 404s and the handler
  removes the row from view, so display and disk end up in agreement.
- **Error bubbles** (`appendErrorBubble`) are not persisted and carry no
  message ID — they get no delete button.

Click behavior:

1. Call `DELETE /api/persist/message/<room>/<message_id>` with the current
   room and the row's `data-message-id`.
2. On a 200, remove the row from the DOM.
3. On a 404 (the row was never persisted — e.g. a persona reply whose stream
   errored before completion, which is never written to disk), also remove
   the row from the DOM and log a warning: there is nothing on disk to
   clean up, so the display and disk end up in agreement.
4. On any other failure, keep the row and log a warning. The user can retry.

There is no confirmation dialog: this is a single-user local app, and the
worst case of a mis-click is one recoverable message. (A confirm could be
added later if it ever feels necessary.)

### API changes

New endpoint, in `app/routers/persistence.py` alongside the existing
`/api/persist/*` routes:

```
DELETE /api/persist/message/{room_name}/{message_id}
```

- 200 `{"status": "deleted"}` when the message was found and removed.
- 404 when the room has no message with that ID (nothing was deleted).
- Sync `def` handler, matching the existing `upload_audio` route: it runs
  in FastAPI's thread pool, and the persistence core serializes with its
  own lock (see Concurrency).

The endpoint also reconciles the in-memory session: if `room_name` equals
`session.current_room`, the matching entry is removed from the in-memory
history as well. Deletes for other rooms touch disk only (the in-memory
session holds the current room's history exclusively).

The AGENTS.md "API endpoints" table must gain a row for this endpoint —
`tests/test_docs.py` asserts the table matches the routes registered on the
app, and will fail a clean run otherwise.

### Persistence changes

A new framework-agnostic function in `app/persistence.py`:

```python
def delete_message(room_name: str, message_id: str) -> bool
```

The whole operation runs under the existing `_HISTORY_LOCK` (the same lock
that serializes `persist_message` and `persist_audio` read-modify-write
cycles), so it is atomic with respect to concurrent audio uploads:

1. Read the room's `history.json`.
2. Find the message row by ID. If there is no such row, return `False` —
   no write, no cleanup.
3. Remove the row from `messages`.
4. Delete each file named in the removed row's `audio` array, with
   `missing_ok=True` (a hand-deleted file on disk is not an error).
   Entries are first validated as plain filenames: `history.json` is
   hand-editable, so a traversal entry (`../../settings.yaml`) or a
   non-string value must be skipped with a warning rather than joined —
   without this check the delete would be arbitrary file deletion.
5. Drop any `_pending_audio[(room_name, message_id)]` staging-registry
   entries and best-effort delete those staged files (see Concurrency for
   why this matters).
6. Best-effort sweep of the room directory for any other file whose name
   starts with `<message_id>_`. Message IDs are UUIDv4, so the prefix is
   unambiguous and can never match another message's files. This catches
   files that already exist at delete time but are referenced by no row
   (e.g. staging files orphaned by an earlier crash — see Concurrency).
7. Write the updated history back with the existing atomic
   `_write_history_file()` (temp file + `os.replace`).
8. Return `True`.

The room's top-level `datetime` field is left as-is: it records the time of
the most recent message write, and deleting an older message is not a new
message.

### Session changes

The in-memory session must learn to track message IDs, or a deleted message
would keep being fed to the LLM until the room is reloaded:

- `ChatMessage` gains an optional `id` field (`Optional[str] = None`).
  Optional, so existing construction sites and tests are unaffected.
- `add_user_message()` and `add_assistant_message()` stamp the
  `message_id` they already receive onto the `ChatMessage` they create
  (today they discard it after the disk write).
- `load_room()` copies `msg["id"]` from the persisted rows when it
  repopulates the session, so reloaded rooms keep working after deletes.
- New method `remove_message_by_id(message_id) -> bool`: removes the
  matching entry from the in-memory history, returns `False` if absent.
  Matching is by ID only — never by text or sender, so duplicate messages
  can't be mistaken for each other.

`build_llm_messages()` needs no changes: it iterates the (now shorter)
history list, and the deleted message simply stops being in it.

### Behavior and edge cases

- **Deleting a user message mid-reply.** The user row is persisted as the
  chat request starts; any persona replies already generated are
  independent rows and survive. Deleting the user message does not cascade
  to its replies — and the replies' LLM context for the *rest* of the
  stream was already built. This is the intended "surgical" semantics.
- **Deleting a persona message.** Independent row, independent ID. Any
  replies that came after it stay, and the deleted text stops reaching the
  LLM from the next turn onward.
- **Premature delete of a still-streaming persona message.** Prevented
  twice over: the button is disabled until the stream settles — `done` on
  success, `error` for a dead stream (UI) — and the endpoint returns 404
  while the row is not on disk (server). If both are somehow bypassed,
  the server-side design below means the worst outcome is a staged audio
  orphan (cleaned up by the delete if the upload landed before it; left
  behind if it landed after — see Concurrency) — never a corrupt
  `history.json` or a lost sibling message.
- **Audio uploads in flight at delete time.** The frontend fires TTS/STT
  uploads without awaiting them, so one can race the delete. The
  lock-serialized design handles both interleavings (see Concurrency).
- **Messages rendered from persisted history** (room load/switch) get the
  button immediately: the row exists in `history.json`, and its `audio`
  array is the complete contract. An upload that was in flight when the
  page reloaded is covered by the same staging-registry/sweep cleanup.
- **Old orphaned audio** (staged before a process crash, never attached to
  a row) is pre-existing housekeeping and out of scope: the delete feature
  only ever cleans up files for the message ID being deleted.
- **Room name in the path.** Follows the existing `/api/persist/*` pattern
  (rooms are created through a validating API). Optionally validate against
  the same `^[a-zA-Z0-9 _-]+$` pattern used at room creation.

### What this feature does NOT do

- No message editing, no reply cascades, no undo.
- No effect on persona memories (`Personas/*/memories.txt`) — a persona
  that memorized a fact from a deleted message keeps the memory. Deleting
  the memory remains the persona editor's job.
- No change to "New Chat" or room deletion behavior.

## Implementation notes

Per-file change map:

| File | Change |
|------|--------|
| `app/persistence.py` | New `delete_message()` (~35 LOC), per the spec above. Optional DRY win: extract a `_find_message(data, message_id)` helper shared with `persist_audio()`. |
| `app/models.py` | `ChatMessage.id: Optional[str] = None` (1 line). |
| `app/session.py` | Stamp IDs in `add_user_message()` / `add_assistant_message()`; copy IDs in `load_room()`; new `remove_message_by_id()` (~25 LOC). |
| `app/routers/persistence.py` | New `DELETE /api/persist/message/{room_name}/{message_id}` route (~20 LOC): call `delete_message()`, 404 on `False`, then conditionally `session.remove_message_by_id()` when the room is the current one. |
| `static/chat.js` | `addDeleteButtonToRow(row, messageId)` helper + wiring into the four render paths: `appendUserBubble()`, `appendPersistedUserBubble()`, `appendPersistedAssistantBubble()`, and the live assistant row (button rendered on bubble creation, disabled until the `done` or `error` handler enables it). Click handler per the UI spec (~70 LOC). |
| `static/style.css` | `.message-delete-btn` styling modeled on `.audio-play-btn`, hover-reveal on `.message-row` (~20 LOC). |
| `AGENTS.md` | Add the endpoint to the API table (required by `test_docs.py`); a sentence in the "Chat persistence" section noting single-message deletion. |

### Considered and rejected: gating the button on audio completion

An alternative design was considered in which the delete button only
appears once *all* of a message's TTS uploads have provably settled — a
per-message outstanding-counter in the frontend, incremented at TTS enqueue
and decremented when each persistence upload resolves. It was rejected in
favor of the simpler stream-settled gate (`done` on success, `error` for
a dead stream) plus the server-side cleanup above,
because even a premature delete is safe for everything that matters:
the `history.json` read-modify-write stays atomic under the lock, so the
worst possible outcome is a bounded staged-audio orphan — removed by the
delete when the upload landed before it, left behind (one small file)
when the upload landed after it — never a corrupt history file or a lost
sibling message.
The counter would have added ~40 lines of cross-file state tracking (and a
subtle double-settle hazard around audio decode failures) to guard against
a failure mode the backend already neutralizes.

## Development plan

Ordered so each step is independently testable; steps 1–3 are backend,
4–5 frontend/docs, 6 verification.

1. **Persistence core** — implement `delete_message()` in `app/persistence.py`
   (lock, row removal, staging-registry pop, audio unlink, prefix sweep,
   atomic write). Write its tests (below) first or alongside.
2. **Session ID tracking** — `ChatMessage.id`, stamping in both `add_*`
   methods, ID copy in `load_room()`, `remove_message_by_id()`.
3. **Endpoint** — the `DELETE /api/persist/message/{room_name}/{message_id}`
   route with the 404 and in-memory-reconciliation behavior.
4. **Frontend** — delete button helper + four render-path wirings + click
   handler in `static/chat.js`; `.message-delete-btn` CSS in `static/style.css`.
5. **Docs** — AGENTS.md API table row + Chat persistence note.
6. **Verification** — full clean run: `python -m pytest` all green
   (including `test_docs.py`), plus `node tests/test_persona_form.js` and
   `node tests/test_tts_settings.js` for completeness (no changes expected
   to their scope).

Rough size: ~80–100 new backend LOC plus ~30 changed, ~90 frontend
LOC (JS + CSS), ~17 new tests. A half-day to a day for someone familiar
with the codebase; no migrations, no new dependencies, no breaking API
changes (the `ChatMessage.id` field is additive).

## Testing

Per project rules, the tests below exist before the feature is considered
complete, and the suite must end all green with no skips.

`tests/test_persistence.py` (new test class for `delete_message`):

- deletes the target row and its audio files; sibling rows and their audio
  files are untouched (assert both text and on-disk files).
- unknown message ID returns `False` and leaves `history.json` unchanged.
- missing room returns `False` without raising or creating anything.
- a message with staged (pre-row) audio: the staging-registry entry is
  dropped and the staged file deleted.
- an orphan file matching the `<message_id>_` prefix but absent from the
  `audio` array is also deleted by the sweep.
- an `audio` entry whose file is missing on disk does not raise.
- hand-crafted unsafe `audio` entries in a `history.json` row (path
  traversal, bare "." / "..", non-string values) are skipped with a
  warning: the row is still deleted, safe sibling entries still removed,
  and no file outside the room directory is touched.
- returns `True` on a successful delete.
- concurrency: `delete_message` racing `persist_audio` / `persist_message`
  from threads causes no lost updates or corrupt `history.json`
  (patterned on `test_concurrent_persist_message_no_lost_updates`).

`tests/test_session_manager.py`:

- `add_user_message` / `add_assistant_message` store the message ID on the
  in-memory `ChatMessage`.
- `load_room` carries the persisted IDs into the in-memory history.
- `remove_message_by_id` removes exactly the matching entry — including
  when another message has identical text/sender.
- `remove_message_by_id` with an unknown ID returns `False` and changes
  nothing.

`tests/test_routers_persistence.py`:

- `DELETE` returns 200 and removes the row + audio from disk.
- `DELETE` with an unknown ID returns 404 and changes nothing.
- `DELETE` for the current room also removes the entry from the in-memory
  session history.
- `DELETE` for a non-current room leaves the in-memory session history
  untouched.

`tests/test_docs.py` already covers the AGENTS.md endpoint table; the new
endpoint's row (dev plan step 5) is what keeps it green.

The button/gate logic lives in `static/chat.js` / `static/tts.js`, which
are outside the plain-Node test harnesses (they cover `persona.js` and
`settings.js` only), so no Node-suite change is required. Extending the
existing `vm.Context` harness to the chat bubble flow is a reasonable
follow-up, not a requirement of this feature.

## Concurrency

All access to a room's `history.json` — including the new delete — is
serialized through `app/persistence.py`'s `_HISTORY_LOCK`, and writes go
through the atomic temp-file + `os.replace` path. The one real race is an
audio upload in flight (the frontend fires them without awaiting — TTS
uploads land *after* the `done` event that enables the delete button, so
"delete the last reply while its audio is still uploading" is the normal
flow, not an exotic one) at the moment a message is deleted. Because the
lock runs every upload and the delete to completion without interleaving,
there are exactly two orderings — an upload can never be mid-write while
the delete's sweep runs:

- **Upload lands before the delete.** Fully clean. The delete re-reads
  `history.json` under the lock and sees the upload's result: if the row
  existed, the file was attached to the row's `audio` array and the
  delete unlinks it (step 1); if the row did not exist yet, the file was
  staged and registered in `_pending_audio`, and the delete pops the
  registry entry and unlinks it (step 2). Nothing survives.
- **Delete lands before the upload.** The row is already gone, so the
  late `persist_audio()` takes the staging path: it writes a
  `<message_id>_pending_<hex8>.<ext>` file and registers it in
  `_pending_audio` — *after* the delete's sweep has run, so the sweep
  cannot see it. The row is never recreated, so the file (and its
  registry entry, until process restart) is left behind as an orphan.
  The residue is bounded (one file per late upload), invisible in the UI
  (no row references it), and the same class as the pre-existing crash
  orphans scoped out in *Old orphaned audio* above. Closing it would
  require a deleted-ID tombstone that `persist_audio()` consults —
  considered, and not worth the extra state for a small, invisible leak.

The directory sweep (step 3) therefore covers a different case than the
late-upload ordering above: files that *already exist* at delete time
but are referenced by nothing — e.g. staging files orphaned by a crash
(the in-memory registry is lost on restart, the files are not). Because
message IDs are UUIDv4, the sweep's `<message_id>_` prefix can never
match another message's files.

The net guarantee: a delete is atomic with respect to concurrent uploads
for `history.json` itself — no lost updates, no corrupt file, no lost
sibling message — and the only residue a race can produce is a staged
orphan file when an upload lands after the delete.
