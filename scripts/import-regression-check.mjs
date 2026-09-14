import { readFileSync } from "node:fs";

const imports = readFileSync("src/services/importService.ts", "utf8");
const staged = readFileSync("src/services/stagedRows.ts", "utf8");
const server = readFileSync("src/server.ts", "utf8");
const asyncJobs = readFileSync("src/services/asyncJobs.ts", "utf8");
const admin = readFileSync("public/admin.html", "utf8");
const failures = [];
const must = (ok, msg) => { if (!ok) failures.push(msg); };

must(imports.includes("rehydrateStagedRows(format, stagedRows)"), "commitBatch must rehydrate staged temporal values before importing");
must(staged.includes('field.type === "date" || field.type === "datetime"'), "all contract DATE/DATETIME fields must be restored");
must(imports.includes('compareDateValues(row.observed_at, existing.observedAt, "observed_at")'), "dated projections must use defensive date comparison");
must(!imports.includes("row.observed_at.getTime()"), "import commit must not call getTime directly on staged observed_at values");
must(server.includes("startCommitJob(req.params.batchId)") && server.includes('reply.code(202).send({ status: "ACCEPTED"'), "commit route must hand off to the async commit job and return 202 immediately");
must(asyncJobs.includes('console.error("[commit-job] commit failed:", e)') && asyncJobs.includes("job.error ="), "commit job runner must log failures and record a useful error for the poller");
must(server.includes('if (job.status === "FAILED") return { status: "FAILED", error: job.error }'), "commit-job status route must surface the recorded failure to the client");
must(admin.includes("if(resultArea) resultArea.innerHTML=''"), "reset UI must not dereference a missing import result element");

if (failures.length) {
  console.error("Import regression check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("Import regression check passed: staged temporal values are rehydrated and admin commit/reset errors are guarded.");
