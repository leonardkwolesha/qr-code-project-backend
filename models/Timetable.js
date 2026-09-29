// models/Timetable.js
import mongoose from "mongoose";

/**
 * 📅 EXAM TIMETABLE
 * An exam-controller uploads the official examination timetable as a PDF.
 * The file itself lives on Cloudinary; this document keeps the metadata plus
 * the identifiers needed to build page-preview / download URLs on the fly.
 */
const timetableSchema = new mongoose.Schema(
  {
    // =============================
    // DISPLAY INFO
    // =============================
    title: {
      type: String,
      required: true,
      trim: true,
    },

    // e.g. "Semester 1 · 2025/2026"
    examSession: {
      type: String,
      trim: true,
      default: null,
    },

    description: {
      type: String,
      trim: true,
      default: null,
    },

    // Target audience. `null` (or empty) means: visible to every student.
    course: {
      type: String,
      trim: true,
      default: null,
    },

    // =============================
    // CLOUDINARY FILE
    // =============================
    fileUrl: {
      type: String,
      required: true,
    },

    filePublicId: {
      type: String,
      required: true,
    },

    // Cloudinary resource type used at upload time ("image" for PDFs so that
    // per-page JPG previews can be derived, "raw" as the fallback).
    resourceType: {
      type: String,
      enum: ["image", "raw"],
      default: "image",
    },

    fileFormat: {
      type: String,
      default: "pdf",
      lowercase: true,
      trim: true,
    },

    originalName: {
      type: String,
      default: null,
      trim: true,
    },

    bytes: {
      type: Number,
      default: 0,
    },

    // Cloudinary asset version — pins preview/download URLs to this exact upload.
    version: {
      type: Number,
      default: null,
    },

    // ── DELIVERABLE COPY ──
    // Cloudinary accounts can have "Allow delivery of PDF and ZIP files"
    // disabled, which 401s any delivery URL ending in .pdf — including the
    // image-type original. When that is the case the upload also stores an
    // extension-less `raw` copy, which always delivers, and open/download
    // links point at it. Page previews still come from the image copy.
    rawPublicId: {
      type: String,
      default: null,
    },

    rawVersion: {
      type: Number,
      default: null,
    },

    // Number of pages in the PDF — drives the preview pager.
    pages: {
      type: Number,
      default: 1,
      min: 1,
    },

    // =============================
    // VISIBILITY
    // =============================
    isPublished: {
      type: Boolean,
      default: true,
      index: true,
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Students query "published + (my course OR global)", newest first.
timetableSchema.index({ isPublished: 1, course: 1, createdAt: -1 });

const Timetable =
  mongoose.models.Timetable || mongoose.model("Timetable", timetableSchema);

export default Timetable;
