/**
 * Runs SGP4 for every satellite on a background thread, so dragging the globe
 * stays smooth while positions update. Measured on Oct 16 for 16,747
 * satellites: 31 ms per update on a desktop and 135 ms with the CPU slowed
 * 4x (a phone), against a 16.7 ms frame budget.
 *
 * The worker also downloads and parses the elements itself (about 5 MB of
 * JSON), so that work stays off the main thread too. It has no DOM access;
 * it only talks to the page through messages.
 */
import { packedPositionsAt, trackSatellites, type ElementSetRow, type TrackedSatellite } from "@/lib/orbits";
import type { FromWorker, ToWorker } from "./positions-messages";

let satellites: TrackedSatellite[] = [];

function send(message: FromWorker, transfer: Transferable[] = []) {
  // Transferring hands the buffer's memory to the page instead of copying it.
  self.postMessage(message, { transfer });
}

self.addEventListener("message", async (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  if (message.type === "load") {
    try {
      const response = await fetch(message.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows: ElementSetRow[] = await response.json();
      satellites = trackSatellites(rows);
      send({
        type: "loaded",
        noradIds: satellites.map((s) => s.noradId),
        names: satellites.map((s) => s.name),
      });
    } catch {
      send({ type: "error" });
    }
    return;
  }

  if (message.type === "compute") {
    const start = performance.now();
    const positions = packedPositionsAt(satellites, new Date(message.time));
    send(
      { type: "positions", time: message.time, positions, workerMs: performance.now() - start },
      [positions.buffer],
    );
  }
});
