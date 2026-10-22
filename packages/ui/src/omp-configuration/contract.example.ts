import type { OmpConfigurationService, OmpConfigurationTarget } from "./contract.js";
import { OmpConfigurationController } from "./module.js";

/** Local draft preview never writes; the owner must dispose when its target closes. */
export async function exampleOmpConfiguration(
  service: OmpConfigurationService,
  target: OmpConfigurationTarget,
): Promise<void> {
  const controller = new OmpConfigurationController(service, target);
  try {
    await controller.refresh();
    controller.setMembers([]);
    await controller.preview();
  } finally {
    controller.dispose();
  }
}
