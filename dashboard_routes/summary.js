// dashboard_routes/summary.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// Optional: stricter check
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

/**
 * GET /dashboard/summary
 * Returns:
 * {
 *   total_students,
 *   total_teachers,
 *   total_assistants,
 *   total_rooms,
 *   total_departments,
 *   students_by_department: [{ department, count }]
 * }
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    // totals by role
    const roleSql = `
      SELECT role, COUNT(*) AS total
      FROM dbo.users
      GROUP BY role
    `;
    const roleRes = await query(roleSql);

    let total_students = 0,
      total_teachers = 0,
      total_assistants = 0;
    for (const r of roleRes.recordset) {
      if (r.role === "student") total_students = r.total;
      else if (r.role === "teacher") total_teachers = r.total;
      else if (r.role === "assistant") total_assistants = r.total;
    }

    // total rooms
    const roomRes = await query(
      "SELECT COUNT(*) AS total_rooms FROM dbo.rooms"
    );

    // total departments
    const depRes = await query(
      "SELECT COUNT(DISTINCT department) AS total_departments FROM dbo.users WHERE department IS NOT NULL"
    );

    // student count per department
    const mapRes = await query(`
      SELECT department, COUNT(*) AS total_students
      FROM dbo.users
      WHERE role = 'student' AND department IS NOT NULL
      GROUP BY department
      ORDER BY department
    `);

    return res.json({
      status: true,
      total_students,
      total_teachers,
      total_assistants,
      total_rooms: roomRes.recordset[0].total_rooms,
      total_departments: depRes.recordset[0].total_departments,
      students_by_department: mapRes.recordset,
    });
  } catch (e) {
    console.error("dashboard summary error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
