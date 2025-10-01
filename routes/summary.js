// routes/summary.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// small helper to read user, compatible with your middleware
function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase() };
}

// GET /weekly-reports  (mounted as /weekly-reports in index.js)
router.get("/", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);
    const todayISO = new Date().toISOString().slice(0, 10);

    // 1) Which offerings is this user assigned to?
    const assignedSql = `
      SELECT oa.offering_id, oa.role AS assign_role, c.name AS course_name
      FROM dbo.offering_assignments oa
      JOIN dbo.course_offerings o ON o.id = oa.offering_id
      JOIN dbo.courses c ON c.id = o.course_id
      WHERE oa.user_id = @p0
    `;
    const assigned = await query(assignedSql, [userId]);

    if (!assigned.recordset.length) {
      // not assigned to anything -> empty summary
      return res.json({ status: true, summary: [] });
    }

    // Filter by the user's role
    const filtered = assigned.recordset.filter((row) => {
      if (role === "student") return row.assign_role === "student";
      if (role === "teacher") return row.assign_role === "teacher";
      return true; // admin: keep all the user’s assigned offerings
    });
    if (!filtered.length) {
      return res.json({ status: true, summary: [] });
    }

    const offeringIds = filtered.map((r) => r.offering_id);

    // Helper to build a parameterized IN list: @p0,@p1,@p2...
    const makeInList = (count, startIndex = 0) =>
      Array.from({ length: count }, (_, i) => `@p${startIndex + i}`).join(",");

    // 2) Count "held" sessions (planned on/before today) per offering
    const inList = makeInList(offeringIds.length, 0);
    const heldSql = `
      SELECT offering_id, COUNT(*) AS held_sessions
      FROM dbo.course_sessions
      WHERE offering_id IN (${inList})
        AND CAST(planned_start_utc AS DATE) <= @p${offeringIds.length}
      GROUP BY offering_id
    `;
    const heldRes = await query(heldSql, [...offeringIds, todayISO]);
    const heldMap = new Map();
    heldRes.recordset.forEach((r) =>
      heldMap.set(r.offering_id, Number(r.held_sessions) || 0)
    );

    // === Student Mode ===
    if (role === "student") {
      const presSql = `
        SELECT s.offering_id, COUNT(DISTINCT ar.session_id) AS present
        FROM dbo.attendance_records ar
        JOIN dbo.course_sessions s ON s.id = ar.session_id
        WHERE ar.user_id = @p0
          AND ar.check_in_at IS NOT NULL
          AND s.offering_id IN (${inList})
          AND CAST(s.planned_start_utc AS DATE) <= @p${offeringIds.length + 1}
        GROUP BY s.offering_id
      `;
      const presRes = await query(presSql, [userId, ...offeringIds, todayISO]);
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

    // === Teacher/Admin Mode ===
    // Teachers -> only sessions they started
    // Admins   -> all sessions (any starter)
    let teacherSql;
    let teacherParams;

    if (role === "teacher") {
      teacherSql = `
        SELECT offering_id, COUNT(*) AS started_sessions
        FROM dbo.course_sessions
        WHERE offering_id IN (${inList})
          AND CAST(planned_start_utc AS DATE) <= @p${offeringIds.length}
          AND status IN ('started','ended')
          AND started_by = @p${offeringIds.length + 1}
        GROUP BY offering_id
      `;
      teacherParams = [...offeringIds, todayISO, userId];
    } else {
      // admin
      teacherSql = `
        SELECT offering_id, COUNT(*) AS started_sessions
        FROM dbo.course_sessions
        WHERE offering_id IN (${inList})
          AND CAST(planned_start_utc AS DATE) <= @p${offeringIds.length}
          AND status IN ('started','ended')
        GROUP BY offering_id
      `;
      teacherParams = [...offeringIds, todayISO];
    }

    const teacherRes = await query(teacherSql, teacherParams);
    const startedMap = new Map();
    teacherRes.recordset.forEach((r) =>
      startedMap.set(r.offering_id, Number(r.started_sessions) || 0)
    );

    const summary = filtered.map((row) => {
      const offId = row.offering_id;
      const held = heldMap.get(offId) ?? 0;
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
