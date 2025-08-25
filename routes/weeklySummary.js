// routes/summary.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// POST /reports/summary (token only)
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role; // 'student' | 'teacher' | 'admin'
    const todayISO = new Date().toISOString().slice(0, 10);

    // 1) Which lectures is this user assigned to?
    const assignedSql = `
      SELECT la.lecture_id, la.role AS assign_role, l.name
      FROM dbo.lecture_assignments la
      JOIN dbo.lectures l ON l.id = la.lecture_id
      WHERE la.user_id = @p0
    `;
    const assigned = await query(assignedSql, [userId]);
    if (!assigned.recordset.length) {
      return res.json({ status: true, summary: [] });
    }

    // Filter by role
    const filtered = assigned.recordset.filter((row) => {
      if (role === "student") return row.assign_role === "student";
      if (role === "teacher") return row.assign_role === "teacher";
      return true; // admin sees all
    });
    if (!filtered.length) {
      return res.json({ status: true, summary: [] });
    }

    const lectureIds = filtered.map((r) => r.lecture_id);

    // Helper to build IN list
    const makeInList = (count, startIndex = 0) =>
      Array.from({ length: count }, (_, i) => `@p${startIndex + i}`).join(",");

    // 2) Count all scheduled sessions (held until today)
    const heldInList = makeInList(lectureIds.length, 0);
    const heldSql = `
      SELECT lecture_id, COUNT(*) AS held_sessions
      FROM dbo.lecture_sessions
      WHERE lecture_id IN (${heldInList})
        AND planned_date <= @p${lectureIds.length}
      GROUP BY lecture_id
    `;
    const heldParams = [...lectureIds, todayISO];
    const heldRes = await query(heldSql, heldParams);
    const heldMap = new Map();
    heldRes.recordset.forEach((r) =>
      heldMap.set(r.lecture_id, r.held_sessions)
    );

    // === Student Mode ===
    if (role === "student") {
      const presSql = `
        SELECT s.lecture_id, COUNT(DISTINCT ar.session_id) AS present
        FROM dbo.attendance_records ar
        JOIN dbo.lecture_sessions s ON s.id = ar.session_id
        WHERE ar.user_id = @p0
          AND ar.check_in_at IS NOT NULL
          AND s.lecture_id IN (${heldInList})
          AND s.planned_date <= @p${lectureIds.length + 1}
        GROUP BY s.lecture_id
      `;
      const presParams = [userId, ...lectureIds, todayISO];
      const presRes = await query(presSql, presParams);
      const presentMap = new Map();
      presRes.recordset.forEach((r) => presentMap.set(r.lecture_id, r.present));

      const summary = filtered.map((row) => {
        const lecId = row.lecture_id;
        const held = heldMap.get(lecId) || 0;
        const attend = presentMap.get(lecId) || 0;
        const absence = Math.max(held - attend, 0);
        return { lecture_id: lecId, attend, absence };
      });

      return res.json({ status: true, summary });
    }

    // === Teacher/Admin Mode ===
    // Teacher's own attendance = sessions they actually started
    const teacherSql = `
      SELECT lecture_id, COUNT(*) AS started_sessions
      FROM dbo.lecture_sessions
      WHERE lecture_id IN (${heldInList})
        AND planned_date <= @p${lectureIds.length}
        AND status IN ('started','ended')
      GROUP BY lecture_id
    `;
    const teacherParams = [...lectureIds, todayISO];
    const teacherRes = await query(teacherSql, teacherParams);
    const startedMap = new Map();
    teacherRes.recordset.forEach((r) =>
      startedMap.set(r.lecture_id, r.started_sessions)
    );

    const summary = filtered.map((row) => {
      const lecId = row.lecture_id;
      const held = heldMap.get(lecId) || 0;
      const attend = startedMap.get(lecId) || 0;
      const absence = Math.max(held - attend, 0);
      return { lecture_id: lecId, attend, absence, lecture_name: row.name };
    });

    return res.json({ status: true, summary });
  } catch (e) {
    console.error("summary report error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
