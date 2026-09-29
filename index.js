import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import connectDB from "./config/db.js";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import studentRoutes from "./routes/studentRoutes.js";
import timetableRoutes from "./routes/timetableRoutes.js";
import hallRoutes from "./routes/hallRoutes.js";
import examSessionRoutes from "./routes/examSessionRoutes.js";
import verificationRoutes from "./routes/verificationRoutes.js";
import Hall from "./models/Hall.js";
import "./config/cloudinary.js";

dotenv.config();

const app = express();

// ── BODY PARSER ─────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS CONFIGURATION ──────────────────────
// ✅ Allow only whitelisted origins
const allowedOrigins = ["http://localhost:8081"];

// Expo doesn't always serve from localhost: on a device or on web opened via the
// LAN URL the browser Origin is http://<LAN-IP>:8081 (and the dev port varies:
// 8081, 19000, 19006...). Allow any loopback/private-network origin in dev so
// those requests aren't rejected, while keeping the explicit whitelist above.
const isLocalOrigin = (origin) => {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
};

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1 && !isLocalOrigin(origin)) {
        const msg = "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Let cors middleware handle preflight OPTIONS automatically
// ❌ REMOVE any manual app.options("*") handlers

// ── ROUTES ─────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/timetables", timetableRoutes);

// ── SESSION-SCOPED VERIFICATION (new) ───────
// Registered HERE, above the /api 404 handler below — anything mounted after
// that handler is swallowed and returns 404.
app.use("/api/halls", hallRoutes);
app.use("/api/exam-sessions", examSessionRoutes);
app.use("/api/verifications", verificationRoutes);

// ── ROOT ROUTE ──────────────────────────────
app.get("/", (req, res) => {
  res.send(" QR Code Student Verification API is running!");
});

// ── 404 FOR UNMATCHED API ROUTES ────────────
// Scoped to /api so nothing else changes. Express's default 404 is an HTML
// page, which axios surfaces as a bare "Request failed with status code 404"
// with no message — this makes a stale server or a typo'd path say so out loud.
app.use("/api", (req, res) => {
  res.status(404).json({
    message: `Route not found: ${req.method} ${req.baseUrl}${req.path === "/" ? "" : req.path}`,
    hint: "Check the path, or restart the API server if this route was added recently.",
  });
});

// ── CREATE DEFAULT HALLS IF MISSING ─────────────
const createDefaultHalls = async () => {
  try {
    const hallCount = await Hall.countDocuments();
    if (hallCount === 0) {
      console.log("📍 Creating default halls (10-50)...");
      const defaultHalls = [];
      for (let i = 10; i <= 50; i++) {
        defaultHalls.push({
          name: `Hall ${i}`,
          code: `HALL-${i}`,
          capacity: 100,
          location: `Building ${Math.ceil(i / 10)}`,
          status: "ACTIVE",
        });
      }
      await Hall.insertMany(defaultHalls);
      console.log(`✅ ${defaultHalls.length} default halls created (10-50)`);
    } else {
      console.log(`✅ Halls already exist (${hallCount} total)`);
    }
  } catch (error) {
    console.error("⚠️ Error creating default halls:", error.message);
  }
};

// ── START SERVER AFTER DB CONNECTION ─────────
const startServer = async () => {
  try {
    // Fail fast if signing secrets are missing.
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not defined in .env");
    }
    if (!process.env.QR_SECRET) {
      throw new Error("QR_SECRET is not defined in .env (required to sign QR hall-tickets)");
    }

    await connectDB();
    console.log(" MongoDB Connected Successfully!");

    // Create default halls if none exist
    await createDefaultHalls();

    const PORT = process.env.PORT || 5000;
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // Graceful handling for a busy port (avoids an ugly unhandled crash).
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `❌ Port ${PORT} is already in use. Another server instance is likely still running.`
        );
        console.error(
          `   → Stop it, or start on another port:  PORT=5001 npm start`
        );
      } else {
        console.error("❌ Server error:", err.message);
      }
      process.exit(1);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
};

startServer();