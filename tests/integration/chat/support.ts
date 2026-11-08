/**
 * What the chat's route tests share: a time-relative gala priced like the demo (never the story
 * fixture, whose lots close at set evening times), a browser session for Jamie, and calls to the routes
 * as a browser makes them.
 */
import type pg from "pg";

import { GET as getView } from "@/app/api/glim/[slug]/route";
import { POST as postConfirm } from "@/app/api/glim/[slug]/plans/[planId]/confirm/route";
import { POST as postEdit } from "@/app/api/glim/[slug]/plans/[planId]/edit/route";
import { POST as postSkip } from "@/app/api/glim/[slug]/lots/[number]/skip/route";
import { POST as postMessage } from "@/app/api/glim/[slug]/messages/route";
import { POST as postPause } from "@/app/api/glim/[slug]/pause/route";
import { POST as postResume } from "@/app/api/glim/[slug]/resume/route";
import { createSession, sessionCookieName } from "@/server/api";
import type { ChatMessageView, ChatStreamFrame, ChatView, PlanCardView } from "@/server/chat/types";
import { placeBid } from "@/server/engine";
import { readChatFrames } from "@/ui/glim/frames";

import { createGala, type Gala } from "../plans/support";
import { createLot } from "../engine/support/fixtures";

const ORIGIN = "https://fairhold.example";

export interface ChatGala extends Gala {
  slug: string;
  cookie: string;
  /** Lot 03: the cabin, far past what Jamie's $500 can reach ($640, next minimum $660). */
  cabin: string;
}

export async function createChatGala(pool: pg.Pool, options: Parameters<typeof createGala>[1] = {}): Promise<ChatGala> {
  const gala = await createGala(pool, options);
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [gala.eventId]);
  const slug = rows[0]?.slug;
  if (!slug) throw new Error("no slug");
  const cabin = await createLot(pool, gala.eventId, { number: 3, startingBidCents: 25_000, minRaiseCents: 2_000 });
  await pool.query("update lots set short_title = 'Cabin Stay', title = 'Weekend Cabin Stay', category = 'experiences' where id = $1", [cabin]);
  const placed = await placeBid(gala.other, cabin, 64_000, "guest", { pool });
  if (!placed.ok) throw new Error(`cabin bid refused: ${placed.refusal.reason}`);
  const session = await createSession({ eventId: gala.eventId, paddleId: gala.jamie }, pool);
  return { ...gala, slug, cabin, cookie: `${sessionCookieName(slug)}=${session.token}` };
}

function post(path: string, cookie: string, body: unknown = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  });
}

export interface MessageAnswer {
  status: number;
  frames: ChatStreamFrame[];
  /** The whole reply the text frames built, after any reset. */
  streamed: string;
  view: ChatView | null;
  unsaved: { guestText: string; reply: string } | null;
  error: { code: string; message: string } | null;
}

/** POST .../messages, read to the end as the panel reads it. */
export async function sendMessage(gala: Pick<ChatGala, "slug" | "cookie">, text: string, lotNumber: number | null = null): Promise<MessageAnswer> {
  const { slug, cookie } = gala;
  const response = await postMessage(post(`/api/glim/${slug}/messages`, cookie, { text, lotNumber }), { params: Promise.resolve({ slug }) });
  const answer: MessageAnswer = { status: response.status, frames: [], streamed: "", view: null, unsaved: null, error: null };
  if (!response.ok || !response.body) {
    const body = (await response.json()) as { error: { code: string; message: string } };
    return { ...answer, error: body.error };
  }
  await readChatFrames(response.body, (frame) => {
    answer.frames.push(frame);
    if (frame.type === "text") answer.streamed += frame.text;
    if (frame.type === "reset") answer.streamed = "";
    if (frame.type === "done") {
      answer.view = frame.view;
      answer.unsaved = frame.unsaved;
    }
    if (frame.type === "error") answer.error = { code: frame.code, message: frame.message };
  });
  return answer;
}

export async function readView(gala: Pick<ChatGala, "slug" | "cookie">): Promise<ChatView> {
  const { slug, cookie } = gala;
  const response = await getView(new Request(`${ORIGIN}/api/glim/${slug}`, { headers: { cookie } }), { params: Promise.resolve({ slug }) });
  if (!response.ok) throw new Error(`view answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as ChatView;
}

export interface ButtonAnswer {
  status: number;
  view: ChatView | null;
  error: { code: string; message: string; details: unknown } | null;
}

async function answerOf(response: Response): Promise<ButtonAnswer> {
  const body = (await response.json()) as ChatView | { error: { code: string; message: string; details: unknown } };
  return "error" in body ? { status: response.status, view: null, error: body.error } : { status: response.status, view: body, error: null };
}

export const clickStartBidding = async (gala: ChatGala, planId: string) =>
  answerOf(
    await postConfirm(post(`/api/glim/${gala.slug}/plans/${planId}/confirm`, gala.cookie), {
      params: Promise.resolve({ slug: gala.slug, planId }),
    }),
  );

export const clickEdit = async (gala: ChatGala, planId: string, items: { lotNumber: number; maxCents: number }[]) =>
  answerOf(
    await postEdit(post(`/api/glim/${gala.slug}/plans/${planId}/edit`, gala.cookie, { items }), {
      params: Promise.resolve({ slug: gala.slug, planId }),
    }),
  );

export const clickSkip = async (gala: ChatGala, lotNumber: number | string) =>
  answerOf(
    await postSkip(post(`/api/glim/${gala.slug}/lots/${lotNumber}/skip`, gala.cookie), {
      params: Promise.resolve({ slug: gala.slug, number: String(lotNumber) }),
    }),
  );

export const clickPause = async (gala: ChatGala) =>
  answerOf(await postPause(post(`/api/glim/${gala.slug}/pause`, gala.cookie), { params: Promise.resolve({ slug: gala.slug }) }));

export const clickResume = async (gala: ChatGala) =>
  answerOf(await postResume(post(`/api/glim/${gala.slug}/resume`, gala.cookie), { params: Promise.resolve({ slug: gala.slug }) }));

export function lastPlanCard(view: ChatView | null): PlanCardView {
  const card = [...(view?.messages ?? [])].reverse().find((message) => message.card?.type === "plan")?.card;
  if (card?.type !== "plan") throw new Error("no plan card");
  return card;
}

/** Each drawn event card as the guest reads it: its line and chip, in order. */
export function eventLines(view: ChatView | null): string[] {
  return (view?.messages ?? []).flatMap((message: ChatMessageView) => (message.card?.type === "event" ? [message.card.line] : []));
}
