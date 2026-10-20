load("@rules_shell//shell:sh_test.bzl", "sh_test")

# Bazel owns dependency digests and successful test-result reuse through runfiles.
# Windows 不能由 CreateProcessW 直接执行 .sh；官方 rules_shell 负责生成原生启动器。
def _gate_script_impl(ctx):
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        output = launcher,
        content = "\n".join([
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "# Official runfiles.bash bootstrap (including Windows manifest mode).",
            "f=bazel_tools/tools/bash/runfiles/runfiles.bash",
            'source "${RUNFILES_DIR:-/dev/null}/$f" 2>/dev/null || \\',
            '  source "$(grep -sm1 "^$f " "${RUNFILES_MANIFEST_FILE:-/dev/null}" | cut -d " " -f2-)" 2>/dev/null || \\',
            '  source "$0.runfiles/$f" 2>/dev/null || \\',
            '  source "$(grep -sm1 "^$f " "$0.runfiles_manifest" | cut -d " " -f2-)"',
            'exec "$JCH_GATES_NODE" "$(rlocation "_main/scripts/test-gates-bazel-exec.mjs")" --stage ' + ctx.attr.stage,
            "",
        ]),
        is_executable = True,
    )
    # Bazel 9 通过官方 rules_shell 别名提供库与 root_symlinks，不再导出旧源文件标签。
    runfiles = ctx.runfiles(files = ctx.files.data).merge(ctx.attr._runfiles[DefaultInfo].default_runfiles)
    for dependency in ctx.attr.data:
        runfiles = runfiles.merge(dependency[DefaultInfo].default_runfiles)
    return [DefaultInfo(files = depset([launcher]), runfiles = runfiles)]

_gate_script = rule(
    implementation = _gate_script_impl,
    attrs = {
        "stage": attr.string(mandatory = True),
        "data": attr.label_list(allow_files = True, mandatory = True),
        "_runfiles": attr.label(default = Label("@bazel_tools//tools/bash/runfiles")),
    },
)

def gate_test(name, stage, data, **kwargs):
    # no-cache 只约束动作缓存；external 才禁止 auto 模式复用本地测试结果。
    if "no-cache" in kwargs.get("tags", []):
        kwargs["tags"] = kwargs["tags"] + ["external"]
    script = name + "_script"
    _gate_script(name = script, stage = stage, data = data)
    sh_test(name = name, srcs = [":" + script], data = data, **kwargs)

def _gate_action_impl(ctx):
    output = ctx.actions.declare_directory("gates/artifacts/" + ctx.label.name)
    requirements = {"no-remote-exec": "1"}
    if "no-cache" in ctx.attr.tags:
        requirements["no-cache"] = "1"
    ctx.actions.run(
        executable = ctx.var["GATES_NODE"],
        arguments = [
            "scripts/test-gates-action.mjs",
            "--stage",
            ctx.attr.stage,
            "--output",
            output.path,
        ],
        inputs = ctx.files.data,
        outputs = [output],
        use_default_shell_env = True,
        mnemonic = "GateBuild",
        execution_requirements = requirements,
    )
    return [DefaultInfo(files = depset([output]))]

gate_action = rule(
    implementation = _gate_action_impl,
    attrs = {
        "stage": attr.string(mandatory = True),
        "data": attr.label_list(allow_files = True, mandatory = True),
    },
)
