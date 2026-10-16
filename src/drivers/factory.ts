import type { WorkerDriver, WorkerProfile, MeshConfig } from "../types.js";
import { AcpxWorkerDriver } from "./acpxDriver.js";
import { MockWorkerDriver } from "./mockDriver.js";

export interface DriverSet {
  forProfile(profile: WorkerProfile): WorkerDriver;
  dispose(): Promise<void>;
}

/**
 * Build the drivers implied by a config. The acpx driver (and thus the ACP
 * runtime) is created lazily on first real use, so mock-only runs never pay for
 * it. Custom `command` overrides are folded into the acpx agent registry.
 */
export function createDrivers(config: MeshConfig, baseCwd: string): DriverSet {
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

  const getAcpx = (): AcpxWorkerDriver => {
    if (!acpx) {
      acpx = new AcpxWorkerDriver({
        baseCwd,
        overrides,
        stateDir,
        defaultPermissionMode,
      });
    }
    return acpx;
  };

  return {
    forProfile(profile) {
      return profile.driver === "mock" ? mock : getAcpx();
    },
    async dispose() {
      if (acpx) await acpx.dispose();
    },
  };
}
