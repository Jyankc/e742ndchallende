import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { uploadSchema } from "./sources.js";
import { ingest, UploadError } from "./ingest.js";

export const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3 },
});

app.post("/uploads", upload.single("file"), async (req, res) => {
  const input = uploadSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Invalid request", issues: input.error.issues });
    return;
  }
  if (!req.file) { res.status(400).json({ error: "file is required" }); return; }
  res.json(await ingest(input.data, req.file));
});

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof UploadError) {
    res.status(error.status).json({ error: error.message, run_id: error.run_id });
  } else if (error instanceof multer.MulterError) {
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.message });
  } else {
    console.error(error);
    res.status(500).json({ error: "Upload failed" });
  }
};
app.use(errors);
