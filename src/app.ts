import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { companyIdSchema } from "./companies.js";
import { uploadSchema } from "./sources.js";
import { db, ingest, UploadError } from "./ingest.js";

export const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
});

app.get("/companies", async (_req, res) => {
  const companies = await db.company.findMany({
    select: { id: true, name: true }, orderBy: { id: "asc" },
  });
  res.json(companies);
});

app.post("/uploads", upload.single("file"), async (req, res) => {
  const input = uploadSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), issues: input.error.issues });
    return;
  }
  if (!req.file) { res.status(400).json({ error: "file is required" }); return; }
  const result = await ingest(input.data, req.file);
  res.status(result.status === "completed" || result.status === "failed" ? 200 : 202).json(result);
});

app.post("/runs/:id", express.json(), async (req, res) => {
  const company = companyIdSchema.safeParse(req.body?.company_id);
  if (!company.success) {
    res.status(400).json({ error: "A valid company_id in the JSON body is required" }); return;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID" }); return;
  }
  const run = await db.ingestionRun.findFirst({ where: { id: req.params.id, company_id: company.data }, select: {
    id: true, company_id: true, source: true, status: true, attempt_count: true,
    inserted_count: true, duplicate_count: true, reused_run_id: true,
    error: true, error_code: true, created_at: true, updated_at: true,
    next_attempt_at: true, lease_expires_at: true,
  } });
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
});

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    res.status(400).json({ error: "Invalid JSON body" });
  } else if (error instanceof UploadError) {
    res.status(error.status).json({ error: error.message, run_id: error.run_id });
  } else if (error instanceof multer.MulterError) {
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.message });
  } else {
    console.error(error);
    res.status(500).json({ error: "Upload failed" });
  }
};
app.use(errors);
