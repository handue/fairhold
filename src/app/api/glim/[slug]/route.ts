import { apiRoute, jsonOk, requirePaddle } from "@/server/api";
import { syncEventCards } from "@/server/chat/event-card-sync";
import { loadChatView } from "@/server/chat/view";

/**
 * The Glim panel's whole view for this browser's paddle: its status line, every message and card, and
 * the quick replies. Any event card still owed is posted first, so reading is enough to see them.
 * Answers 200 ChatView, or 401 not_joined.
 */
export const GET = apiRoute<RouteContext<"/api/glim/[slug]">>(async (request, { params }) => {
  const { slug } = await params;
  const session = await requirePaddle(slug, request);
  await syncEventCards({ paddleId: session.paddleId });
  return jsonOk(await loadChatView(session));
});
