import assert from "node:assert/strict";
import fs from "node:fs";
import { Lexer, Parser, Evaluator, data } from "@actions/expressions";

let checked = 0;
for (const file of fs.readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"))) {
  const workflow = Bun.YAML.parse(fs.readFileSync(`.github/workflows/${file}`, "utf8"));
  if (!workflow.on?.workflow_call) continue;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job["runs-on"]) continue;
    const expression = job["runs-on"];
    const defaults = Object.fromEntries(
      Object.entries(workflow.on.workflow_call.inputs ?? {}).map(([key, input]) => [
        key,
        input.default ?? (input.type === "boolean" ? false : ""),
      ]),
    );
    const evaluate = (visibility, inputs) => {
      if (typeof expression !== "string" || !expression.startsWith("${{")) return expression;
      const context = JSON.parse(
        JSON.stringify({
          github: { event: { repository: { private: visibility } } },
          inputs: { ...defaults, ...inputs },
        }),
        data.reviver,
      );
      const parsed = new Parser(
        new Lexer(expression.slice(3, -2)).lex().tokens,
        ["github", "inputs"],
        [],
      ).parse();
      return JSON.parse(JSON.stringify(new Evaluator(parsed, context).evaluate(), data.replacer));
    };
    for (const visibility of [true, undefined]) {
      for (const github_hosted_runner of [false, true]) {
        for (const runs_on of [
          "",
          '"ubuntu-22.04"',
          '"macos-latest"',
          '"windows-latest"',
          '["ubuntu-latest"]',
          '"self-hosted-ubuntu"',
          '["self-hosted-ubuntu"]',
          '["self-hosted","Linux","extra-large"]',
        ]) {
          const labels = evaluate(visibility, { github_hosted_runner, runs_on });
          assert.ok(
            [labels].flat().includes("self-hosted"),
            `${file}:${name} permits hosted runners with ${runs_on}`,
          );
          checked++;
        }
      }
    }
    if ("runs_on" in defaults) {
      const labels = ["self-hosted", "macOS", "custom-pool"];
      assert.deepEqual(
        evaluate(true, { runs_on: JSON.stringify(labels) }),
        labels,
        `${file}:${name} loses private runner constraints`,
      );
      assert.equal(
        evaluate(false, { runs_on: '"macos-latest"' }),
        "macos-latest",
        `${file}:${name} loses public overrides`,
      );
    }
    const publicLabels = evaluate(false, {});
    if (file !== "sync.yml")
      assert.ok(
        ![publicLabels].flat().includes("self-hosted"),
        `${file}:${name} routes public defaults to self-hosted`,
      );
  }
}
assert.ok(checked > 0, "No reusable runner expressions checked");
console.log(`Checked ${checked} private runner selections across the reusable workflows.`);
