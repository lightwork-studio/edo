# Review and merge

Start from current `main`. State the expected outcome and what would show that it works.
Open a focused draft pull request while the change is in progress. Use a separate pull request
for unrelated work so each change can be reviewed and reverted on its own.

Run `pnpm check` before asking for review. Changes to behavior need a regression test with a
realistic case and an expected outcome. When changing app build inputs, run `pnpm check:builds`
locally. Shared CI runs both commands with read-only access.

An independent reviewer checks the proposed commit, relevant callers and tests. Pure copy changes
can use an author check where the configured branch rules allow it. Changes listed below need a
second independent review focused on the affected boundary. The PR records the reviewed commit,
findings and their disposition, validation, risk and recovery. Re-review substantive changes made
after review.

## Before merging

- Resolve blocking findings and outstanding comments. Changes to review gates, merge automation or
  the [data compatibility standard](data-compatibility.md) require explicit maintainer approval
  of the final diff.
- Verify a successful PR CI `check` on GitHub's simulated merge for the triggering event. Confirm
  that the checkout SHA in the run log has the exact PR head to be merged as its second parent.
  If the run tested a different checkout, update the PR and wait for a new run.
- Immediately before merging, fetch `main` from the PR's base repository
  (`git fetch <base-repo-url> refs/heads/main`). Use the fetched commit as `<base-sha>` only after
  the fetch succeeds. Merge when the head includes the base
  (`git merge-base --is-ancestor <base-sha> <head-sha>`) or when all of these hold:
  - The PR is mergeable. `gh pr view <pr-url> --json mergeable` must report `MERGEABLE`. Wait if
    it reports `UNKNOWN`.
  - The paths changed since the common ancestor (`git merge-base <base-sha> <head-sha>`) do not
    overlap. Compare the lists from `git diff --no-renames --name-only <ancestor> <head-sha>` and
    `git diff --no-renames --name-only <ancestor> <base-sha>`.
  - Neither side changes a published wire fixture covered by the
    [data compatibility standard](data-compatibility.md).

  If the head is behind and any condition fails, update the branch and wait for `check` on the
  new head. Recheck before merging if the base or head changes.
- Find the newest commit on `main` with a finished CI `check`. A cancelled run counts as
  unfinished. The check must have succeeded. If it failed, merge only its fix or revert.
  The first PR that establishes CI may proceed once its own check passes and the maintainer
  has approved the final diff.
- Squash merge with `gh pr merge <pr-url> --squash --match-head-commit <head-sha>`. When the PR
  author is also the only eligible code owner, the maintainer's configured bypass may be used
  solely for the unavailable code-owner approval after all other merge gates pass.

## Changes that need additional review

- **Authentication and authorization** need a trust-boundary review, tests for denied access
  including cross-account access where applicable, and a way to disable or roll back the change.
- **Personal data** changes need review of ownership, exposure, deletion, retries and recovery.
- **Storage, sync, imports and MCP writes** follow the
  [data compatibility standard](data-compatibility.md). Changes to stored formats need realistic
  prior data, preserved meaning, recovery evidence and passing compatibility tests.
- **Deployment and credentials** need evidence that fork PRs run without release credentials
  and that a protected release job can publish only the reviewed revision.
- **Review gates and merge automation** need a focused review of which code runs in CI, which
  credentials it can access and how gate failures block delivery.
