const targetUrl = process.argv[2] ?? "http://localhost:3000/api/sim/stream";
const viewerCount = Number(process.argv[3] ?? 5);
const eventsPerViewer = Number(process.argv[4] ?? 20);
const maxP95Ms = Number(process.argv[5] ?? 500);

type StreamEvent = {
  sentAt: number;
  snapshot: {
    stateVersion: number;
    ships: unknown[];
  };
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function readViewer(viewerIndex: number): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(30_000, eventsPerViewer * 3_000));
  const response = await fetch(targetUrl, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    throw new Error(`Viewer ${viewerIndex + 1} failed to connect: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const latencies: number[] = [];
  let buffer = "";

  try {
    while (latencies.length < eventsPerViewer) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      chunks.forEach((chunk) => {
        const dataLine = chunk
          .split("\n")
          .find((line) => line.startsWith("data: "));

        if (!dataLine) {
          return;
        }

        const event = JSON.parse(dataLine.slice(6)) as StreamEvent;
        if (event.snapshot.ships.length !== 15) {
          throw new Error(`Viewer ${viewerIndex + 1} received ${event.snapshot.ships.length} ships.`);
        }
        latencies.push(Math.max(0, Date.now() - event.sentAt));
      });
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    reader.releaseLock();
  }

  if (latencies.length < eventsPerViewer) {
    throw new Error(`Viewer ${viewerIndex + 1} only received ${latencies.length}/${eventsPerViewer} events.`);
  }

  return latencies;
}

const allLatencies = (await Promise.all(
  Array.from({ length: viewerCount }, (_, index) => readViewer(index)),
)).flat();
const p95 = percentile(allLatencies, 95);
const max = Math.max(...allLatencies);

console.log(
  `Realtime check: ${viewerCount} viewers, ${allLatencies.length} events, p95=${p95}ms, max=${max}ms.`,
);

if (p95 > maxP95Ms) {
  throw new Error(`p95 latency ${p95}ms exceeds ${maxP95Ms}ms target.`);
}
