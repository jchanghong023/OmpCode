import React, { useRef, useState } from "react";
import { ServiceProvider } from "../../ui/src/hooks/useServices.tsx";
import { useFileMentionProvider } from "../../ui/src/mentions/providers/fileMentionProvider.ts";
import { createFileMentionInputRounds } from "../../ui/src/mentions/providers/fileMentionSearch.ts";

const requests = [];
const files = [];
const service = {
  searchWorkspaceFiles: (params) => {
    const request = { params, completed: false };
    requests.push(request);
    if (!params.query)
      return new Promise((resolve) => {
        request.resolve = (entries) => {
          request.completed = true;
          resolve(entries);
        };
      });
    request.completed = true;
    return Promise.resolve(
      params.refresh ? files.filter((file) => file.name.includes(params.query)) : [],
    );
  },
};
function Probe() {
  const rounds = useRef(createFileMentionInputRounds());
  const [raw, setRaw] = useState("miss-first");
  const [deferred, setDeferred] = useState("miss-first");
  const [version, setVersion] = useState(() => rounds.current.admit("miss-first", true));
  const result = useFileMentionProvider(
    "provider-fixture",
    undefined,
    deferred,
    true,
    "无文件",
    "文件",
    undefined,
    { liveQuery: raw, roundVersion: version },
  );
  window.fileProviderFixture = {
    consume: setDeferred,
    status: () => ({
      raw,
      deferred,
      version,
      requests: requests.map(({ params, completed }) => ({ params, completed })),
    }),
    addFile: (name) =>
      files.push({ name, path: `/provider-fixture/${name}`, relativePath: name, type: "file" }),
    releaseEmpty: () =>
      requests
        .filter((request) => !request.params.query && !request.completed)
        .forEach((request) =>
          request.resolve([
            {
              name: "wrong-old-result",
              path: "/wrong-old-result",
              relativePath: "wrong-old-result",
              type: "file",
            },
          ]),
        ),
  };
  return (
    <section>
      <label>
        实时引用查询
        <input
          data-testid="provider-live-query"
          value={raw}
          onChange={(event) => {
            const value = event.target.value;
            setVersion(rounds.current.admit(value, true));
            setRaw(value);
          }}
        />
      </label>
      <output data-testid="provider-results" data-loading={result.loading}>
        {result.items.map((item) => (
          <span key={item.id}>{item.label}</span>
        ))}
      </output>
    </section>
  );
}
export function FileProviderFixture() {
  return (
    <ServiceProvider services={{ fileService: service }}>
      <Probe />
    </ServiceProvider>
  );
}
