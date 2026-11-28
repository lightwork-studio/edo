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
const maxRequestBytes = (maxSyncEnvelopeBytes * 3) / 4;

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
    if (new TextEncoder().encode(serialized).byteLength > maxRequestBytes) {
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

  return {
    server: base,
    async connect(previous?: SavedHistory, signal?: AbortSignal) {
      const attempt = ++generation;
      active = null;
      if (previous && previous.server !== base) {
        throw new SyncWireError(
          "account-changed",
          "The saved diary belongs to a different sync server",
        );
      }
      const header = await authorization();
      const options = { authorization: header, isCurrent: () => generation === attempt, signal };
      const reply = await post("hello", hello, options);
      assertCurrent(options.isCurrent);
      const session = acceptHello(hello, reply, previous, releases);
      active = { session, authorization: header };
      return session;
    },
    async push(session: NegotiatedSync, submissions: readonly Submission[], signal?: AbortSignal) {
      const current = scope(session, signal);
      const request = decodePushRequest({ ...current.wire, submissions }, session);
      const reply = await post("push", request, current.request);
      assertCurrent(current.request.isCurrent);
      return decodePushResponse(reply, request, session);
    },
    async pull(session: NegotiatedSync, cursor: number, limit?: number, signal?: AbortSignal) {
      const current = scope(session, signal);
      const request = decodePullRequest(
        { ...current.wire, cursor, ...(limit !== undefined && { limit }) },
        session,
      );
      const reply = await post("pull", request, current.request);
      assertCurrent(current.request.isCurrent);
      return decodePullResponse(reply, request, session);
    },
  };
}
