// controllers/timetableController.js
import mongoose from "mongoose";
import cloudinary from "cloudinary";
import Timetable from "../models/Timetable.js";
// Also registers the User schema so `.populate("uploadedBy")` resolves
// regardless of which module mongoose loaded first.
import User from "../models/user.js";
// Guarantees cloudinary.v2 is configured even if this module is imported
// before index.js runs its own side-effect import.
import "../config/cloudinary.js";

const CLOUDINARY_FOLDER = "exam_timetables";

// Timetable PDFs are far larger than profile photos; the SDK default (60s) is
// tight over a slow campus link.
const CLOUDINARY_TIMEOUT_MS = 120000;

// Hard ceiling so a corrupt `pages` value can never explode the preview pager.
const MAX_PREVIEW_PAGES = 60;

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ────────────────────────────────────────────────────────────────
   URL BUILDERS
   A PDF uploaded as an `image` resource can be rendered page-by-page by
   Cloudinary (pg_N + f_jpg). That is what powers the in-app preview — no
   native PDF renderer needed on the device.
   ──────────────────────────────────────────────────────────────── */

const buildPageUrl = (publicId, page, width = 1400, version = null) => {
  if (!publicId) return null;
  return cloudinary.v2.url(publicId, {
    resource_type: "image",
    secure: true,
    format: "jpg",
    ...(version ? { version } : {}),
    transformation: [{ page, width, crop: "limit", quality: "auto" }],
  });
};

const buildDownloadUrl = (
  publicId,
  resourceType = "image",
  format = "pdf",
  version = null
) => {
  if (!publicId) return null;
  return cloudinary.v2.url(publicId, {
    resource_type: resourceType,
    secure: true,
    ...(resourceType === "image" ? { format: format || "pdf" } : {}),
    ...(version ? { version } : {}),
    transformation: [{ flags: "attachment" }],
  });
};

/** Delivery URL for the extension-less `raw` copy (never PDF-restricted). */
const buildRawUrl = (publicId, version = null, attachment = false) => {
  if (!publicId) return null;
  return cloudinary.v2.url(publicId, {
    resource_type: "raw",
    secure: true,
    ...(version ? { version } : {}),
    ...(attachment ? { transformation: [{ flags: "attachment" }] } : {}),
  });
};

/**
 * Cloudinary blocks delivery of any URL ending in .pdf unless the account has
 * "Allow delivery of PDF and ZIP files" switched on. One cheap HEAD tells us
 * which of the two delivery strategies this account needs.
 *
 * The answer is an account-level setting, not a per-file fact, so it is cached
 * for an hour — an upload should not pay for this round trip every time. The
 * TTL means flipping the Cloudinary setting is picked up without a restart.
 */
const PDF_DELIVERY_TTL_MS = 60 * 60 * 1000;
let pdfDeliveryCache = { value: null, checkedAt: 0 };

const canDeliverPdf = async (url) => {
  if (!url) return false;

  const fresh = Date.now() - pdfDeliveryCache.checkedAt < PDF_DELIVERY_TTL_MS;
  if (pdfDeliveryCache.value !== null && fresh) return pdfDeliveryCache.value;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    pdfDeliveryCache = { value: res.ok, checkedAt: Date.now() };
    return res.ok;
  } catch {
    // A network blip must not be cached as a permanent "blocked" verdict.
    return pdfDeliveryCache.value ?? false;
  }
};

/**
 * Multer only sees the declared MIME type and the filename, so a renamed .txt
 * sails straight through. Checking the actual header stops a non-PDF being
 * stored as a timetable with an unrenderable preview.
 */
const isRealPdf = (buffer) =>
  Buffer.isBuffer(buffer) &&
  buffer.length > 4 &&
  buffer.subarray(0, 5).toString("latin1") === "%PDF-";

/**
 * Shapes a Timetable document for the clients: metadata + ready-to-render
 * page images + a forced-download link.
 */
export const serializeTimetable = (doc) => {
  if (!doc) return null;
  const t = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };

  const rawPages = Number(t.pages) || 1;
  const pages = Math.min(Math.max(rawPages, 1), MAX_PREVIEW_PAGES);

  const previewable = t.resourceType !== "raw";
  const pageImages = previewable
    ? Array.from({ length: pages }, (_, i) =>
        buildPageUrl(t.filePublicId, i + 1, 1400, t.version)
      )
    : [];

  // Open/download always go through whichever copy this account can deliver.
  const hasRawCopy = !!t.rawPublicId;
  const fileUrl = hasRawCopy
    ? buildRawUrl(t.rawPublicId, t.rawVersion)
    : t.resourceType === "raw"
      ? buildRawUrl(t.filePublicId, t.version)
      : cloudinary.v2.url(t.filePublicId, {
          resource_type: "image",
          secure: true,
          format: t.fileFormat || "pdf",
          ...(t.version ? { version: t.version } : {}),
        });

  const downloadUrl = hasRawCopy
    ? buildRawUrl(t.rawPublicId, t.rawVersion, true)
    : buildDownloadUrl(
        t.filePublicId,
        t.resourceType || "image",
        t.fileFormat,
        t.version
      );

  return {
    ...t,
    pages,
    totalPages: rawPages,
    previewable,
    pageImages,
    thumbnailUrl: previewable
      ? buildPageUrl(t.filePublicId, 1, 600, t.version)
      : null,
    fileUrl: fileUrl || t.fileUrl,
    downloadUrl,
  };
};

/* ────────────────────────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────────────────────────── */

const stripExtension = (publicId) => String(publicId).replace(/\.[^./]+$/, "");

const normalizeCourse = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === "all") return null;
  return trimmed;
};

const parseBool = (value, fallback = undefined) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return fallback;
};

const uploadBufferToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });

const destroyCloudinaryAsset = async (publicId, resourceType = "image") => {
  if (!publicId) return;
  try {
    await cloudinary.v2.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    // A dangling remote file must never block the DB operation.
    console.warn("Cloudinary destroy failed for", publicId, "-", err.message);
  }
};

/* ────────────────────────────────────────────────────────────────
   👥 AUDIENCE REACH
   A timetable targeted at a course string that matches no student is
   invisible to everyone — the single easiest way to "publish" nothing.
   These helpers make that reach an explicit, reportable number.
   ──────────────────────────────────────────────────────────────── */

/**
 * Distinct student courses, grouped case-insensitively (so "BSC" and "bsc"
 * are one audience) and labelled with the most common spelling in use.
 */
const getCourseIndex = async () => {
  const rows = await User.aggregate([
    { $match: { role: "student" } },
    {
      $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ["$course", ""] } } } },
        count: { $sum: 1 },
        labels: { $push: "$course" },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const byCourse = new Map();
  let totalStudents = 0;
  const courses = [];

  for (const row of rows) {
    totalStudents += row.count;
    if (!row._id) continue; // students with no course set

    byCourse.set(row._id, row.count);

    // Pick the spelling most people are actually stored with.
    const tally = new Map();
    for (const l of row.labels) {
      const label = (l || "").trim();
      if (label) tally.set(label, (tally.get(label) || 0) + 1);
    }
    const label =
      [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || row._id;

    courses.push({ course: label, students: row.count });
  }

  return { byCourse, totalStudents, courses };
};

/** How many students a given course target actually reaches. */
const audienceCountFor = (course, index) => {
  const c = normalizeCourse(course);
  if (!c) return index.totalStudents; // global timetable
  return index.byCourse.get(c.toLowerCase()) ?? 0;
};

/* ────────────────────────────────────────────────────────────────
   👥 COURSE LIST  (exam-controller)
   GET /api/timetables/courses
   Powers the audience picker so a course can never be mistyped.
   ──────────────────────────────────────────────────────────────── */
export const getCourseAudiences = async (req, res) => {
  try {
    const { courses, totalStudents } = await getCourseIndex();
    return res.json({ success: true, totalStudents, courses });
  } catch (error) {
    console.error("getCourseAudiences error:", error);
    return res.status(500).json({ message: "Failed to load course list." });
  }
};

/* ────────────────────────────────────────────────────────────────
   📤 UPLOAD TIMETABLE  (exam-controller)
   POST /api/timetables
   multipart/form-data — field name: "document"
   ──────────────────────────────────────────────────────────────── */
export const uploadTimetable = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please attach a PDF timetable." });
    }

    if (!req.file.buffer?.length) {
      return res
        .status(400)
        .json({ message: "That file is empty — pick the timetable PDF again." });
    }

    // Verified before upload, so a bad file costs nothing and never lands in
    // Cloudinary or the database.
    if (!isRealPdf(req.file.buffer)) {
      return res.status(400).json({
        message:
          "That file is not a valid PDF. Export the timetable as a PDF and try again.",
      });
    }

    const { title, examSession, description, course, isPublished } = req.body;

    const finalTitle = (title || "").trim() || "Examination Timetable";
    const publish = parseBool(isPublished, true);

    // Uploaded as `image` so Cloudinary can derive per-page JPGs for preview.
    let result;
    let resourceType = "image";
    try {
      result = await uploadBufferToCloudinary(req.file.buffer, {
        folder: CLOUDINARY_FOLDER,
        resource_type: "image",
        format: "pdf",
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        timeout: CLOUDINARY_TIMEOUT_MS,
      });
    } catch (imageErr) {
      // Some Cloudinary plans reject PDF-as-image. Fall back to a raw upload:
      // the document is still downloadable, only the in-app pager is skipped.
      console.warn("PDF image upload failed, falling back to raw:", imageErr.message);
      resourceType = "raw";
      result = await uploadBufferToCloudinary(req.file.buffer, {
        folder: CLOUDINARY_FOLDER,
        resource_type: "raw",
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        timeout: CLOUDINARY_TIMEOUT_MS,
      });
    }

    // The image copy powers page previews, but its .pdf delivery URL is 401'd
    // on accounts with PDF delivery disabled. Probe once; if it is blocked,
    // store a second extension-less `raw` copy for open/download.
    let rawResult = null;
    if (resourceType === "image") {
      const pdfUrl = cloudinary.v2.url(result.public_id, {
        resource_type: "image",
        secure: true,
        format: "pdf",
        ...(result.version ? { version: result.version } : {}),
      });

      if (!(await canDeliverPdf(pdfUrl))) {
        try {
          rawResult = await uploadBufferToCloudinary(req.file.buffer, {
            folder: CLOUDINARY_FOLDER,
            resource_type: "raw",
            // No .pdf extension — Cloudinary blocks that URL shape as well.
            public_id: `${stripExtension(result.public_id).split("/").pop()}_file`,
            overwrite: false,
            timeout: CLOUDINARY_TIMEOUT_MS,
          });
        } catch (rawErr) {
          // Previews still work; only the open/download link degrades.
          console.warn("Raw delivery copy failed:", rawErr.message);
        }
      }
    }

    let timetable;
    try {
      timetable = await Timetable.create({
        title: finalTitle,
        examSession: (examSession || "").trim() || null,
        description: (description || "").trim() || null,
        course: normalizeCourse(course),
        fileUrl: rawResult?.secure_url || result.secure_url,
        filePublicId: result.public_id,
        resourceType,
        fileFormat: (result.format || "pdf").toLowerCase(),
        originalName: req.file.originalname || null,
        bytes: result.bytes || req.file.size || 0,
        version: Number(result.version) || null,
        rawPublicId: rawResult?.public_id || null,
        rawVersion: Number(rawResult?.version) || null,
        pages: Number(result.pages) || 1,
        isPublished: publish,
        publishedAt: publish ? new Date() : null,
        uploadedBy: req.userId || null,
      });
    } catch (dbErr) {
      // The files are already on Cloudinary. Without this they would linger
      // forever with no database row pointing at them.
      await destroyCloudinaryAsset(result.public_id, resourceType);
      if (rawResult) await destroyCloudinaryAsset(rawResult.public_id, "raw");
      throw dbErr;
    }

    const index = await getCourseIndex();
    const audienceCount = audienceCountFor(timetable.course, index);

    let message;
    if (!publish) {
      message = "Timetable uploaded as a draft.";
    } else if (audienceCount === 0) {
      message =
        `Uploaded, but no student matches the course "${timetable.course}" — ` +
        `nobody can see it yet. Change the audience to fix this.`;
    } else {
      message = `Timetable published to ${audienceCount} student${
        audienceCount === 1 ? "" : "s"
      }.`;
    }

    return res.status(201).json({
      success: true,
      message,
      audienceCount,
      timetable: { ...serializeTimetable(timetable), audienceCount },
    });
  } catch (error) {
    console.error("uploadTimetable error:", error);
    return res
      .status(500)
      .json({ message: error.message || "Failed to upload the timetable." });
  }
};

/* ────────────────────────────────────────────────────────────────
   📚 LIST ALL TIMETABLES  (exam-controller)
   GET /api/timetables
   ──────────────────────────────────────────────────────────────── */
export const getTimetables = async (req, res) => {
  try {
    const filter = {};

    const published = parseBool(req.query.isPublished);
    if (published !== undefined) filter.isPublished = published;

    const course = normalizeCourse(req.query.course);
    if (course) filter.course = new RegExp(`^${escapeRegex(course)}$`, "i");

    const [docs, index] = await Promise.all([
      Timetable.find(filter)
        .sort({ createdAt: -1 })
        .populate("uploadedBy", "fullName userId role"),
      getCourseIndex(),
    ]);

    return res.json({
      success: true,
      count: docs.length,
      totalStudents: index.totalStudents,
      courses: index.courses,
      timetables: docs.map((d) => ({
        ...serializeTimetable(d),
        // 0 here means the course target matches no student — the document
        // is published but nobody can see it.
        audienceCount: audienceCountFor(d.course, index),
      })),
    });
  } catch (error) {
    console.error("getTimetables error:", error);
    return res.status(500).json({ message: "Failed to load timetables." });
  }
};

/* ────────────────────────────────────────────────────────────────
   🎓 STUDENT VIEW — published timetables for me
   GET /api/timetables/published
   Returns published documents that are either global (no course set) or
   explicitly targeted at the caller's course.
   ──────────────────────────────────────────────────────────────── */
export const getPublishedTimetables = async (req, res) => {
  try {
    const myCourse = normalizeCourse(req.user?.course);

    const audience = [{ course: null }, { course: "" }];
    if (myCourse) {
      audience.push({ course: new RegExp(`^${escapeRegex(myCourse)}$`, "i") });
    }

    const docs = await Timetable.find({
      isPublished: true,
      $or: audience,
    }).sort({ publishedAt: -1, createdAt: -1 });

    const timetables = docs.map(serializeTimetable);

    return res.json({
      success: true,
      count: timetables.length,
      // The newest matching document is what the dashboard highlights.
      latest: timetables[0] ?? null,
      timetables,
    });
  } catch (error) {
    console.error("getPublishedTimetables error:", error);
    return res.status(500).json({ message: "Failed to load your timetable." });
  }
};

/* ────────────────────────────────────────────────────────────────
   🔍 SINGLE TIMETABLE
   GET /api/timetables/:id
   ──────────────────────────────────────────────────────────────── */
export const getTimetableById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid timetable id." });
    }

    const doc = await Timetable.findById(id).populate(
      "uploadedBy",
      "fullName userId role"
    );
    if (!doc) return res.status(404).json({ message: "Timetable not found." });

    // Students may only open what has actually been published to them.
    if (req.userRole === "student") {
      const myCourse = normalizeCourse(req.user?.course);
      const targeted = normalizeCourse(doc.course);
      const forMe =
        !targeted ||
        (myCourse && targeted.toLowerCase() === myCourse.toLowerCase());

      if (!doc.isPublished || !forMe) {
        return res
          .status(403)
          .json({ message: "This timetable is not available to you." });
      }
    }

    return res.json({ success: true, timetable: serializeTimetable(doc) });
  } catch (error) {
    console.error("getTimetableById error:", error);
    return res.status(500).json({ message: "Failed to load the timetable." });
  }
};

/* ────────────────────────────────────────────────────────────────
   ✏️ UPDATE  (exam-controller) — rename / retarget / publish toggle
   PATCH /api/timetables/:id
   ──────────────────────────────────────────────────────────────── */
export const updateTimetable = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid timetable id." });
    }

    const doc = await Timetable.findById(id);
    if (!doc) return res.status(404).json({ message: "Timetable not found." });

    const { title, examSession, description, course, isPublished } = req.body;

    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed)
        return res.status(400).json({ message: "Title cannot be empty." });
      doc.title = trimmed;
    }
    if (examSession !== undefined)
      doc.examSession = String(examSession).trim() || null;
    if (description !== undefined)
      doc.description = String(description).trim() || null;
    if (course !== undefined) doc.course = normalizeCourse(course);

    const publish = parseBool(isPublished);
    if (publish !== undefined && publish !== doc.isPublished) {
      doc.isPublished = publish;
      doc.publishedAt = publish ? new Date() : null;
    }

    await doc.save();

    const index = await getCourseIndex();
    const audienceCount = audienceCountFor(doc.course, index);

    return res.json({
      success: true,
      message:
        doc.isPublished && audienceCount === 0
          ? `Saved, but no student matches "${doc.course}" — nobody can see it yet.`
          : "Timetable updated.",
      audienceCount,
      timetable: { ...serializeTimetable(doc), audienceCount },
    });
  } catch (error) {
    console.error("updateTimetable error:", error);
    return res.status(500).json({ message: "Failed to update the timetable." });
  }
};

/* ────────────────────────────────────────────────────────────────
   🗑️ DELETE  (exam-controller)
   DELETE /api/timetables/:id
   ──────────────────────────────────────────────────────────────── */
export const deleteTimetable = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid timetable id." });
    }

    const doc = await Timetable.findById(id);
    if (!doc) return res.status(404).json({ message: "Timetable not found." });

    await destroyCloudinaryAsset(doc.filePublicId, doc.resourceType || "image");
    if (doc.rawPublicId) await destroyCloudinaryAsset(doc.rawPublicId, "raw");
    await doc.deleteOne();

    return res.json({ success: true, message: "Timetable deleted.", id });
  } catch (error) {
    console.error("deleteTimetable error:", error);
    return res.status(500).json({ message: "Failed to delete the timetable." });
  }
};
