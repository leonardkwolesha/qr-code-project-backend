import multer from "multer";

// Store file in memory for Cloudinary upload
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) cb(null, true);
  else cb(new Error("Only image files are allowed"), false);
};

const upload = multer({ storage, fileFilter });

// ─────────────────────────────────────────────────────────────
// 📄 DOCUMENT UPLOAD (exam timetables)
// Separate instance so the profile-photo uploader above keeps its
// image-only rule untouched.
// ─────────────────────────────────────────────────────────────
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024; // 15 MB

const documentFileFilter = (req, file, cb) => {
  const isPdf =
    file.mimetype === "application/pdf" ||
    file.mimetype === "application/x-pdf" ||
    /\.pdf$/i.test(file.originalname || "");

  if (isPdf) cb(null, true);
  else cb(new Error("Only PDF documents are allowed"), false);
};

const documentUpload = multer({
  storage,
  fileFilter: documentFileFilter,
  limits: { fileSize: MAX_DOCUMENT_BYTES },
});

/**
 * Wraps `documentUpload.single(field)` so multer's rejections come back as a
 * clean JSON 400 instead of bubbling up as an unhandled Error page.
 */
export const uploadDocument = (fieldName = "document") => (req, res, next) => {
  documentUpload.single(fieldName)(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          message: `File is too large. Maximum size is ${
            MAX_DOCUMENT_BYTES / (1024 * 1024)
          } MB.`,
        });
      }
      return res.status(400).json({ message: err.message });
    }

    return res.status(400).json({ message: err.message || "Upload failed" });
  });
};

export { MAX_DOCUMENT_BYTES };
export default upload;
