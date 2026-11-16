import fs from "fs";
import path from "path";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { ApiError } from "./errorHandler";

/**
 * File uploads for the Driver Portal (inspection photos, fault photos,
 * incident photos/documents, fuel receipts, driver documents).
 *
 * Security notes:
 * - Files are stored OUTSIDE the web root under `apps/api/uploads`, and are
 *   only ever served from the dedicated `/uploads` static mount.
 * - MIME type is validated against an allow-list and the file size is capped.
 * - Filenames are replaced with a random UUID (client names are not trusted).
 */

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads");
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB per file
export const MAX_UPLOAD_FILES = 6;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname).toLowerCase() || ".bin";
    cb(null, `${uuid()}${ext}`);
  },
});

function fileFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new ApiError(400, `Unsupported file type: ${file.mimetype}`));
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES },
});

/** Multi-file field named "files" (up to MAX_UPLOAD_FILES). */
export const uploadFiles = upload.array("files", MAX_UPLOAD_FILES);
/** Single-file field named "file". */
export const uploadSingle = upload.single("file");

export interface UploadedFileInfo {
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export function toFileInfo(file: Express.Multer.File): UploadedFileInfo {
  return {
    url: `/uploads/${file.filename}`,
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

/** Accepts either an array of files (upload.array) or a single file. */
export function collectFileInfos(files: Express.Multer.File[] | { [f: string]: Express.Multer.File[] } | Express.Multer.File | undefined): UploadedFileInfo[] {
  if (!files) return [];
  if (Array.isArray(files)) return files.map(toFileInfo);
  if (typeof (files as Express.Multer.File).filename === "string") return [toFileInfo(files as Express.Multer.File)];
  return Object.values(files).flat().map(toFileInfo);
}

/** Turns multer/Zod failures into the shared ApiError shape. */
export function normalizeUploadError(err: unknown): Error {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return new ApiError(400, `File too large (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB)`);
    if (err.code === "LIMIT_FILE_COUNT") return new ApiError(400, `Too many files (max ${MAX_UPLOAD_FILES})`);
    return new ApiError(400, `Upload error: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Express middleware wrapper that runs the multi-file upload and reports errors safely. */
export function uploadFilesMiddleware(req: Parameters<typeof uploadFiles>[0], res: Parameters<typeof uploadFiles>[1], next: (err?: unknown) => void) {
  uploadFiles(req, res, (err?: unknown) => (err ? next(normalizeUploadError(err)) : next()));
}

