const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");

/**
 * POST /lecture-assignments
 * Body: { lecture_id, user_id }
 * - Validates both exist
 * - Derives role from users.role (must be 'student' or 'teacher')
 * - Inserts into dbo.lecture_assignments (unique on (lecture_id, user_id))
 */
router.post("/", async (req, res) => {
  try {
    const { lecture_id, user_id } = req.body;

    if (!lecture_id || !user_id) {
      return res
        .status(400)
        .json({ status: false, error: "lecture_id and user_id are required" });
    }

    // 1) Check lecture exists
    const lec = await query("SELECT id FROM dbo.lectures WHERE id=@p0", [
      lecture_id,
    ]);
    if (lec.recordset.length === 0) {
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });
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
      INSERT INTO dbo.lecture_assignments (lecture_id, user_id, role)
      VALUES (@p0, @p1, @p2)
    `;
    await query(ins, [lecture_id, user_id, user.role]);

    return res.json({
      status: true,
      message: `Assigned ${user.role} (user_id=${user_id}) to lecture ${lecture_id}`,
    });
  } catch (err) {
    // Duplicate (already assigned)
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({
        status: false,
        error: "User already assigned to this lecture",
      });
    }
    // FK violations (bad ids) -> just in case
    if (err.number === 547) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid lecture_id or user_id" });
    }
    console.error("Assign lecture error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to assign user to lecture" });
  }
});
// Get all assigned lectures for a user, grouped by day_of_week (0..6)
router.post("/my-week", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return res
        .status(400)
        .json({ status: false, error: "user_id is required" });
    }

    // Pull all assignments for the user
    const sql = `
      SELECT
        l.day_of_week,
        l.id           AS lecture_id,
        l.name,
        l.place,
        l.start_date,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time, -- "HH:mm:ss"
        CONVERT(VARCHAR(8), l.end_time,   108) AS end_time,   -- computed HH:mm:ss
        l.duration_minutes,
        la.role
      FROM dbo.lecture_assignments la
      JOIN dbo.lectures l ON l.id = la.lecture_id
      WHERE la.user_id = @p0
      ORDER BY l.day_of_week, l.start_time, l.place, l.id;
    `;
    const r = await query(sql, [user_id]);

    // Build week buckets 0..6
    const week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const row of r.recordset) {
      week[String(row.day_of_week)].push({
        lecture_id: row.lecture_id,
        name: row.name,
        place: row.place,
        start_date: row.start_date, // first calendar date
        start_time: row.start_time, // "HH:mm:ss"
        end_time: row.end_time, // "HH:mm:ss"
        duration_minutes: row.duration_minutes,
        role: row.role, // 'student' or 'teacher'
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
