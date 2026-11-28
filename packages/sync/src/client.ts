import {
  type AuthenticatedHistory,
  acceptHello,
  decodeNegotiationRefused,
  decodePullRequest,
  decodePullResponse,
  decodePushRequest,
  decodePushResponse,
  decodeSyncError,
  type HelloRequest,
  maxSyncEnvelopeBytes,
  type NegotiatedSync,
  type PullResponse,
  type PushResponse,
  type Submission,
  type SyncRelease,
  SyncWireError,
  syncCandidate,
  syncScope,
} from "@edo/contract";

interface SyncClientOptions {
  readonly origin: string;
  readonly authorization: () => string | Promise<string>;
  readonly releases?: readonly SyncRelease[];
  readonly fetch?: typeof fetch;
  /** Local HTTP fixtures may use loopback. Other origins require TLS. */
  readonly allowLoopbackHttp?: boolean;
}

type SavedHistory = Pick<AuthenticatedHistory, "accountBinding" | "lineage" | "revision"> & {
  readonly server: string;
};

type HistoryReview =
  | { readonly status: "server-moved" | "account-changed"; readonly server: string }
  | {
      readonly status: "same-history" | "lineage-changed" | "cursor-reset";
      readonly server: string;
      readonly observed: Pick<AuthenticatedHistory, "lineage" | "revision" | "restoredFrom">;
    };
export const maxSyncRequestBytes = (maxSyncEnvelopeBytes * 3) / 4;
const serversBySession = new WeakMap<NegotiatedSync, string>();
const responseOrigin = new WeakMap<
  PushResponse | PullResponse,
  {
    session: NegotiatedSync;
    snapshot: string;
    read: () => PushResponse | PullResponse;
    cursor?: number;
    sent?: ReadonlyMap<string, string>;
  }
>();

export function syncRequestBytes(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength;
}

export function serverForSession(session: NegotiatedSync): string {
  const server = serversBySession.get(session);
  if (!server) throw new SyncWireError("update-required", "Connect before binding this diary");
  return server;
}

export function authenticatedResponseSnapshot(
  response: PushResponse,
  session: NegotiatedSync,
): PushResponse;
export function authenticatedResponseSnapshot(
  response: PullResponse,
  session: NegotiatedSync,
  cursor: number,
): PullResponse;
export function authenticatedResponseSnapshot(
  response: PushResponse | PullResponse,
  session: NegotiatedSync,
  cursor?: number,
): PushResponse | PullResponse {
  const origin = responseOrigin.get(response);
  if (!origin || origin.session !== session) {
    throw new SyncWireError("update-required", "The response was not issued for this connection");
  }
  if (origin.cursor !== cursor) {
    throw new SyncWireError("cursor-reset", "The response belongs to a different pull cursor");
  }
  if (origin.snapshot !== JSON.stringify(response)) {
    throw new SyncWireError("invalid-request", "The response changed after validation");
  }
  // Decode from the private wire value again so the journal owns its copy.
  return origin.read();
}

export function assertReceiptMatchesAttempt(response: PushResponse, attempt: Submission): void {
  const sent = responseOrigin.get(response)?.sent?.get(attempt.submissionId);
  if (sent !== JSON.stringify(attempt)) {
    throw new SyncWireError("invalid-request", "The receipt belongs to a different submission");
  }
}

export function normalizeSyncServer(value: string, allowLoopback: boolean) {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(allowLoopback && loopback))
  ) {
    throw new TypeError("Account sync needs a secure server URL");
  }
  return url.href.replace(/\/+$/, "");
}

function unavailable(message: string): never {
  throw new SyncWireError("unavailable", message);
}

async function readResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxSyncEnvelopeBytes) {
    await response.body?.cancel();
    return unavailable("The sync response exceeded the byte limit");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxSyncEnvelopeBytes)
      return unavailable("The sync response exceeded the byte limit");
    return JSON.parse(decoder.decode(bytes));
  }
  const stream = response.body.getReader();
  const fragments: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await stream.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxSyncEnvelopeBytes) {
        await stream.cancel();
        return unavailable("The sync response exceeded the byte limit");
      }
      fragments.push(decoder.decode(next.value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join(""));
  } finally {
    stream.releaseLock();
  }
}

export function createSyncClient({
  origin,
  authorization,
  releases = [syncCandidate],
  fetch: send = fetch,
  allowLoopbackHttp = false,
}: SyncClientOptions) {
  const base = normalizeSyncServer(origin, allowLoopbackHttp);
  const hello: HelloRequest = {
    releases: releases.map(({ release }) => release),
    features: [...new Set(releases.flatMap(({ features }) => features))],
  };
  let active: { session: NegotiatedSync; authorization: string } | null = null;
  let generation = 0;

  function assertCurrent(isCurrent: () => boolean) {
    if (!isCurrent()) {
      throw new SyncWireError(
        "account-changed",
        "The account connection changed before the request finished",
      );
    }
  }

  async function post(
    path: "hello" | "push" | "pull",
    body: unknown,
    options: { authorization: string; isCurrent: () => boolean; signal?: AbortSignal },
  ) {
    const { authorization, isCurrent, signal } = options;
    assertCurrent(isCurrent);
    const serialized = JSON.stringify(body);
    if (syncRequestBytes(serialized) > maxSyncRequestBytes) {
      throw new SyncWireError("invalid-request", "The sync request needs a smaller batch");
    }
    let response: Response;
    let payload: unknown;
    try {
      response = await send(`${base}/sync/${path}`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: serialized,
        signal,
        credentials: "omit",
        redirect: "error",
      });
      payload = await readResponse(response);
      assertCurrent(isCurrent);
    } catch (error) {
      if (signal?.aborted || error instanceof SyncWireError) throw error;
      return unavailable("Could not read a response from the sync server");
    }
    if (path === "hello" && response.status === 426) {
      decodeNegotiationRefused(payload);
      throw new SyncWireError("update-required", "No compatible account sync release is available");
    }
    if (!response.ok) {
      const { error } = decodeSyncError(payload);
      throw new SyncWireError(error.code, error.message);
    }
    return payload;
  }

  function scope(session: NegotiatedSync, signal?: AbortSignal) {
    const connection = active;
    if (!connection || connection.session !== session) {
      throw new SyncWireError("update-required", "Connect to this server before syncing records");
    }
    return {
      wire: syncScope(session),
      request: {
        authorization: connection.authorization,
        isCurrent: () => active === connection,
        signal,
      },
    };
  }

  function beginConnection() {
    const attempt = ++generation;
    if (active) serversBySession.delete(active.session);
    active = null;
    return () => generation === attempt;
  }

  async function requestHello(isCurrent: () => boolean, signal?: AbortSignal, request = hello) {
    const header = await authorization();
    const reply = await post("hello", request, { authorization: header, isCurrent, signal });
    return { header, reply };
  }

  return {
    server: base,
    async connect(previous?: SavedHistory, signal?: AbortSignal) {
      const isCurrent = beginConnection();
      if (previous && previous.server !== base) {
        throw new SyncWireError(
          "account-changed",
          "The saved diary belongs to a different sync server",
        );
      }
      const { header, reply } = await requestHello(isCurrent, signal);
      assertCurrent(isCurrent);
      const session = acceptHello(hello, reply, previous, releases);
      serversBySession.set(session, base);
      active = { session, authorization: header };
      return session;
    },
    /** Read a recovery decision for the saved binding without enabling push or pull. */
    async reviewHistory(previous: SavedHistory, signal?: AbortSignal): Promise<HistoryReview> {
      const isCurrent = beginConnection();
      if (previous.server !== base) return { status: "server-moved", server: base };
      if (!Number.isSafeInteger(previous.revision) || previous.revision < 0) {
        throw new SyncWireError("invalid-request", "Invalid saved account revision");
      }
      const request: HelloRequest = { releases: hello.releases, features: [] };
      const { reply } = await requestHello(isCurrent, signal, request);
      assertCurrent(isCurrent);
      const observed = acceptHello(request, reply, undefined, releases);
      if (observed.accountBinding !== previous.accountBinding) {
        return { status: "account-changed", server: base };
      }
      const { lineage, revision, restoredFrom } = observed;
      const status =
        lineage !== previous.lineage
          ? "lineage-changed"
          : revision < previous.revision
            ? "cursor-reset"
            : "same-history";
      return { status, server: base, observed: { lineage, revision, restoredFrom } };
    },
    async push(session: NegotiatedSync, submissions: readonly Submission[], signal?: AbortSignal) {
      const current = scope(session, signal);
      const request = decodePushRequest({ ...current.wire, submissions }, session);
      const reply = await post("push", request, current.request);
      assertCurrent(current.request.isCurrent);
      const response = decodePushResponse(reply, request, session);
      const sent = new Map(
        request.submissions.map((submission) => [
          submission.submissionId,
          JSON.stringify(submission),
        ]),
      );
      responseOrigin.set(response, {
        session,
        sent,
        snapshot: JSON.stringify(response),
        read: () => decodePushResponse(reply, request, session),
      });
      return response;
    },
    async pull(session: NegotiatedSync, cursor: number, limit?: number, signal?: AbortSignal) {
      const current = scope(session, signal);
      const request = decodePullRequest(
        { ...current.wire, cursor, ...(limit !== undefined && { limit }) },
        session,
      );
      const reply = await post("pull", request, current.request);
      assertCurrent(current.request.isCurrent);
      const response = decodePullResponse(reply, request, session);
      responseOrigin.set(response, {
        session,
        cursor: request.cursor,
        snapshot: JSON.stringify(response),
        read: () => decodePullResponse(reply, request, session),
      });
      return response;
    },
  };
}
