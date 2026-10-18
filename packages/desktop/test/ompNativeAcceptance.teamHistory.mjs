import assert from "node:assert/strict";
import { resolve } from "node:path";
import { textOf } from "./ompAgentsAcceptance.protocol.mjs";
import { journalEvidence } from "./ompNativeAcceptance.helpers.mjs";

// Team 可以在一个 journal 中持久化不同 role/source；不同进程或文件不是需求。
function participantOf(entry, header, parentId) {
  const message = entry.message ?? entry;
  const containers = [
    entry,
    message,
    entry.metadata,
    message.metadata,
    entry.details,
    message.details,
    typeof entry.source === "object" ? entry.source : null,
    typeof message.source === "object" ? message.source : null,
  ].filter(Boolean);
  for (const key of ["participantId", "memberId", "roleId", "agentId", "sourceId"]) {
    const value = containers.find(
      (container) => typeof container[key] === "string" && container[key],
    );
    if (value)
      return {
        id: value[key],
        labels: [value[key], value.name, value.roleName, value.role].filter(
          (label) =>
            typeof label === "string" && !["assistant", "user", "toolResult"].includes(label),
        ),
      };
  }
  for (const container of containers) {
    if (typeof container.source === "string" && container.source)
      return { id: container.source, labels: [container.source] };
    if (
      [entry.source, message.source].includes(container) &&
      typeof container.id === "string" &&
      container.id
    )
      return {
        id: container.id,
        labels: [container.id, container.name, container.role].filter(
          (label) => typeof label === "string",
        ),
      };
    if (
      container !== entry &&
      container !== message &&
      typeof container.role === "string" &&
      !["assistant", "user", "system", "toolResult"].includes(container.role)
    )
      return {
        id: container.role,
        labels: [container.role, container.name].filter((label) => typeof label === "string"),
      };
  }
  if (header?.id && header.id !== parentId)
    return {
      id: header.id,
      labels: [header.id, header.name, header.role].filter((label) => typeof label === "string"),
    };
  assert.fail(
    "A same-journal Team call must expose its real persisted participant/role/source identity; global counters are not evidence",
  );
}

export async function teamEvidence(runtime, mainTask, before, teamData, manifest) {
  const journals = await journalEvidence(runtime);
  const parentId = mainTask.slice("task-item-".length);
  const parents = journals.filter((journal) =>
    journal.lines.some((row) => row.type === "session" && row.id === parentId),
  );
  assert.equal(parents.length, 1, "This Team must have one actual stable parent journal");
  const parent = parents[0];
  const reads = teamData.acceptance.issued.filter((item) => item.key.startsWith("team-read-"));
  const yields = teamData.acceptance.issued.filter((item) => item.key.startsWith("team-yield-"));
  assert.ok(reads.length >= 2, "At least two actual participants must each execute read→yield");
  assert.equal(yields.length, reads.length);
  const synthesis = yields.filter((item) => item.teamStage === "synthesis");
  assert.equal(synthesis.length, 1, "Exactly one actual provider synthesis must emit the report");
  const report = synthesis[0].args.data.reportMarkdown;
  assert.ok(report.includes("NATIVE_TEAM_REPORT_731"));
  assert.ok(report.includes(manifest.values.read.trim()));
  const publicReports = parent.lines.filter(
    (row) =>
      row.type === "custom_message" &&
      row.customType === "team-result" &&
      row.display !== false &&
      row.content.includes("NATIVE_TEAM_REPORT_731"),
  );
  assert.equal(
    publicReports.length,
    1,
    "One real public Team result must contain the provider report",
  );
  assert.ok(publicReports[0].content.includes(report));
  assert.ok(
    !before.some((record) => record.lines.some((row) => row.id === publicReports[0].id)),
    "An old public Team report cannot satisfy this invocation",
  );
  assert.deepEqual(
    Object.fromEntries(
      ["proposal", "alignment", "review", "synthesis"].map((stage) => [
        stage,
        yields.filter((item) => item.teamStage === stage).length,
      ]),
    ),
    { proposal: 3, alignment: 1, review: 3, synthesis: 1 },
    "All genuine Team phases must complete, not just investigation",
  );
  const participants = [];
  for (const read of reads) {
    const yielded = yields.filter((item) => item.readToolId === read.id);
    assert.equal(yielded.length, 1, `Exactly one yield must refer to its own real read ${read.id}`);
    assert.equal(
      yielded[0].teamTask,
      manifest.values.team,
      "Yield must identify this exact Team assignment",
    );
    assert.ok(
      !before.some(
        (record) =>
          JSON.stringify(record.lines).includes(read.id) ||
          JSON.stringify(record.lines).includes(yielded[0].id),
      ),
      "Only new read/yield records originating in this Team invocation count",
    );
    const records = journals.filter((journal) =>
      journal.lines.some((row) => {
        const message = row.message ?? row;
        return message.role === "toolResult" && message.toolCallId === read.id;
      }),
    );
    assert.equal(
      records.length,
      1,
      "A participant read must belong to exactly one actual persisted source record",
    );
    const record = records[0];
    const header = record.lines.find((row) => row.type === "session");
    assert.ok(header?.id);
    if (header.id !== parentId) {
      assert.ok(header.parentSession, "A separate Team record must name its actual parent");
      assert.equal(
        resolve(header.parentSession),
        resolve(parent.path),
        "No cross-parent Team attribution",
      );
    }
    assert.ok(
      record.lines.some((row) => {
        const message = row.message ?? row;
        return message.role === "user" && textOf(message.content).includes(manifest.values.team);
      }),
      "Participant source must contain this exact unique Team input",
    );
    const positions = [];
    const owners = [];
    for (const [item, name] of [
      [read, "read"],
      [yielded[0], "yield"],
    ]) {
      const calls = record.lines.flatMap((entry, index) => {
        const message = entry.message ?? entry;
        return message.role === "assistant" && Array.isArray(message.content)
          ? message.content
              .filter(
                (part) => part.type === "toolCall" && part.id === item.id && part.name === name,
              )
              .map((call) => ({ call, entry, index }))
          : [];
      });
      const results = record.lines.flatMap((entry, index) => {
        const message = entry.message ?? entry;
        return message.role === "toolResult" &&
          message.toolCallId === item.id &&
          message.toolName === name
          ? [{ message, index }]
          : [];
      });
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.deepEqual(calls[0].call.arguments, item.args);
      assert.notEqual(
        results[0].message.isError,
        true,
        "Only a successful real participant tool result counts",
      );
      assert.ok(calls[0].index < results[0].index);
      if (name === "read")
        assert.ok(textOf(results[0].message.content).includes(manifest.values.read.trim()));
      else {
        assert.equal(textOf(results[0].message.content), "Result submitted.");
        assert.equal(
          results[0].message.details?.status,
          "success",
          "A persisted successful yield is required, not just a model report",
        );
        assert.deepEqual(
          results[0].message.details.data,
          item.args.data,
          "Persisted structured data must equal this participant's actual model submission",
        );
      }
      owners.push(participantOf(calls[0].entry, header, parentId));
      positions.push(calls[0].index, results[0].index);
    }
    assert.equal(
      owners[0].id,
      owners[1].id,
      "A read from one member cannot be combined with another member's yield",
    );
    assert.ok(
      positions[1] < positions[2],
      "Each participant must actually read before yielding its evidence",
    );
    const contexts = teamData.calls.filter((call) =>
      call.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) => part.type === "tool_result" && part.tool_use_id === read.id,
          ),
      ),
    );
    assert.equal(
      contexts.length,
      1,
      "Exactly one actual HTTP continuation must receive this participant's read before terminal yield",
    );
    const system = contexts[0].system;
    const actualRead = contexts[0].messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "tool_use" && part.id === read.id);
    assert.equal(
      actualRead.length,
      1,
      "The same actual participant HTTP context must contain its own persisted read before yield",
    );
    assert.deepEqual(actualRead[0].input, read.args);
    const actualResults = contexts[0].messages
      .filter((message) => message.role === "user")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "tool_result" && part.tool_use_id === read.id);
    assert.equal(actualResults.length, 1);
    assert.equal(actualResults[0].is_error, false);
    assert.ok(textOf(actualResults[0].content).includes(manifest.values.read.trim()));
    assert.ok(
      JSON.stringify(contexts[0].messages).includes(manifest.values.team),
      "The actual participant request must belong to this Team input",
    );
    participants.push({
      source: owners[0],
      id: owners[0].id,
      path: record.path,
      parentId,
      read: read.id,
      yield: yielded[0].id,
      requestId: contexts[0].requestId,
      system,
    });
  }
  assert.equal(
    new Set(participants.map((item) => item.id)).size,
    participants.length,
    "Repeated work by one participant cannot count as another Team member",
  );
  return participants;
}
