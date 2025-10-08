// routes/summary.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase() };
}

router.get("/", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);

    // 1) get offerings assigned to this user
    const assignedSql = `
      SELECT oa.offering_id, oa.role AS assign_role, c.name AS course_name
      FROM dbo.offering_assignments oa
      JOIN dbo.course_offerings o ON o.id = oa.offering_id
      JOIN dbo.courses c          ON c.id = o.course_id
      WHERE oa.user_id = @p0
    `;
    const assigned = await query(assignedSql, [userId]);
    if (!assigned.recordset.length) {
      return res.json({ status: true, summary: [] });
    }

    // filter by the user's role
    const filtered = assigned.recordset.filter((row) => {
      if (role === "student") return row.assign_role === "student";
      if (role === "teacher") return row.assign_role === "teacher";
      return true; // admin
    });
    if (!filtered.length) return res.json({ status: true, summary: [] });

    const offeringIds = filtered.map((r) => r.offering_id);
    const makeInList = (count, startIndex = 0) =>
      Array.from({ length: count }, (_, i) => `@p${startIndex + i}`).join(",");

    // 2) Held sessions per offering (from course_sessions)
    const heldInList = makeInList(offeringIds.length);
    const heldSql = `
      SELECT cs.offering_id, COUNT(*) AS held_sessions
      FROM dbo.course_sessions cs
      WHERE cs.offering_id IN (${heldInList})
      GROUP BY cs.offering_id
    `;
    const heldRes = await query(heldSql, offeringIds);
    const heldMap = new Map();
    heldRes.recordset.forEach((r) =>
      heldMap.set(r.offering_id, Number(r.held_sessions) || 0)
    );

    if (role === "student") {
      // 3a) Student: how many sessions did THIS student attend (check-in)
      // JOIN attendance_records -> course_sessions to get offering_id
      const presSql = `
        SELECT cs.offering_id, COUNT(DISTINCT ar.session_id) AS present
        FROM dbo.attendance_records ar
        JOIN dbo.course_sessions  cs ON cs.id = ar.session_id
        WHERE ar.user_id = @p0
          AND ar.check_in_at IS NOT NULL
          AND cs.offering_id IN (${makeInList(offeringIds.length, 1)})
        GROUP BY cs.offering_id
      `;
      const presRes = await query(presSql, [userId, ...offeringIds]);
      const presentMap = new Map();
      presRes.recordset.forEach((r) =>
        presentMap.set(r.offering_id, Number(r.present) || 0)
      );

      const summary = filtered.map((row) => {
        const offId = row.offering_id;
        const held = heldMap.get(offId) ?? 0;
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

    // 3b) Teacher/Admin: sessions they actually started/ran
    // If you only want sessions that were started, filter by status = 'started' or include 'ended'
    const teachSql = `
      SELECT cs.offering_id, COUNT(*) AS started_sessions
      FROM dbo.course_sessions cs
      WHERE cs.offering_id IN (${heldInList})
        AND cs.status IN ('started','ended')
      GROUP BY cs.offering_id
    `;
    const teachRes = await query(teachSql, offeringIds);
    const startedMap = new Map();
    teachRes.recordset.forEach((r) =>
      startedMap.set(r.offering_id, Number(r.started_sessions) || 0)
    );

    const summary = filtered.map((row) => {
      const offId = row.offering_id;
      const held = heldMap.get(offId) ?? 0;
      const attend = startedMap.get(offId) ?? 0; // sessions actually held
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
