// routes/reports.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * Helper: generate 16 planned weeks (date + index)
 */
function generateWeeks(startDate) {
  const weeks = [];
  for (let w = 0; w < 16; w++) {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + 7 * w);
    weeks.push({ week: w, planned_date: d.toISOString().slice(0, 10) });
  }
  return weeks;
}

/**
 * STUDENT REPORT
 * POST /reports/student
 * Body: { lecture_id }
 */
router.get("/student", auth, async (req, res) => {
  try {
    const { lecture_id } = req.body;
    if (!lecture_id)
      return res
        .status(400)
        .json({ status: false, error: "lecture_id required" });

    // check if user assigned
    const assigned = await query(
      `SELECT * FROM dbo.lecture_assignments WHERE lecture_id=@p0 AND user_id=@p1`,
      [lecture_id, req.user.id]
    );
    if (!assigned.recordset.length && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned to this lecture" });
    }

    // get lecture info
    const lec = await query(`SELECT * FROM dbo.lectures WHERE id=@p0`, [
      lecture_id,
    ]);
    if (!lec.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });
    }
    const L = lec.recordset[0];

    // generate 16 planned weeks
    const weeks = generateWeeks(L.start_date);
    const today = new Date().toISOString().slice(0, 10);

    // fetch sessions for this lecture
    const sessions = await query(
      `SELECT * FROM dbo.lecture_sessions WHERE lecture_id=@p0`,
      [lecture_id]
    );

    // fetch attendance for this student
    const att = await query(
      `SELECT * FROM dbo.attendance_records WHERE user_id=@p0 AND session_id IN
        (SELECT id FROM dbo.lecture_sessions WHERE lecture_id=@p1)`,
      [req.user.id, lecture_id]
    );

    const weekReports = [];
    const summary = { attend: 0, absence: 0, cancelled: 0, upcoming: 0 };

    for (let w of weeks) {
      const session = sessions.recordset.find(
        (s) => s.planned_date.toISOString().slice(0, 10) === w.planned_date
      );
      let status = "upcoming";
      let check_in_time = null;
      let check_out_time = null;

      if (w.planned_date > today) {
        status = "upcoming";
      } else if (!session) {
        status = "cancelled";
      } else {
        const recs = att.recordset.filter((r) => r.session_id === session.id);
        if (recs.length && recs[0].check_in_at) {
          status = "attend";
          check_in_time = new Date(
            Math.min(...recs.map((r) => new Date(r.check_in_at)))
          )
            .toISOString()
            .slice(11, 19);
          if (recs.some((r) => r.check_out_at)) {
            check_out_time = new Date(
              Math.max(
                ...recs.map((r) =>
                  r.check_out_at ? new Date(r.check_out_at) : 0
                )
              )
            )
              .toISOString()
              .slice(11, 19);
          }
        } else {
          status = "absence";
        }
      }

      summary[status] += 1;
      weekReports.push({
        week: w.week,
        planned_date: w.planned_date,
        status,
        check_in_time,
        check_out_time,
      });
    }

    return res.json({
      status: true,
      lecture_id,
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
 * Body: { lecture_id }
 */
router.get("/teacher", auth, async (req, res) => {
  try {
    const { lecture_id } = req.body;
    if (!lecture_id)
      return res
        .status(400)
        .json({ status: false, error: "lecture_id required" });

    // check if user assigned as teacher
    const assigned = await query(
      `SELECT * FROM dbo.lecture_assignments WHERE lecture_id=@p0 AND user_id=@p1 AND role='teacher'`,
      [lecture_id, req.user.id]
    );
    if (!assigned.recordset.length && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned as teacher" });
    }

    // get lecture info
    const lec = await query(`SELECT * FROM dbo.lectures WHERE id=@p0`, [
      lecture_id,
    ]);
    if (!lec.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });
    }
    const L = lec.recordset[0];

    // generate 16 planned weeks
    const weeks = generateWeeks(L.start_date);
    const today = new Date().toISOString().slice(0, 10);

    // fetch sessions
    const sessions = await query(
      `SELECT * FROM dbo.lecture_sessions WHERE lecture_id=@p0`,
      [lecture_id]
    );

    const weekReports = [];
    const summary = { ended: 0, started: 0, cancelled: 0, upcoming: 0 };

    for (let w of weeks) {
      const session = sessions.recordset.find(
        (s) => s.planned_date.toISOString().slice(0, 10) === w.planned_date
      );
      let status = "upcoming";
      let start_time = null;
      let end_time = null;

      if (w.planned_date > today) {
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
        }
      }

      summary[status] += 1;
      weekReports.push({
        week: w.week,
        planned_date: w.planned_date,
        status,
        start_time,
        end_time,
      });
    }

    return res.json({
      status: true,
      lecture_id,
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
