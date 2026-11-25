import { writeFile } from "node:fs/promises";

const migration =
  "a public incoming migration keeps the source DID until the staged repository is ready";
const signup = "ordinary signup on the staged-capable PDS";
export default class StagedQualificationReporter {
  results = [];
  onTestEnd(test, result) {
    const project = test.parent.project()?.name;
    const name =
      test.title === migration
        ? "migration"
        : test.title === signup
          ? "signup"
          : "unexpected";
    this.results.push({
      project,
      name,
      status: result.status,
      retry: result.retry,
    });
  }
  async onEnd() {
    await writeFile(
      process.env.STAGED_QUALIFICATION_RESULTS,
      JSON.stringify(this.results),
    );
  }
}
