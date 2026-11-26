# Data compatibility, sync and recovery

This standard applies to storage, sync protocol, import and MCP write changes. Review them under
the [review and merge workflow](review-and-merge.md). Include the affected formats, supported
upgrades and failure recovery in the PR. Changes to this standard require the maintainer's
approval of the final diff.

## Local data and upgrades

- Save tracking changes on the device first. Local tracking works without an account or network.
  A rejected upload, a server outage or a failed upgrade must preserve local entries and pending
  edits. Before discarding unsynced data, explain what will be lost and offer a copy, then request
  confirmation.
- Version device storage, server storage and the wire protocol independently. Map storage to
  logical records through explicit wire encoders and decoders.
- Test upgrades from supported prior versions using synthetic fixtures. Verify record meaning,
  timestamps, units, amounts and references as applicable. A failed or interrupted migration
  must roll back or resume safely. Validate the recovery path before replacing data.
- Keep prior wire fixtures fixed once published. Negotiate a compatible version before sending
  writes. Reject unsupported changes explicitly, preserving pending work for recovery. Document
  which app and server versions worked together in tests.

## Sync and MCP writes

- Sync individual records by stable ID. The server validates the update and its expected revision
  and assigns the new revision atomically. Retrying a write must avoid duplication or replaying
  effects. Deletions must prevent an older client from restoring deleted records inadvertently.
- Reject stale writes on the server. The app can reconcile independent edits with a three-way
  merge using the original, local and server values. Compare fields individually and match
  nested items by stable ID. Keep both values when edits overlap, including edit versus delete,
  and let the user resolve the conflict. Revalidate the result against the current server revision.
- Use authenticated, scoped MCP patches that include the values the agent saw for edited fields.
  Apply the same ownership, validation and stale-write checks used for app writes. Never expose
  another account's records as part of a conflict response.
- Support managed and self-hosted sync with the same protocol. Scope records, revisions and sync
  cursors to the account. Connecting to a different account or server must preserve local work
  until the user chooses how to move it.

## Imports, exports and review evidence

- Validate import input and report invalid rows. Retrying the same import after interruption
  must avoid duplicates. Keep nutrition snapshots, units and dates meaningful after import.
- Export data in a documented format. Verify that exported records can be restored before using
  an export as a recovery path.
- Check the cases the change can affect, such as an interrupted migration, lost response and retry,
  stale write, conflicting edits, deleted references and unsupported peer. Record the commands,
  outcomes and the recovery procedure in the PR.
