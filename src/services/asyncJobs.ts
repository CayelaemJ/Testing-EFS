// ════════════════════════════════════════════════════════════════════
//  ASYNC JOB RUNNER
//  Upload validation and batch commit run in the background so the
//  HTTP response can return immediately (202 Accepted). The browser
//  polls /api/admin/upload-jobs/:id or /api/admin/commit-jobs/:id.
// ════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { uploadAndValidate, commitBatch } from "./importService.js";
import { prisma } from "./snapshotBuilder.js";

const uploadJobs = new Map<string, any>();
const commitJobs = new Map<string, any>();

// Jobs expire after 30 minutes so the maps don't grow forever.
function startJob(map: Map<string, any>) {
  const id = randomUUID();
  const timer = setTimeout(() => map.delete(id), 30 * 60 * 1000);
  map.set(id, { status: "PENDING", timer });
  return id;
}

export function startUploadJob(opts: any) {
  const jobId = startJob(uploadJobs);
  const job = uploadJobs.get(jobId);

  (async () => {
    try {
      const { batch, result } = await uploadAndValidate(opts);

      // Always mark DONE — let frontend decide if it's an error or success based on status/errorCount
      job.status = "DONE";
      job.result = {
        batchId: batch?.id,
        status: batch?.status,
        rowCount: result.rowCount,
        errors: result.errors.slice(0, 200),
        errorCount: result.errors.length,
        errorSummary: result.errorSummary || "",
        missingColumns: result.missingColumns,
        unknownColumns: result.unknownColumns,
        preview: result.rows.slice(0, 10),
      };

      // If validation failed, don't auto-commit
      if (!result.ok || batch?.status !== "VALIDATED") {
        return;
      }

      // Import means import: once validation succeeds, commit immediately in
      // the same background job. The HTTP request has already returned 202, so
      // this expensive DB work never blocks the admin UI.
      const commit = await commitBatch(batch.id);
      job.result = {
        ...job.result,
        status: "COMMITTED",
        errors: [],
        errorCount: 0,
        errorSummary: "",
        ...commit,
      };
    } catch (e) {
      // Even on exception, mark DONE with error status so frontend can display it
      job.status = "DONE";
      job.result = {
        batchId: opts.batchId || "unknown",
        status: "ERROR",
        rowCount: 0,
        errors: [],
        errorCount: 0,
        errorSummary: `Upload failed: ${(e as any)?.message || String(e)}`,
        missingColumns: [],
        unknownColumns: [],
        preview: [],
      };
      console.error("[upload-job] validation/commit failed:", e);
    }
  })();

  return jobId;
}

export function getUploadJob(jobId: string) {
  return uploadJobs.get(jobId);
}

export function startCommitJob(batchId: string) {
  const jobId = startJob(commitJobs);
  const job = commitJobs.get(jobId);

  (async () => {
    try {
      const result = await commitBatch(batchId);
      job.status = "DONE";
      job.result = result;
    } catch (e) {
      job.status = "FAILED";
      job.error = (e as any)?.message || String(e);
      console.error("[commit-job] commit failed:", e);
    }
  })();

  return jobId;
}

export function getCommitJob(jobId: string) {
  return commitJobs.get(jobId);
}

