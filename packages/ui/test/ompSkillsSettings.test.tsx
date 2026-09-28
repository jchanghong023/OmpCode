import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OmpSkillsCatalogView } from "../src/settings/SkillsSection.js";

test("设置页技能列表只呈现 omp 可执行目录及刷新入口", () => {
  const html = renderToStaticMarkup(
    createElement(OmpSkillsCatalogView, {
      skills: [
        {
          id: "omp:skill:architecture-governance",
          name: "architecture-governance",
          description: "Check architecture",
          scope: "omp",
          enabled: true,
        },
        {
          id: "glm:legacy-skill",
          name: "legacy-skill",
          description: "ZCode local scan",
          path: "C:/legacy/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ],
      searchQuery: "",
      loading: false,
      error: null,
      onRefresh: () => {},
      labels: {
        title: "omp 可用技能",
        description: "由 omp 提供",
        loading: "加载中",
        empty: "暂无可用技能",
        searchEmpty: "没有匹配的技能",
        refresh: "刷新",
      },
    }),
  );
  assert.match(html, /omp 可用技能/);
  assert.match(html, /architecture-governance/);
  assert.doesNotMatch(html, /legacy-skill|ZCode local scan/);
  assert.match(html, /刷新/);
  assert.doesNotMatch(html, /导入|删除|本地可管理技能/);
});

test("目录为空时显示空态，不以本地扫描结果冒充 omp 可调用技能", () => {
  const html = renderToStaticMarkup(
    createElement(OmpSkillsCatalogView, {
      skills: [
        {
          id: "workspace:local-skill",
          name: "local-skill",
          description: "ZCode 本地扫描",
          path: "C:/ws/.zcode/skills/local-skill/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ],
      searchQuery: "",
      loading: false,
      error: null,
      onRefresh: () => {},
      labels: {
        title: "omp 可用技能",
        description: "由 omp 提供",
        loading: "加载中",
        empty: "暂无可用技能",
        searchEmpty: "没有匹配的技能",
        refresh: "刷新",
      },
    }),
  );
  assert.match(html, /暂无可用技能/u);
  // 非 omp 作用域的本地扫描结果不得进入列表或计数。
  assert.doesNotMatch(html, /local-skill|ZCode 本地扫描/u);
  assert.match(html, /data-testid="omp-available-skills"/u);
});
