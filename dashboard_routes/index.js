const express = require("express");
const router = express.Router();
// const requireRole = require("../middleware/requireRole");
const auth = require("../middleware/auth");
const timetableRoutes = require("./dashboard_routes/timetable");
// Protect all dashboard routes
// router.use(requireRole("admin"));

// Import sub-routes

router.use("/summary", require("./summary"));
router.use("/users", require("./users"));
router.use("/departments", require("./departments"));
router.use("/offerings", require("./offerings"));
router.use("/attendance", require("./attendance"));
router.use("/sessions", require("./sessions"));
router.use("/rooms", require("./rooms"));
router.use("/courses", require("./courses"));
router.use("/sections", require("./sections"));
router.use("/assignments", require("./assignments"));
router.use("/offering", require("./offering_Summary"));
router.use("/scheduler", require("./scheduler"));
app.use("/dashboard/timetable", timetableRoutes);
module.exports = router;
