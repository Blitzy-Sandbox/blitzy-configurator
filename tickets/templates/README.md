# Templates

This folder contains empty ticket scaffolds. Use them to author new epics and stories.

## Files

- `epic-template.md` — scaffold for a new epic (destination: `/tickets/epics/EP-00N-[slug].md`)
- `story-template.md` — scaffold for a new story (destination: `/tickets/stories/ST-00N-[slug].md`)

## How to Create

1. Copy the appropriate template file (`epic-template.md` for an epic, `story-template.md` for a story).
2. Rename the copy to the next sequential ID with a kebab-case slug — for example `EP-013-new-epic-slug.md` or `ST-050-new-story-slug.md`. IDs are zero-padded to three digits.
3. Move the renamed copy into `/tickets/epics/` (for epics) or `/tickets/stories/` (for stories).
4. Replace every `<placeholder>` token with a real value.
5. For story files only: if the story requires a `test-type` or `depends-on` field, remove the leading `# ` comment prefix to activate that line; otherwise delete the commented line entirely.
6. Validate the frontmatter against the schema below and confirm the body meets the authoring rules.

## Frontmatter Reference

### Epic frontmatter fields

- `id` — `EP-00N`, zero-padded to three digits (`EP-001` through `EP-012`, sequential; the next new epic takes `EP-013`).
- `title` — Title Case descriptive phrase.
- `layer` — exactly one of: `frontend`, `backend`, `database`, `ci-cd`, `testing`, `observability`.
- `stories` — non-empty list of child story IDs (e.g., `[ST-001, ST-002]`).

### Story frontmatter fields

- `id` — `ST-00N`, zero-padded to three digits, globally unique, sequentially numbered with no gaps.
- `title` — Title Case action-oriented phrase.
- `epic` — parent epic ID (`EP-00N`).
- `layer` — exactly one value from the permitted set: `frontend`, `backend`, `database`, `ci-cd`, `testing`, `observability`.
- `points` — Fibonacci value only: `1`, `2`, `3`, `5`, `8`, or `13`.
- `priority` — `high`, `medium`, or `low`.
- `test-type` — EP-010 children only: `unit`, `integration`, `e2e`, or `visual-regression`. Omit on all other stories.
- `depends-on` — optional list of prerequisite story IDs. Omit the field when the list is empty.

## Authoring Rules

- Technology-neutral vocabulary only — no library, framework, cloud, platform, or product proper nouns anywhere in field values or body.
- Every story body MUST contain at least three observable acceptance criteria rendered as Markdown checklist items (`- [ ]`).
- Every story is scoped to exactly one layer. Work that spans two layers MUST be split into separate stories linked via `depends-on`.
- Every story body opens with the persona narrative `As a <persona>, I want <capability>, so that <value>.` using a persona drawn from the fixed vocabulary: `end user`, `authenticated user`, `developer`, `QA engineer`, `DevOps engineer`.
- Every epic body lists at least one child story ID in its frontmatter `stories` array.

## Validation

- Frontmatter parses as valid YAML and contains every required field.
- Story file contains a Narrative section with the persona sentence and an Acceptance Criteria section with three or more checklist items.
- Story `points` is one of `1`, `2`, `3`, `5`, `8`, `13`.
- Story `layer` is one of the six permitted values.
- Story IDs across `/tickets/stories/` remain sequential with no gaps.
- Epic IDs across `/tickets/epics/` remain sequential with no gaps.
