import {
  zcodeProtocolMethods,
  zcodePluginsReferenceCatalogResultSchema,
  type ZCodePluginsReferenceCatalogParams,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** 当前产品仅消费 OMP：直接使用其支持的目录入口，仍严格校验真实响应。 */
export async function requestPluginReferenceCatalog(
  client: Pick<ZCodeProtocolClient, "request">,
  params: ZCodePluginsReferenceCatalogParams,
) {
  return client.request(
    zcodeProtocolMethods.pluginsReferenceCatalog,
    params,
    zcodePluginsReferenceCatalogResultSchema,
  );
}
