// ANY-65 S12a — the platform-neutral session client (post, follow, resume).
// RUNTIME §13: post the message, then follow the SSE stream. Stubbed here; the
// red commit carries only the contract tests.
import type { CreateSessionRequest, CreateSessionResponse, PostMessageRequest, PostMessageResponse } from "./sessions";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function createSession(_fetch: FetchLike, _base: string, _req: CreateSessionRequest): Promise<CreateSessionResponse> {
    throw new Error("createSession: not implemented (ANY-65 S12a)");
}

export async function postMessage(_fetch: FetchLike, _base: string, _sessionId: string, _req: PostMessageRequest): Promise<PostMessageResponse> {
    throw new Error("postMessage: not implemented (ANY-65 S12a)");
}

export interface FollowSessionOptions {
    after?: number;
    onEvent: (event: unknown) => void;
    onDelta: (delta: unknown) => void;
    signal?: AbortSignal;
}

export async function followSession(_fetch: FetchLike, _base: string, _sessionId: string, _opts: FollowSessionOptions): Promise<void> {
    throw new Error("followSession: not implemented (ANY-65 S12a)");
}
