import { bootSimulator, runnerAlive, runnerTail, startRunner, stopRunner } from './machine.js';
import { openMjpeg } from './mjpeg-reader.js';
import type { SimulatorBackend } from './session-manager.js';
import { probeLocalPorts } from './port-probe.js';
import { openTunnel } from './tunnel.js';
import { WdaClient } from './wda-client.js';

/** The production backend; `log` receives the tunnel's metadata-only logs (never payload bytes). */
export function createRealBackend(log?: (msg: string, meta?: object) => void): SimulatorBackend {
  return {
    boot: bootSimulator,
    runnerAlive,
    startRunner,
    stopRunner,
    runnerTail: (m, udid) => runnerTail(m, udid, 30),
    openTunnel: (machine, ports) => openTunnel(machine, ports, { log }),
    probePorts: async (machine, ports) => {
      const tunnel = await openTunnel(machine, ports, { log });
      try {
        return await probeLocalPorts(tunnel.wdaPort, tunnel.mjpegPort);
      } finally {
        tunnel.close();
      }
    },
    createClient: (baseUrl) => new WdaClient(baseUrl),
    openMjpeg,
  };
}
