// index.js
const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { query } = require("./DB/dbConnection");
const cors = require("cors");
require("dotenv").config();

const app = express();

const raw = (process.env.CORS_ORIGINS || "").trim();
const allowAll = raw === "*" || raw === "";
const allowlist = allowAll
  ? []
  : raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

const useCreds = ["1", "true", "yes"].includes(
  String(process.env.CORS_CREDENTIALS || "").toLowerCase()
);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowAll) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Disposition"],
  credentials: useCreds,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

//app.options("(.*)", cors(corsOptions));

// --- SSL (PFX) options ---

// const sslOptions = {
//   pfx: fs.readFileSync("C:\\NEWSSLTRIAL\\196.204.136.246.pfx"),
//   passphrase: "1234",
// };

// HTTPS server (use the cert)
// const server = https.createServer(sslOptions, app);
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowAll ? "*" : allowlist,
    methods: ["GET", "POST"],
    credentials: useCreds,
  },
});

app.use(express.json());
app.set("io", io);

// health
app.get("/", (req, res) => res.json({ ok: true }));

/* ============== ROUTES ============== */
// offering details (GET /offering-details?offering_id=...)
app.use("/", require("./routes/offeringDetails.js"));

// auth
app.use("/auth", require("./routes/auth.js"));

// NEW offering-based routes
app.use("/offerings", require("./routes/offerings.js"));
app.use("/offering-assignments", require("./routes/offeringAssignments.js"));
app.use("/sessions", require("./routes/sessions.js"));

app.use("/lectures", require("./routes/offerings.js"));
app.use("/lecture-assignments", require("./routes/offeringAssignments.js"));
app.use("/lecture-sessions", require("./routes/getLectureSessions.js"));
// Face recognition, attendance, reports, weekly summary
app.use("/fr", require("./routes/face.js"));
app.use("/attendance", require("./routes/attendance.js"));
app.use("/reports", require("./routes/reports.js"));
app.use("/weekly-reports", require("./routes/summary.js"));
app.use("/files", require("./routes/files.js"));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use("/admin", require("./routes/adminOps.js"));

// Admin dashboard
app.use("/dashboard", require("./dashboard_routes/index.js"));

// 404
app.use((req, res) =>
  res.status(404).json({ status: false, error: "Not found", path: req.path })
);
app.use((err, req, res, next) => {
  if (err && err.message === "Unsupported file type") {
    return res.status(400).json({ status: false, error: err.message });
  }
  next(err);
});
/* ============== SOCKET.IO ============== */
// Socket.IO auth
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("no token"));
    const user = jwt.verify(token, process.env.JWT_SECRET || "supersecret");
    socket.user = { id: user.id, role: user.role };
    socket.join(`user:${user.id}`);
    next();
  } catch (err) {
    next(new Error("bad token"));
  }
});

// helper: join offering rooms with permission check
async function joinOfferingRooms(socket, offeringId) {
  const uid = socket.user.id;
  const role = (socket.user.role || "").toLowerCase();

  // admin can always join; otherwise must be assigned
  if (role !== "admin") {
    const r = await query(
      `SELECT role FROM dbo.offering_assignments WHERE offering_id=@p0 AND user_id=@p1`,
      [offeringId, uid]
    );
    if (!r.recordset.length) {
      socket.emit("join-denied", {
        offering_id: offeringId,
        reason: "not assigned",
      });
      return;
    }
    const assignedRole = (r.recordset[0].role || "").toLowerCase();
    if (assignedRole === "student") socket.join(`off:${offeringId}:students`);
    if (assignedRole === "teacher") socket.join(`off:${offeringId}:teachers`);
  } else {
    // admin joins both teacher & student rooms logically
    socket.join(`off:${offeringId}:teachers`);
    socket.join(`off:${offeringId}:students`);
  }

  socket.join(`off:${offeringId}:all`);
  socket.emit("join-ok", { offering_id: offeringId, role });
}

function leaveOfferingRooms(socket, offeringId) {
  socket.leave(`off:${offeringId}:students`);
  socket.leave(`off:${offeringId}:teachers`);
  socket.leave(`off:${offeringId}:all`);
}

io.on("connection", (socket) => {
  console.log("🔌 [SOCKET] Client connected:", socket.id, "user:", socket.user);

  /* =========================================================
     1) JOIN OFFERING (preferred for new clients)
     ========================================================= */
  socket.on("join-offering", async (offeringId) => {
    try {
      console.log(
        "➡️ [SOCKET] join-offering request → user:",
        socket.user?.id,
        "offeringId:",
        offeringId
      );

      await joinOfferingRooms(socket, offeringId);

      console.log(
        "✅ [SOCKET] join-offering success → user:",
        socket.user?.id,
        "offeringId:",
        offeringId
      );
    } catch (e) {
      console.error("❌ [SOCKET] join-offering error:", e);
      socket.emit("join-denied", {
        offering_id: offeringId,
        reason: "server error",
      });
    }
  });

  /* =========================================================
     2) LEAVE OFFERING
     ========================================================= */
  socket.on("leave-offering", (offeringId) => {
    console.log(
      "↩️ [SOCKET] leave-offering → user:",
      socket.user?.id,
      "offeringId:",
      offeringId
    );
    leaveOfferingRooms(socket, offeringId);
  });

  /* =========================================================
     3) JOIN LECTURE (legacy compatibility)
        - tries to map lecture → offering via map_lecture_offering
        - if not found, treats lectureId as offeringId directly
     ========================================================= */
  socket.on("join-lecture", async (lectureId) => {
    try {
      console.log(
        "➡️ [SOCKET] join-lecture request → user:",
        socket.user?.id,
        "lectureId:",
        lectureId
      );

      const m = await query(
        `SELECT offering_id FROM dbo.map_lecture_offering WHERE lecture_id=@p0`,
        [lectureId]
      );

      let offeringId = m.recordset[0]?.offering_id || null;

      if (!offeringId) {
        // fallback: maybe client sent offering_id directly
        offeringId = Number(lectureId);
        console.log(
          "⚠️ [SOCKET] join-lecture fallback → no map found, using lectureId as offeringId:",
          offeringId
        );
      } else {
        socket.emit("mapped-offering", {
          lecture_id: lectureId,
          offering_id: offeringId,
        });
        console.log(
          "✅ [SOCKET] join-lecture mapped → lectureId:",
          lectureId,
          "→ offeringId:",
          offeringId
        );
      }

      await joinOfferingRooms(socket, offeringId);

      console.log(
        "✅ [SOCKET] join-lecture success → user:",
        socket.user?.id,
        "offeringId:",
        offeringId
      );
    } catch (e) {
      console.error("❌ [SOCKET] join-lecture error:", e);
      socket.emit("join-denied", {
        lecture_id: lectureId,
        reason: "server error",
      });
    }
  });

  /* =========================================================
     4) LEAVE LECTURE (legacy)
     ========================================================= */
  socket.on("leave-lecture", async (lectureId) => {
    try {
      console.log(
        "↩️ [SOCKET] leave-lecture → user:",
        socket.user?.id,
        "lectureId:",
        lectureId
      );

      const m = await query(
        `SELECT offering_id FROM dbo.map_lecture_offering WHERE lecture_id=@p0`,
        [lectureId]
      );

      const offeringId = m.recordset[0]?.offering_id || Number(lectureId);

      leaveOfferingRooms(socket, offeringId);

      console.log(
        "✅ [SOCKET] leave-lecture success → user:",
        socket.user?.id,
        "offeringId:",
        offeringId
      );
    } catch (e) {
      console.error("❌ [SOCKET] leave-lecture error:", e);
    }
  });

  /* =========================================================
     5) PING TEST (for debug)
     ========================================================= */
  socket.on("ping-test", (data) => {
    console.log("📡 [SOCKET] ping-test from:", socket.user?.id, "data:", data);
    socket.emit("pong-test", {
      echo: data || true,
      time: new Date().toISOString(),
    });
  });

  /* =========================================================
     6) DISCONNECT
     ========================================================= */
  socket.on("disconnect", (reason) => {
    console.log("🔴 [SOCKET] Disconnected:", socket.id, "reason:", reason);
  });
});

app.get("/ok", (req, res) => {
  res.type("text/plain").send("OK");
});

// (optional) also respond to HEAD checks
app.head("/ok", (req, res) => {
  res.type("text/plain").end();
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`HTTPS + Socket.IO With Sec on https://localhost:${PORT}`)
);

// const REDIRECT_PORT = 80;
// http
//   .createServer((req, res) => {
//     const host = req.headers.host?.replace(/:\d+$/, "") || "localhost";
//     res.writeHead(301, { Location: `https://${host}${req.url}` });
//     res.end();
//   })
//   .listen(REDIRECT_PORT, () =>
//     console.log(`HTTP -> HTTPS redirect on :${REDIRECT_PORT}`)
//   );
