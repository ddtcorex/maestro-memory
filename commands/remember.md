---
description: Store one durable fact in the shared memory store
argument-hint: <what to remember>
---

Write this to shared memory: $ARGUMENTS

Rules for this write:

1. Search first with `memory_search`. If an entry already says the same thing, extend it instead of
   adding a second one.
2. Pick the track:
   - a standing rule, convention, incident or infrastructure decision about this project, the kind a
     future session must read before acting: show the entry, ask the person with AskUserQuestion, and
     only after a yes write it with `target=key`, `cwd` and `approved:true`. If nobody is there to
     answer, use `memory_suggest` with `target=key` and a one-line `reason` instead.
   - a fact about how the person wants to work: `memory_add` with `target=user`.
   - anything else worth keeping: `memory_add` with `target=memory`, or `target=project` plus this
     project directory as `cwd` when it is tied to this repository.
3. Write the durable fact, not the story of finding it. One entry, one idea, no summary of the
   conversation, and nothing the person did not actually say.
4. Answer with the id the tool returned, or with the message that it was queued for approval. Nothing
   else.
