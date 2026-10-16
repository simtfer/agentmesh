import type { WorkerDriver, WorkerProfile, MeshConfig } from "../types.js";
import { DELEGATION_DEPTH_ENV } from "../types.js";
import { AcpxWorkerDriver } from "./acpxDriver.js";
import { MockWorkerDriver } from "./mockDriver.js";
import { RemoteWorkerDriver } from "../remote/client.js";

export interface DriverSet {
  forProfile(profile: WorkerProfile): WorkerDriver;
  dispose(): Promise<void>;
}

/**
 * Build the drivers implied by a config. The acpx driver (and thus the ACP
 * runtime) and the remote driver are created lazily on first real use, so
 * mock-only runs never pay for them. Custom `command` overrides are folded into
 * the acpx agent registry.
 *
 * `delegationDepth` is this process's inherited depth; every agent the acpx
 * driver spawns gets `AGENTMESH_DELEGATION_DEPTH = depth + 1` in its environment
 * so a nested agentmesh (mounted as that agent's MCP server) inherits the chain
 * depth and can enforce the recursion cap across process boundaries.
 */
export function createDrivers(
  config: MeshConfig,
  baseCwd: string,
  delegationDepth = 0,
): DriverSet {
  const overrides: Record<string, string | string[]> = {};
  for (const p of config.profiles) {
    if (p.driver === "acpx" && p.command && p.agent) {
      overrides[p.agent] = p.command;
    }
  }

  const stateDir =
    config.defaults?.stateDir ?? `${config.workdir ?? ".agentmesh"}/state`;
  const defaultPermissionMode = config.defaults?.permissionMode ?? "approve-all";

  const mock = new MockWorkerDriver();
  let acpx: AcpxWorkerDriver | undefined;
  let remote: RemoteWorkerDriver | undefined;

  const getAcpx = (): AcpxWorkerDriver => {
    if (!acpx) {
      acpx = new AcpxWorkerDriver({
        baseCwd,
        overrides,
        stateDir,
        defaultPermissionMode,
        // Propagate the recursion guard one level down to any nested agentmesh.
        agentProcessEnv: { [DELEGATION_DEPTH_ENV]: String(delegationDepth + 1) },
      });
    }
    return acpx;
  };

  const getRemote = (): RemoteWorkerDriver => {
    if (!remote) remote = new RemoteWorkerDriver();
    return remote;
  };

  return {
    forProfile(profile) {
      if (profile.driver === "mock") return mock;
      if (profile.driver === "remote") return getRemote();
      return getAcpx();
    },
    async dispose() {
      if (acpx) await acpx.dispose();
      if (remote) await remote.dispose();
    },
  };
}
