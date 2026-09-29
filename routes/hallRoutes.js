// routes/hallRoutes.js
import express from "express";
import { protect, restrictTo } from "../middleware/authMiddleware.js";
import { listHalls, createHall, updateHall } from "../controllers/hallController.js";

const router = express.Router();

/*
  BASE URL: /api/halls
*/

// Any signed-in user may read the hall list (session screens display names).
router.get("/", protect, listHalls);

router.post("/", protect, restrictTo("exam-controller"), createHall);
router.patch("/:id", protect, restrictTo("exam-controller"), updateHall);

export default router;
