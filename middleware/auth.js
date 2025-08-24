// middleware/auth.js
const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
      return res
        .status(401)
        .json({ status: false, error: "No token provided" });
    }

    const token = authHeader.split(" ")[1]; // Expect: "Bearer <token>"
    if (!token) {
      return res.status(401).json({ status: false, error: "Malformed token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "supersecret");
    req.user = { id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res
      .status(403)
      .json({ status: false, error: "Invalid or expired token" });
  }
};
