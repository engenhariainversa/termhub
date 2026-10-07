# Memory report (TER-1009)

`GET /api/chat/memory/report` (web) and `GET /api/m/v1/chat/memory/report` (mobile) measure whether the
decision memory works for the signed-in user: how often it would have suggested the answer the person
actually gave (**replay**), and how often the person answered the same question again (**repeated
question**). Read-only: it changes nothing, suggests nothing and sends nothing.

Code: `apps/server/src/chat/memory-report.ts` (the pure calculation, unit-tested in
`memory-report.test.ts`) over `ChatDecisionsRepository.replayDataset`
(`apps/server/src/db/repositories/chat-decisions.ts`, Postgres-tested in `chat-decisions.db.test.ts`).

## Query

| Parameter   | Default                                          | Meaning                                                               |
|-------------|--------------------------------------------------|-----------------------------------------------------------------------|
| `threshold` | the server's `DECISION_SUGGEST_THRESHOLD`        | Similarity (0–1) for a suggestion and for "the same question".        |
| `period`    | `month`                                          | `month` (`YYYY-MM`, UTC) or `week` (the Monday, `YYYY-MM-DD`, UTC).   |

## Dataset

Every `chat_decisions` row is one answered question of a `choice` card: the question, its options, the
person's answer, the date and the project. The dataset is the requester's own rows, embedded under the
current text version (`embed_model` ending with `#q1`), at most the newest 2000, oldest first. Every
neighbour query also filters `user_id` to the same person, so no other user's question or answer ever
enters the numbers. Rows the sweeper has not embedded yet (or embedded under an older text version)
are left out and counted in `dataset.unembedded`.

## Replay

For each decision, the memory is rebuilt as it stood right before it: its `k` = 5 nearest *earlier*
decisions of the same `multi_select` shape and the same embedding model, never one of the same card.
That is what `nearest` would have answered when the card opened. The cards' own rule then picks the
precedent (`pickPrecedent`, shared with `suggestFor`): only neighbours at or above `threshold`, newest
first, the first whose answer still maps onto this question's options. Outcomes:

- `hit`: the precedent's answer, mapped onto this question's options, equals what the person answered
  (same selected options; free text compared trimmed).
- `miss`: a precedent was found but the person answered something else. The newest 50 are listed in
  `replay.misses` with the question, the real answer, the suggestion and the precedent it came from.
- `no_precedent`: nothing earlier was close enough, or none of the close ones mapped.

`hit_rate = hit / (hit + miss)` is how often a suggestion would have been right; `coverage = (hit +
miss) / total` is how often the memory would have suggested anything. `replay.curve` repeats the
replay at 0.85, 0.90, 0.92, 0.94, 0.96, 0.98 and 0.99, the trade-off between the two, to choose a
threshold from data (the base for per-user thresholds, TER-642).

Limits: the replay uses today's embeddings and today's rule, not the ones in force when the question
was answered; deleted decisions are gone from the memory and from the report alike.

## Repeated question

A decision is a **repeat** when its single nearest earlier decision *in the same scope* — the same
project, or both without a project — has a similarity at or above `threshold`, whatever the shape.
Never two questions of the same card.

- `answers`: decisions measured; `repeated`: how many are repeats; `rate = repeated / answers`.
- `same_answer`: repeats answered exactly as before — answers the memory could have spared the person.
  A repeat with a different answer means the person changed their mind or the questions only look alike.
- `questions`: distinct equivalent questions answered more than once (repeat pairs joined into groups:
  A, then B like A, then C like B is one question answered three times).
- `by_project` and `by_period` split the same counts by the decision's project and by the period of the
  repeat's own date.

A falling `rate` over the periods, with a high `hit_rate`, means the memory is doing its job.
