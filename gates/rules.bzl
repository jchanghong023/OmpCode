load("@bazel_lib//lib:run_binary.bzl", "run_binary")
load("@rules_shell//shell:sh_binary.bzl", "sh_binary")
load("@rules_shell//shell:sh_test.bzl", "sh_test")

_RUNNER = Label("//:gates/runner.sh")
_RUNFILES = Label("@rules_shell//shell/runfiles")

def gate_source_scopes(srcs):
    # 多个包组合重复 glob 会反复展开同一源码树；只分区原生 glob 的结果，不绕过子包边界。
    scopes = {"": srcs}
    for source in srcs:
        parts = source.split("/", 2)
        if len(parts) == 3 and parts[0] == "packages":
            scopes.setdefault(parts[1], []).append(source)
    return scopes

def gate_test(name, stage, data, preparation = False, **kwargs):
    # no-cache only controls action caching; external also disables local test reuse.
    if "no-cache" in kwargs.get("tags", []):
        kwargs["tags"] = kwargs["tags"] + ["external"]
    env = dict(kwargs.pop("env", {}))
    env.setdefault("JCH_GATES_NODE", "$(GATES_NODE)")
    sh_test(
        name = name,
        srcs = [_RUNNER],
        args = ["preparation" if preparation else "test", stage],
        data = data,
        deps = [_RUNFILES],
        env = env,
        **kwargs
    )

def gate_action(name, stage, data, **kwargs):
    # One official executable per package, independent of every stage's inputs.
    # Putting stage inputs on this tool would invalidate unrelated producers.
    tool = "_gate_runner"
    if not native.existing_rule(tool):
        sh_binary(
            name = tool,
            srcs = [_RUNNER],
            deps = [_RUNFILES],
            visibility = ["//visibility:private"],
        )
    requirements = {"no-remote-exec": "1"}
    if "no-cache" in kwargs.get("tags", []):
        requirements["no-cache"] = "1"
    run_binary(
        name = name,
        tool = ":" + tool,
        srcs = data,
        args = ["build", stage, '"$@"'],
        env = {"JCH_GATES_NODE": "$(GATES_NODE)"},
        out_dirs = ["gates/artifacts/" + name],
        execution_requirements = requirements,
        use_default_shell_env = True,
        **kwargs
    )
