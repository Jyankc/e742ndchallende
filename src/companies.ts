import { z } from "zod";

// IDs are also storage directory names, so reject path separators and dots.
// The database companies table determines which IDs are registered.
export const companyIdSchema = z.string().min(1).max(100)
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid company_id: use letters, numbers, underscores, or hyphens");
