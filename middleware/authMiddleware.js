import jwt from "jsonwebtoken";
import User from "../models/user.js";

export const protect = async (req, res, next) => {
  try {
    let token = null;

    // ✅ 1. Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    // ❌ No token
    if (!token) {
      return res.status(401).json({
        message: "Not authorized, token missing",
      });
    }

    // ✅ 2. Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    // decoded contains: { id, role, userId, iat, exp }

    // ✅ 3. Find user in database
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        message: "User not found",
      });
    }

    // ✅ 4. Attach user to request
    req.user = user;
    req.userId = user._id;
    req.userRole = user.role;

    next();

  } catch (error) {

    console.error("Protect middleware error:", error.message);

    // ❌ Invalid token
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        message: "Invalid token",
      });
    }

    // ❌ Expired token
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Token expired",
      });
    }

    // ❌ Other errors
    return res.status(401).json({
      message: "Not authorized",
    });
  }
};

/**
 * ROLE GUARD — restrict a route to one or more roles.
 * Usage: router.post("/verify", protect, restrictTo("invigilator", "exam-controller"), handler)
 */
export const restrictTo = (...roles) => (req, res, next) => {
  if (!req.userRole || !roles.includes(req.userRole)) {
    return res.status(403).json({
      message: "You do not have permission to perform this action",
    });
  }
  next();
};

/**
 * Convenience guard — exam-controller only.
 */
export const examControllerOnly = restrictTo("exam-controller");
