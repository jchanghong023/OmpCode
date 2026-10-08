import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { zcodeLegacyTaskMetaSchema, zcodeSessionFileSchema } from "@zcode/shared";

export type LegacyTaskSessionFile = Omit<ZCodeSessionFile, "meta"> & {
  meta: Omit<ZCodeTaskMeta, "mode"> & { mode?: ZCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = zcodeSessionFileSchema.extend({
  // Legacy mode 可选与迁移关联校验共用 shared 契约，不覆盖已带 refinement 的对象字段。
  meta: zcodeLegacyTaskMetaSchema,
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
