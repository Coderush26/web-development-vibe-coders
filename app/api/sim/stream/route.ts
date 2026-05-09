import { getSimulatorStore } from "@/lib/simulator/store";
import type { SimulatorSnapshot, SimulatorStreamEvent } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

export function GET(request: Request): Response {
  const store = getSimulatorStore();
  const lastEventIdHeader = request.headers.get("last-event-id");
  const lastEventId = Number(lastEventIdHeader);

  const stream = new ReadableStream({
    start(controller) {
      const send = (snapshot: SimulatorSnapshot) => {
        if (Number.isFinite(lastEventId) && snapshot.stateVersion <= lastEventId) {
          return;
        }

        const event: SimulatorStreamEvent = {
          eventId: String(snapshot.stateVersion),
          sentAt: Date.now(),
          transport: "sse",
          snapshot,
        };

        controller.enqueue(
          encoder.encode(
            `id: ${event.eventId}\nretry: 2000\nevent: snapshot\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      };

      const unsubscribe = store.subscribe(send);
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
