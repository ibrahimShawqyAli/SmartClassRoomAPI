// dbConnection.js
const sql = require("mssql");
require("dotenv").config();

const config = {
  server: process.env.SQL_SERVER, // e.g., "localhost"
  database: process.env.SQL_DB, // "collegeDB"
  user: process.env.SQL_USER, // "college_user"
  password: process.env.SQL_PASSWORD, // "Mypass_VisionValley_2025"
  port: 1433, // <-- TOP LEVEL (not in options)
  options: {
    encrypt: process.env.SQL_ENCRYPT === "true", // usually true
    trustServerCertificate: process.env.SQL_TRUST_CERT === "true", // often true for local dev
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

const pool = new sql.ConnectionPool(config);
let poolPromise;

function getPool() {
  if (!poolPromise) {
    poolPromise = pool.connect().catch((err) => {
      console.error("SQL pool connect error:", err);
      // rethrow so callers see the failure
      throw err;
    });
    // log once connected
    pool.on("connect", () => {
      console.log("SQL connected:", {
        server: config.server,
        db: config.database,
        encrypt: config.options.encrypt,
        trustServerCertificate: config.options.trustServerCertificate,
        port: config.port,
      });
    });
    pool.on("error", (err) => {
      console.error("SQL pool runtime error:", err);
    });
  }
  return poolPromise;
}

async function query(q, params = []) {
  const p = await getPool();
  const request = p.request();
  params.forEach((v, i) => request.input(`p${i}`, v));
  return request.query(q);
}

function addInputs(request, params = {}, types = {}) {
  for (const [name, value] of Object.entries(params)) {
    const t = types[name];
    if (t) request.input(name, t, value);
    else request.input(name, value);
  }
  return request;
}

async function execProc(procName, params = {}, types = {}) {
  const p = await getPool();
  const request = addInputs(p.request(), params, types);
  return request.execute(procName);
}

const TYPES = {
  Int: sql.Int,
  TinyInt: sql.TinyInt,
  VarChar: sql.VarChar,
  NVarChar: sql.NVarChar,
  Date: sql.Date,
  DateTime2: sql.DateTime2,
  Time: sql.Time,
  Bit: sql.Bit,
};

async function close() {
  if (poolPromise) {
    const p = await poolPromise;
    await p.close();
    poolPromise = null;
  }
}

module.exports = { sql, TYPES, getPool, query, execProc, close };
