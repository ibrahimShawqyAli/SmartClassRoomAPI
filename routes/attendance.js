// routes/reports.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * Build 16 weekly dates, starting from an anchor date (YYYY-MM-DD).
 * Weeks are anchored to the DATE (no time) and incremented by 7 days.
 */
function buildWeeks(anchorISO) {
  const out = [];
  const anchor = new Date(anchorISO + "T00:00:00Z");
  for (let w = 0; w < 16; w++) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + 7 * w);
    out.push({ week: w + 1, iso: d.toISOString().slice(0, 10) });
  }
  return out;
}

/**
 * Helper: pick anchor date for 16 weeks.
 * Prefer the earliest planned session date; fallback to offering.created_at (UTC date).
 */
async function getAnchorDate(offeringId) {
  // earliest session date
  const s = await query(
    `SELECT MIN(CAST(planned_start_utc AS date)) AS min_date
       FROM dbo.course_sessions
      WHERE offering_id = @p0`,
    [offeringId]
  );
  const row = s.recordset[0];
  if (row && row.min_date) {
    // row.min_date is a JS Date
    return new Date(row.min_date).toISOString().slice(0, 10);
  }
  // fallback to offering.created_at
  const o = await query(
    `SELECT CAST(created_at AS date) AS created_date
       FROM dbo.course_offerings
      WHERE id = @p0`,
    [offeringId]
  );
  const r = o.recordset[0];
  if (r && r.created_date) {
    return new Date(r.created_date).toISOString().slice(0, 10);
  }
  // last resort: today
  return new Date().toISOString().slice(0, 10);
}

/**
 * STUDENT REPORT
 * POST /reports/student
 * Body: { offering_id }
 */
router.post("/student", auth, async (req, res) => {
  try {
    const { offering_id } = req.body || {};
    if (!offering_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id required" });
    }

    // must be assigned or admin
    const assigned = await query(
      `SELECT 1 FROM dbo.offering_assignments WHERE offering_id=@p0 AND user_id=@p1`,
      [offering_id, req.user.id]
    );
    if (!assigned.recordset.length && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned to this offering" });
    }

    // basic offering info
    const off = await query(
      `SELECT o.id, c.name AS course_name, o.created_at
         FROM dbo.course_offerings o
         JOIN dbo.courses c ON c.id = o.course_id
        WHERE o.id=@p0`,
      [offering_id]
    );
    if (!off.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }

    // anchor is first session date (preferred)
    const anchorISO = await getAnchorDate(offering_id);
    const weeks = buildWeeks(anchorISO);
    const todayISO = new Date().toISOString().slice(0, 10);

    // fetch sessions for this offering (map by ISO date)
    const sessionsRes = await query(
      `SELECT id, planned_start_utc, status, started_at, ended_at
         FROM dbo.course_sessions
        WHERE offering_id=@p0`,
      [offering_id]
    );

    const sessionsByDate = new Map();
    for (const s of sessionsRes.recordset) {
      if (!s.planned_start_utc) continue;
      const iso = new Date(s.planned_start_utc).toISOString().slice(0, 10);
      sessionsByDate.set(iso, s);
    }

    // fetch this student's attendance for these sessions
    const attRes = await query(
      `SELECT ar.session_id, ar.check_in_at, ar.check_out_at
         FROM dbo.attendance_records ar
        WHERE ar.user_id=@p0
          AND ar.session_id IN (SELECT id FROM dbo.course_sessions WHERE offering_id=@p1)`,
      [req.user.id, offering_id]
    );

    // index attendance by session_id
    const attBySession = new Map();
    for (const r of attRes.recordset) {
      const arr = attBySession.get(r.session_id) || [];
      arr.push(r);
      attBySession.set(r.session_id, arr);
    }

    const weekReports = [];
    const summary = { attend: 0, absence: 0, cancelled: 0, upcoming: 0 };

    for (const w of weeks) {
      const session = sessionsByDate.get(w.iso);
      let status = "upcoming";
      let check_in_time = null;
      let check_out_time = null;

      if (w.iso > todayISO) {
        status = "upcoming";
      } else if (!session) {
        status = "cancelled";
      } else {
        const recs = attBySession.get(session.id) || [];
        const firstIn = recs
          .map((r) =>
            r.check_in_at ? new Date(r.check_in_at).getTime() : null
          )
          .filter(Boolean);
        const lastOut = recs
          .map((r) =>
            r.check_out_at ? new Date(r.check_out_at).getTime() : null
          )
          .filter(Boolean);

        if (firstIn.length) {
          status = "attend";
          const minIn = new Date(Math.min(...firstIn))
            .toISOString()
            .slice(11, 19);
          check_in_time = minIn;
          if (lastOut.length) {
            const maxOut = new Date(Math.max(...lastOut))
              .toISOString()
              .slice(11, 19);
            check_out_time = maxOut;
          }
        } else {
          // session existed but no check-in
          status = "absence";
        }
      }

      summary[status] += 1;
      weekReports.push({
        week: w.week,
        planned_date: w.iso,
        status,
        check_in_time,
        check_out_time,
      });
    }

    return res.json({
      status: true,
      offering_id,
      student_id: req.user.id,
      weeks_total: 16,
      weeks: weekReports,
      summary,
    });
  } catch (e) {
    console.error("student report error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * TEACHER REPORT
 * POST /reports/teacher
 * Body: { offering_id }
 */
router.post("/teacher", auth, async (req, res) => {
  try {
    const { offering_id } = req.body || {};
    if (!offering_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id required" });
    }

    // must be assigned as teacher or admin
    const assigned = await query(
      `SELECT 1 FROM dbo.offering_assignments WHERE offering_id=@p0 AND user_id=@p1 AND role='teacher'`,
      [offering_id, req.user.id]
    );
    if (!assigned.recordset.length && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned as teacher" });
    }

    const off = await query(
      `SELECT o.id, c.name AS course_name, o.created_at
         FROM dbo.course_offerings o
         JOIN dbo.courses c ON c.id = o.course_id
        WHERE o.id=@p0`,
      [offering_id]
    );
    if (!off.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }

    const anchorISO = await getAnchorDate(offering_id);
    const weeks = buildWeeks(anchorISO);
    const todayISO = new Date().toISOString().slice(0, 10);

    // fetch sessions
    const sessionsRes = await query(
      `SELECT id, planned_start_utc, status, started_at, ended_at
         FROM dbo.course_sessions
        WHERE offering_id=@p0`,
      [offering_id]
    );

    const sessionsByDate = new Map();
    for (const s of sessionsRes.recordset) {
      if (!s.planned_start_utc) continue;
      const iso = new Date(s.planned_start_utc).toISOString().slice(0, 10);
      sessionsByDate.set(iso, s);
    }

    const weekReports = [];
    const summary = { ended: 0, started: 0, cancelled: 0, upcoming: 0 };

    for (const w of weeks) {
      const session = sessionsByDate.get(w.iso);
      let status = "upcoming";
      let start_time = null;
      let end_time = null;

      if (w.iso > todayISO) {
        status = "upcoming";
      } else if (!session) {
        status = "cancelled";
      } else {
        if (session.status === "ended") {
          status = "ended";
          start_time = session.started_at
            ? new Date(session.started_at).toISOString().slice(11, 19)
            : null;
          end_time = session.ended_at
            ? new Date(session.ended_at).toISOString().slice(11, 19)
            : null;
        } else if (session.status === "started") {
          status = "started";
          start_time = session.started_at
            ? new Date(session.started_at).toISOString().slice(11, 19)
            : null;
        } else {
          // if some other custom status appears, treat as cancelled on the grid
          status = "cancelled";
        }
      }

      summary[status] += 1;
      weekReports.push({
        week: w.week,
        planned_date: w.iso,
        status,
        start_time,
        end_time,
      });
    }

    return res.json({
      status: true,
      offering_id,
      weeks_total: 16,
      weeks: weekReports,
      summary,
    });
  } catch (e) {
    console.error("teacher report error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
