import { z } from "zod";

/** 临时身份的关联必须来自 Host 已提交的迁移事实，不能由 Renderer 按标题推断。 */
export const zcodeTaskIdMigrationSchema = z
  .object({
    fromTaskId: z.string().trim().min(1),
    toTaskId: z.string().trim().min(1),
  })
  .strict()
  .refine((migration) => migration.fromTaskId !== migration.toTaskId, {
    message: "Task identity migration must change the ID",
  });
