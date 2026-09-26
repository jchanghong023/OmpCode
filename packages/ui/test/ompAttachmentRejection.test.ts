import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ompAttachmentRejectionDetail,
  sessionSendRejectionError,
} from "../src/v4/ompAttachmentRejection.js";

test("仅提取 omp 附件提交拒绝的具体原因", () => {
  assert.equal(
    ompAttachmentRejectionDetail({
      code: "ZCODE_V4_COMMAND_REJECTED",
      ack: {
        reasonCode: "fault.command.attachmentUnsupportedByOmpCore",
        message: "report.pdf: unsupported attachment type application/pdf",
      },
    }),
    "report.pdf: unsupported attachment type application/pdf",
  );
  assert.equal(
    ompAttachmentRejectionDetail({
      code: "ZCODE_V4_COMMAND_REJECTED",
      ack: { reasonCode: "fault.command.modelSwitchFailed", message: "other" },
    }),
    null,
  );
  assert.equal(ompAttachmentRejectionDetail(new Error("unknown")), null);
  assert.equal(
    ompAttachmentRejectionDetail(
      new Error(
        "v4 command createSession rejected (fault.command.attachmentUnsupportedByOmpCore): report.pdf: unsupported attachment type application/pdf — create session",
      ),
    ),
    "report.pdf: unsupported attachment type application/pdf",
  );
});

test("会话发送拒绝保留附件 ACK 的说明", () => {
  const error = sessionSendRejectionError(
    {
      reasonCode: "fault.command.attachmentUnsupportedByOmpCore",
      message: "report.pdf: unsupported attachment type application/pdf",
    },
    "发送被拒绝",
  );
  assert.equal(
    ompAttachmentRejectionDetail(error),
    "report.pdf: unsupported attachment type application/pdf",
  );
});
