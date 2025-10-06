// routes/offeringAssignments.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");

/**
 * POST /offering-assignments
 * Body: { offering_id, user_id }
 * - Validates both exist
 * - Derives role from users.role (must be 'student' or 'teacher')
 * - Inserts into dbo.offering_assignments (unique on (offering_id, user_id))
 */
router.post("/", async (req, res) => {
  try {
    const { offering_id, user_id } = req.body;

    if (!offering_id || !user_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id and user_id are required" });
    }

    // 1) Check offering exists
    const off = await query(
      "SELECT id FROM dbo.course_offerings WHERE id=@p0",
      [offering_id]
    );
    if (off.recordset.length === 0) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }

    // 2) Get user & role
    const u = await query(
      "SELECT id, role, name, email FROM dbo.users WHERE id=@p0",
      [user_id]
    );
    if (u.recordset.length === 0) {
      return res.status(404).json({ status: false, error: "User not found" });
    }
    const user = u.recordset[0];

    if (!["student", "teacher"].includes(user.role)) {
      return res.status(400).json({
        status: false,
        error: "Only students or teachers can be assigned",
      });
    }

    // 3) Insert assignment
    const ins = `
      INSERT INTO dbo.offering_assignments (offering_id, user_id, role)
      VALUES (@p0, @p1, @p2)
    `;
    await query(ins, [offering_id, user_id, user.role]);

    return res.json({
      status: true,
      message: `Assigned ${user.role} (user_id=${user_id}) to offering ${offering_id}`,
    });
  } catch (err) {
    // Duplicate (already assigned)
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({
        status: false,
        error: "User already assigned to this offering",
      });
    }
    // FK violations (bad ids)
    if (err.number === 547) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid offering_id or user_id" });
    }
    console.error("Assign offering error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to assign user to offering" });
  }
});

/**
 * POST /offering-assignments/my-week
 * Body: { user_id }
 * Returns all assigned offerings for this user grouped by day_of_week
 */
router.post("/my-week", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return res
        .status(400)
        .json({ status: false, error: "user_id is required" });
    }

    // If sessions are now stored in course_offerings, remove the join with course_sessions
    const sql = `
  SELECT
    o.day_of_week,
    o.id             AS offering_id,
    c.name           AS course_name,
    c.code           AS course_code,
    r.name           AS room_name,
    d.name           AS department_name,
    CONVERT(VARCHAR(5), o.start_time, 108) AS start_time,
    CONVERT(VARCHAR(5), o.end_time,   108) AS end_time,
    a.role
  FROM dbo.offering_assignments a
  JOIN dbo.course_offerings o ON o.id = a.offering_id
  JOIN dbo.courses c ON c.id = o.course_id
  LEFT JOIN dbo.departments d ON d.id = c.department_id
  LEFT JOIN dbo.rooms r ON r.id = o.room_id
  WHERE a.user_id = @p0
  ORDER BY o.day_of_week, o.start_time, r.name, o.id;
`;

    const r = await query(sql, [user_id]);
    const week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const row of r.recordset) {
      week[String(row.day_of_week)].push({
        offering_id: row.offering_id,
        course_code: row.course_code,
        course_name: row.course_name,
        department_name: row.department_name,
        room: row.room_name,
        start_time: row.start_time,
        end_time: row.end_time,
        role: row.role,
      });
    }

    return res.json({
      status: true,
      user_id,
      totals: Object.fromEntries(
        Object.keys(week).map((k) => [k, week[k].length])
      ),
      data: week,
    });
  } catch (err) {
    console.error("my-week error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch assignments" });
  }
});

module.exports = router;
