// routes/summary.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase() };
}

// GET /weekly-reports
router.get("/", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);

    // 1) Get user's assigned offerings
    const assignedSql = `
      SELECT oa.offering_id, oa.role AS assign_role, c.name AS course_name
      FROM dbo.offering_assignments oa
      JOIN dbo.course_offerings o ON o.id = oa.offering_id
      JOIN dbo.courses c ON c.id = o.course_id
      WHERE oa.user_id = @p0
    `;
    const assigned = await query(assignedSql, [userId]);
    if (!assigned.recordset.length)
      return res.json({ status: true, summary: [] });

    // Filter according to user’s own role
    const filtered = assigned.recordset.filter((row) => {
      if (role === "student") return row.assign_role === "student";
      if (role === "teacher") return row.assign_role === "teacher";
      return true; // admin: include all
    });
    if (!filtered.length) return res.json({ status: true, summary: [] });

    const offeringIds = filtered.map((r) => r.offering_id);
    const makeInList = (count, startIndex = 0) =>
      Array.from({ length: count }, (_, i) => `@p${startIndex + i}`).join(",");

    const inList = makeInList(offeringIds.length);

    // === "Held" sessions equivalent: count all course_offerings ===
    const heldSql = `
      SELECT id AS offering_id, 1 AS held_sessions
      FROM dbo.course_offerings
      WHERE id IN (${inList})
    `;
    const heldRes = await query(heldSql, offeringIds);
    const heldMap = new Map();
    heldRes.recordset.forEach((r) => heldMap.set(r.offering_id, 1));

    // === Student Mode ===
    if (role === "student") {
      const presSql = `
        SELECT ar.offering_id, COUNT(*) AS present
        FROM dbo.attendance_records ar
        WHERE ar.user_id = @p0
          AND ar.check_in_at IS NOT NULL
          AND ar.offering_id IN (${inList})
        GROUP BY ar.offering_id
      `;
      const presRes = await query(presSql, [userId, ...offeringIds]);
      const presentMap = new Map();
      presRes.recordset.forEach((r) =>
        presentMap.set(r.offering_id, Number(r.present) || 0)
      );

      const summary = filtered.map((row) => {
        const offId = row.offering_id;
        const held = heldMap.get(offId) ?? 1;
        const attend = presentMap.get(offId) ?? 0;
        const absence = Math.max(held - attend, 0);
        return {
          offering_id: offId,
          course_name: row.course_name,
          attend,
          absence,
        };
      });

      return res.json({ status: true, summary });
    }

    // === Teacher / Admin Mode ===
    // For new schema: each offering can be considered one session
    const teachSql = `
      SELECT id AS offering_id, 1 AS started_sessions
      FROM dbo.course_offerings
      WHERE id IN (${inList})
    `;
    const teachRes = await query(teachSql, offeringIds);
    const startedMap = new Map();
    teachRes.recordset.forEach((r) => startedMap.set(r.offering_id, 1));

    const summary = filtered.map((row) => {
      const offId = row.offering_id;
      const held = heldMap.get(offId) ?? 1;
      const attend = startedMap.get(offId) ?? 0;
      const absence = Math.max(held - attend, 0);
      return {
        offering_id: offId,
        course_name: row.course_name,
        attend,
        absence,
      };
    });

    return res.json({ status: true, summary });
  } catch (e) {
    console.error("summary report error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
